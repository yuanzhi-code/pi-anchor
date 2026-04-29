/**
 * File I/O and state management for pi-anchor.
 *
 * Handles loading, saving, and sanitizing task state from disk.
 * Uses atomic writes (temp file + rename) for crash safety.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type Task, type TaskState, type Runtime, DEFAULT_MAX_AUTO_RESUME, TASK_DIR, TASK_SUBDIR } from "./types.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { t, tf } from "./i18n.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize session key for use as filename.
 * Uses a hash suffix when unsafe characters are present to prevent collisions
 * between distinct session IDs (e.g. "a/b" vs "a?b").
 */
export function safeSessionKey(sessionKey: string): string {
  const sanitized = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized === sessionKey) return sanitized;
  // Add hash suffix to prevent collisions between different session IDs
  let hash = 0;
  for (let i = 0; i < sessionKey.length; i++) {
    const char = sessionKey.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `${sanitized}_${Math.abs(hash).toString(36)}`;
}

export function taskFilePath(cwd: string, sessionKey: string): string {
  return path.join(cwd, TASK_DIR, TASK_SUBDIR, `${safeSessionKey(sessionKey)}.json`);
}

export function ensureTaskDir(cwd: string): void {
  const dir = path.join(cwd, TASK_DIR, TASK_SUBDIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function generateGoalId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sanitizeTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;

  const { id, text, done, createdAt, goalId } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof text !== "string") return null;
  if (typeof done !== "boolean") return null;

  return {
    id,
    text,
    done,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now(),
    goalId: typeof goalId === "string" ? goalId : undefined,
  };
}

export function defaultTaskState(): TaskState {
  return { tasks: [], nextId: 1, autoResume: true, maxAutoResume: DEFAULT_MAX_AUTO_RESUME, showWidget: false };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export interface LoadResult {
  state: TaskState;
  /** true if file existed but could not be parsed/read */
  fileCorrupted: boolean;
}

export function loadState(cwd: string, sessionKey: string): LoadResult {
  const file = taskFilePath(cwd, sessionKey);
  try {
    if (fs.existsSync(file)) {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (isRecord(data) && Array.isArray(data.tasks)) {
        const tasks = data.tasks.map(sanitizeTask).filter((t): t is Task => t !== null);
        // Deduplicate tasks by ID, keeping the first occurrence
        const seen = new Set<number>();
        const deduped = tasks.filter((task) => {
          if (seen.has(task.id)) return false;
          seen.add(task.id);
          return true;
        });
        const maxTaskId = deduped.reduce((max, task) => Math.max(max, task.id), 0);
        const storedNextId = data.nextId;
        const storedMaxAutoResume = data.maxAutoResume;
        const nextId = typeof storedNextId === "number" && Number.isSafeInteger(storedNextId) && storedNextId > maxTaskId
          ? storedNextId
          : maxTaskId + 1;
        const maxAutoResume = typeof storedMaxAutoResume === "number" && Number.isSafeInteger(storedMaxAutoResume) && storedMaxAutoResume >= 0
          ? storedMaxAutoResume
          : DEFAULT_MAX_AUTO_RESUME;

        return {
          state: {
            tasks: deduped,
            nextId,
            autoResume: typeof data.autoResume === "boolean" ? data.autoResume : true,
            maxAutoResume,
            currentGoal: typeof data.currentGoal === "string" && data.currentGoal ? data.currentGoal : undefined,
            goalId: typeof data.goalId === "string" && data.goalId ? data.goalId : undefined,
            showWidget: typeof data.showWidget === "boolean" ? data.showWidget : false,
          },
          fileCorrupted: false,
        };
      }
      // File exists but has invalid structure
      return { state: defaultTaskState(), fileCorrupted: true };
    }
    // File doesn't exist - normal for new sessions
    return { state: defaultTaskState(), fileCorrupted: false };
  } catch {
    // File exists but is corrupted
    return { state: defaultTaskState(), fileCorrupted: true };
  }
}

/**
 * Save state atomically using a unique temp file to prevent conflicts
 * with concurrent writers.
 */
export function saveState(cwd: string, sessionKey: string, state: TaskState): boolean {
  try {
    ensureTaskDir(cwd);
    const file = taskFilePath(cwd, sessionKey);
    // Use unique temp file to prevent concurrent writer conflicts
    const tmpFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, file);
    return true;
  } catch (e) {
    console.error("[anchor] failed to save state:", e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Higher-level helpers
// ---------------------------------------------------------------------------

export function buildResumeMessage(state: TaskState): string {
  const undone = state.tasks.filter((t) => !t.done);
  if (undone.length === 0) return "";

  const parts: string[] = [];

  // Show user's original goal
  if (state.currentGoal) {
    parts.push(`🎯 ${t("userGoal")}: ${state.currentGoal}`);
    parts.push("");
    parts.push(`📋 ${t("decomposedTasks")} (${undone.length}/${state.tasks.length} ${t("pendingLabel")}):`);
  } else {
    parts.push(`📋 ${t("remainingTasks")} (${undone.length}/${state.tasks.length}):`);
  }

  parts.push(...undone.map((t) => `- [ ] #${t.id}: ${t.text}`));
  parts.push("");
  parts.push(tf("pendingCount", String(undone.length)));

  return parts.join("\n");
}

export function hasUndoneTasks(state: TaskState): boolean {
  return state.tasks.some((t) => !t.done);
}

export function createRuntime(): Runtime {
  return {
    state: defaultTaskState(),
    autoResumeCount: 0,
    pendingTimer: null,
  };
}

/**
 * Execute a state mutation with automatic rollback on save failure.
 * Takes a snapshot before mutation and restores it if the save fails.
 */
export function withStateRollback(
  runtime: Runtime,
  ctx: ExtensionContext,
  saveRuntime: (ctx: ExtensionContext, runtime: Runtime) => boolean,
  mutation: () => void,
): boolean {
  const snapshot: TaskState = JSON.parse(JSON.stringify(runtime.state));
  mutation();
  if (!saveRuntime(ctx, runtime)) {
    runtime.state = snapshot;
    return false;
  }
  return true;
}

/**
 * Trim and validate task/goal text.
 * Returns the trimmed text, or null if the text is empty/blank.
 */
export function sanitizeText(text: string | undefined, maxLength: number): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return trimmed.slice(0, maxLength);
  return trimmed;
}

/**
 * Cancel any pending auto-resume timer.
 */
export function cancelPending(runtime: Runtime): void {
  if (runtime.pendingTimer) {
    clearTimeout(runtime.pendingTimer);
    runtime.pendingTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Runtime store (per session)
// ---------------------------------------------------------------------------

export function createRuntimeStore() {
  const store = new Map<string, Runtime>();

  return {
    ensure(sessionKey: string): Runtime {
      let rt = store.get(sessionKey);
      if (!rt) {
        rt = createRuntime();
        store.set(sessionKey, rt);
      }
      return rt;
    },
    clear(sessionKey: string): void {
      store.delete(sessionKey);
    },
  };
}
