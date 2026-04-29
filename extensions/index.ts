/**
 * 锚（pi-anchor）
 *
 * 锚定任务，不走偏、不遗漏、持续推进至完成。
 *
 * Core behavior:
 * - User sets goals via `/anchor <goal>`
 * - AI decomposes goals into concrete tasks using the `task` tool
 * - State is persisted to `{cwd}/.pi/tasks/<session-id>.json`
 * - Auto-retry shows remaining tasks when agent is idle
 * - Dynamic command completions for /anchor
 * - Widget is hidden by default, only shown after `/anchor` is invoked
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { t, tf } from "./i18n.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Task {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
  /** Which goal this task belongs to */
  goalId?: string;
}

interface TaskState {
  tasks: Task[];
  nextId: number;
  autoResume: boolean;
  maxAutoResume: number;
  /** User's current goal */
  currentGoal?: string;
  /** Unique goal identifier for grouping tasks */
  goalId?: string;
  /** Whether to show the widget in TUI */
  showWidget?: boolean;
}

interface TaskDetails {
  action: "list" | "add" | "toggle" | "delete" | "clear";
  tasks: Task[];
  nextId: number;
  currentGoal?: string;
  error?: string;
}

interface TaskToolParams {
  action: "list" | "add" | "toggle" | "delete" | "clear";
  text?: string;
  id?: number;
}

interface Runtime {
  state: TaskState;
  autoResumeCount: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AUTO_RESUME = 20;
const RESUME_DELAY_MS = 800;
const TASK_DIR = ".pi";
const TASK_SUBDIR = "tasks";
const MAX_TASK_TEXT_LENGTH = 10000;
const MAX_GOAL_TEXT_LENGTH = 5000;

/** Command completions for /anchor */
const ANCHOR_COMMANDS: AutocompleteItem[] = [
  { value: "help", description: t("cmdHelpDesc") },
  { value: "auto on", description: t("cmdAutoOnDesc") },
  { value: "auto off", description: t("cmdAutoOffDesc") },
  { value: "auto retry on", description: t("cmdAutoRetryOnDesc") },
  { value: "auto retry off", description: t("cmdAutoRetryOffDesc") },
  { value: "limit", description: t("cmdLimitDesc") },
  { value: "list", description: t("cmdListDesc") },
  { value: "clear", description: t("cmdClearDesc") },
];

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Sanitize session key for use as filename.
 * Uses a hash suffix when unsafe characters are present to prevent collisions
 * between distinct session IDs (e.g. "a/b" vs "a?b").
 */
function safeSessionKey(sessionKey: string): string {
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

function taskFilePath(cwd: string, sessionKey: string): string {
  return path.join(cwd, TASK_DIR, TASK_SUBDIR, `${safeSessionKey(sessionKey)}.json`);
}

function ensureTaskDir(cwd: string): void {
  const dir = path.join(cwd, TASK_DIR, TASK_SUBDIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateGoalId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeTask(value: unknown): Task | null {
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

function defaultTaskState(): TaskState {
  return { tasks: [], nextId: 1, autoResume: true, maxAutoResume: DEFAULT_MAX_AUTO_RESUME, showWidget: false };
}

interface LoadResult {
  state: TaskState;
  /** true if file existed but could not be parsed/read */
  fileCorrupted: boolean;
}

function loadState(cwd: string, sessionKey: string): LoadResult {
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
function saveState(cwd: string, sessionKey: string, state: TaskState): boolean {
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
// Helpers
// ---------------------------------------------------------------------------

function buildResumeMessage(state: TaskState): string {
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

function hasUndoneTasks(state: TaskState): boolean {
  return state.tasks.some((t) => !t.done);
}

function createRuntime(): Runtime {
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
function withStateRollback(
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
function sanitizeText(text: string | undefined, maxLength: number): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return trimmed.slice(0, maxLength);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Runtime store (per session)
// ---------------------------------------------------------------------------

function createRuntimeStore() {
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

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function taskPersistenceExtension(pi: ExtensionAPI): void {
  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): Runtime => runtimeStore.ensure(getSessionKey(ctx));

  const refreshRuntime = (ctx: ExtensionContext): Runtime => {
    const runtime = getRuntime(ctx);
    const { state } = loadState(ctx.cwd, getSessionKey(ctx));
    runtime.state = state;
    return runtime;
  };

  const saveRuntime = (ctx: ExtensionContext, runtime: Runtime): boolean => {
    return saveState(ctx.cwd, getSessionKey(ctx), runtime.state);
  };

  const updateTodoWidget = (ctx: ExtensionContext, runtime: Runtime): void => {
    const { state } = runtime;

    // Hide widget by default - only show when user explicitly invoked /anchor
    if (!state.showWidget) {
      ctx.ui.setWidget("pi-anchor", undefined);
      return;
    }
    const theme = ctx.ui.theme;
    const todo = state.tasks.filter((t) => !t.done);
    const done = state.tasks.filter((t) => t.done);
    const activeTask = todo[0];
    const autoText = state.autoResume
      ? theme.fg("success", t("autoRetryOnWidget"))
      : theme.fg("warning", t("autoRetryOffWidget"));
    const retryText = runtime.autoResumeCount > 0
      ? theme.fg("warning", tf("retryCount", String(runtime.autoResumeCount), String(state.maxAutoResume)))
      : theme.fg("dim", tf("retryCount", "0", String(state.maxAutoResume)));
    const statusText = todo.length === 0
      ? theme.fg("success", tf("statusDone", String(done.length), String(state.tasks.length)))
      : theme.fg("warning", tf("statusPending", String(done.length), String(state.tasks.length)));
    
    const header = [
      theme.fg("accent", t("anchorTasksHeader")),
      statusText,
      autoText,
      retryText,
    ].join(" · ");

    const helpHint = theme.fg("dim", "  💡 ") + theme.fg("accent", t("setGoalHint")) + theme.fg("dim", t("setGoalPipe")) + theme.fg("accent", "/anchor help");

    // Show current goal if exists
    const goalLine = state.currentGoal
      ? [theme.fg("accent", "  🎯 ") + theme.fg("text", state.currentGoal)]
      : [];

    if (state.tasks.length === 0) {
      ctx.ui.setWidget("pi-anchor", [header, ...goalLine, theme.fg("dim", t("noTasksWidget")), "", helpHint]);
      return;
    }

    const visible = [...todo, ...done].slice(0, 10);
    const lines = visible.map((t) => {
      if (t.done) return theme.fg("success", `  ✓ #${t.id} ${t.text}`);
      if (activeTask?.id === t.id) return theme.fg("warning", `  ▶ #${t.id} ${t.text}`);
      return theme.fg("text", `  □ #${t.id} ${t.text}`);
    });
    const extra = state.tasks.length > visible.length
      ? [theme.fg("dim", tf("moreTasks", String(state.tasks.length - visible.length)))]
      : [];
    ctx.ui.setWidget("pi-anchor", [header, ...goalLine, ...lines, ...extra, "", helpHint]);
  };

  // Cancel any pending auto-resume
  const cancelPending = (runtime: Runtime): void => {
    if (runtime.pendingTimer) {
      clearTimeout(runtime.pendingTimer);
      runtime.pendingTimer = null;
    }
  };

  // Schedule an auto-resume message
  const scheduleResume = (ctx: ExtensionContext, runtime: Runtime): void => {
    cancelPending(runtime);
    runtime.pendingTimer = setTimeout(() => {
      runtime.pendingTimer = null;

      // Reload state from disk to avoid stale data
      refreshRuntime(ctx);

      // Double-check the current state before injecting a follow-up.
      if (!runtime.state.autoResume) return;
      if (!hasUndoneTasks(runtime.state)) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

      if (runtime.autoResumeCount >= runtime.state.maxAutoResume) {
        ctx.ui.notify(tf("retryLimitReached", String(runtime.state.maxAutoResume)), "info");
        return;
      }

      const message = buildResumeMessage(runtime.state);
      if (!message) return;

      runtime.autoResumeCount++;
      updateTodoWidget(ctx, runtime);
      pi.sendUserMessage(message);
    }, RESUME_DELAY_MS);
  };

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    const { state, fileCorrupted } = loadState(ctx.cwd, getSessionKey(ctx));
    runtime.state = state;
    runtime.autoResumeCount = 0;
    cancelPending(runtime);
    runtime.state.showWidget = false;
    // Only save if the file was valid or doesn't exist
    // Don't overwrite a corrupted file with empty state
    if (!fileCorrupted) {
      saveRuntime(ctx, runtime);
    }
    updateTodoWidget(ctx, runtime);
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    cancelPending(runtime);
    saveRuntime(ctx, runtime);
    ctx.ui.setWidget("pi-anchor", undefined);
    runtimeStore.clear(getSessionKey(ctx));
  });

  // Save before switching/forking sessions
  pi.on("session_before_switch", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    cancelPending(runtime);
    saveRuntime(ctx, runtime);
  });

  pi.on("session_before_fork", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    cancelPending(runtime);
    saveRuntime(ctx, runtime);
  });

  // -----------------------------------------------------------------------
  // Auto-resume triggers
  // -----------------------------------------------------------------------

  pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = refreshRuntime(ctx);
    updateTodoWidget(ctx, runtime);
    cancelPending(runtime);

    if (!runtime.state.autoResume) return;
    if (!hasUndoneTasks(runtime.state)) return;
    if (runtime.autoResumeCount >= runtime.state.maxAutoResume) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    scheduleResume(ctx, runtime);
  });

  pi.on("session_compact", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = refreshRuntime(ctx);
    updateTodoWidget(ctx, runtime);
    cancelPending(runtime);

    if (!runtime.state.autoResume) return;
    if (!hasUndoneTasks(runtime.state)) return;
    if (runtime.autoResumeCount >= runtime.state.maxAutoResume) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    scheduleResume(ctx, runtime);
  });

  // Reset auto-resume counter when user sends a manual message
  pi.on("input", async (event: { source?: string }, ctx: ExtensionContext) => {
    if (event.source === "interactive") {
      const runtime = getRuntime(ctx);
      runtime.autoResumeCount = 0;
      cancelPending(runtime);
    }
    return { action: "continue" };
  });

  // Cancel pending when a new turn starts
  pi.on("agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    cancelPending(runtime);
  });

  // -----------------------------------------------------------------------
  // Task tool (for AI)
  // -----------------------------------------------------------------------

  const TaskParams = Type.Object({
    action: StringEnum(["list", "add", "toggle", "delete", "clear"] as const),
    text: Type.Optional(Type.String({ description: "Task text (for add)" })),
    id: Type.Optional(Type.Number({ description: "Task ID (for toggle/delete)" })),
  });

  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Manage a persistent task list. Actions: list, add (text), toggle (id), delete (id), clear",
    promptSnippet: "Manage task list (list, add, toggle, delete, clear) — persists to filesystem",
    promptGuidelines: [
      "Use the task tool to track multi-step tasks. Add tasks when the user gives you work that spans multiple actions.",
      "Toggle tasks done as you complete each step. The list persists across sessions in the same working directory.",
      "Check the task list before finishing a response to ensure nothing was missed.",
      "When the user sets a goal, decompose it into concrete sub-tasks and add them one by one.",
      "Each task should be specific, actionable, and completable in a single step.",
    ],
    parameters: TaskParams,

    async execute(_toolCallId: string, params: TaskToolParams, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      const runtime = refreshRuntime(ctx);
      const { state } = runtime;

      switch (params.action) {
        case "list": {
          const undone = state.tasks.filter((t) => !t.done).length;
          const parts: string[] = [];
          
          if (state.currentGoal) {
            parts.push(`🎯 Goal: ${state.currentGoal}`);
            parts.push("");
          }
          
          if (state.tasks.length > 0) {
            parts.push(t("tasksLabel"));
            parts.push(...state.tasks.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`));
          } else {
            parts.push(t("noTasksYet"));
          }
          
          parts.push("");
          parts.push(`(${undone}/${state.tasks.length} ${t("pendingLabel")})`);

          return {
            content: [{ type: "text", text: parts.join("\n") }],
            details: {
              action: "list",
              tasks: [...state.tasks],
              nextId: state.nextId,
              currentGoal: state.currentGoal,
            } as TaskDetails,
          };
        }

        case "add": {
          const cleanText = sanitizeText(params.text, MAX_TASK_TEXT_LENGTH);
          if (!cleanText) {
            return {
              content: [{ type: "text", text: t("errAddTextRequired") }],
              details: {
                action: "add",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "text required",
              } as TaskDetails,
            };
          }
          const task: Task = {
            id: state.nextId,
            text: cleanText,
            done: false,
            createdAt: Date.now(),
            goalId: state.goalId,
          };
          const saved = withStateRollback(runtime, ctx, saveRuntime, () => {
            state.tasks.push(task);
            state.nextId++;
          });
          if (!saved) {
            return {
              content: [{ type: "text", text: t("errSaveTaskState") }],
              details: {
                action: "add",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "save failed",
              } as TaskDetails,
            };
          }
          updateTodoWidget(ctx, runtime);
          return {
            content: [
              { type: "text", text: tf("addedTask", String(task.id), task.text) },
            ],
            details: {
              action: "add",
              tasks: [...state.tasks],
              nextId: state.nextId,
            } as TaskDetails,
          };
        }

        case "toggle": {
          if (params.id === undefined) {
            return {
              content: [
                { type: "text", text: t("errToggleIdRequired") },
              ],
              details: {
                action: "toggle",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "id required",
              } as TaskDetails,
            };
          }
          const task = state.tasks.find((t) => t.id === params.id);
          if (!task) {
            return {
              content: [
                {
                  type: "text",
                  text: tf("errTaskNotFound", String(params.id)),
                },
              ],
              details: {
                action: "toggle",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: `#${params.id} not found`,
              } as TaskDetails,
            };
          }
          const wasDone = task.done;
          const saved = withStateRollback(runtime, ctx, saveRuntime, () => {
            task.done = !task.done;
          });
          if (!saved) {
            return {
              content: [{ type: "text", text: t("errSaveTaskState") }],
              details: {
                action: "toggle",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "save failed",
              } as TaskDetails,
            };
          }
          updateTodoWidget(ctx, runtime);
          return {
            content: [
              {
                type: "text",
                text: wasDone ? tf("taskReopened", String(task.id)) : tf("taskCompleted", String(task.id)),
              },
            ],
            details: {
              action: "toggle",
              tasks: [...state.tasks],
              nextId: state.nextId,
            } as TaskDetails,
          };
        }

        case "delete": {
          if (params.id === undefined) {
            return {
              content: [
                { type: "text", text: t("errDeleteIdRequired") },
              ],
              details: {
                action: "delete",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "id required",
              } as TaskDetails,
            };
          }
          const index = state.tasks.findIndex((t) => t.id === params.id);
          if (index === -1) {
            return {
              content: [
                {
                  type: "text",
                  text: tf("errTaskNotFound", String(params.id)),
                },
              ],
              details: {
                action: "delete",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: `#${params.id} not found`,
              } as TaskDetails,
            };
          }
          const removed = state.tasks[index];
          const saved = withStateRollback(runtime, ctx, saveRuntime, () => {
            state.tasks.splice(index, 1);
          });
          if (!saved) {
            return {
              content: [{ type: "text", text: t("errSaveTaskState") }],
              details: {
                action: "delete",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "save failed",
              } as TaskDetails,
            };
          }
          updateTodoWidget(ctx, runtime);
          return {
            content: [
              { type: "text", text: tf("deletedTask", String(removed.id), removed.text) },
            ],
            details: {
              action: "delete",
              tasks: [...state.tasks],
              nextId: state.nextId,
            } as TaskDetails,
          };
        }

        case "clear": {
          const count = state.tasks.length;
          const saved = withStateRollback(runtime, ctx, saveRuntime, () => {
            state.tasks = [];
            state.nextId = 1;
            state.currentGoal = undefined;
            state.goalId = undefined;
            state.showWidget = false;
          });
          if (!saved) {
            return {
              content: [{ type: "text", text: t("errSaveTaskState") }],
              details: {
                action: "clear",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "save failed",
              } as TaskDetails,
            };
          }
          runtime.autoResumeCount = 0;
          cancelPending(runtime);
          updateTodoWidget(ctx, runtime);
          return {
            content: [
              { type: "text", text: tf("clearedTasksTool", String(count)) },
            ],
            details: {
              action: "clear",
              tasks: [],
              nextId: 1,
              currentGoal: undefined,
            } as TaskDetails,
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: tf("unknownAction", String(params.action)),
              },
            ],
            details: {
              action: "list",
              tasks: [...state.tasks],
              nextId: state.nextId,
              error: `unknown action: ${params.action}`,
            } as TaskDetails,
          };
      }
    },
  });

  // -----------------------------------------------------------------------
  // /anchor command for users
  // -----------------------------------------------------------------------

  const parseCommandArgs = (args: unknown): string[] => {
    if (Array.isArray(args)) return args.map(String);
    if (typeof args === "string") return args.trim() ? args.trim().split(/\s+/) : [];
    return [];
  };

  const commandArgsToText = (args: unknown): string => {
    if (Array.isArray(args)) return args.map(String).join(" ").trim();
    if (typeof args === "string") return args.trim();
    return "";
  };

  const formatTaskList = (state: TaskState): string => {
    const todo = state.tasks.filter((t) => !t.done);
    const done = state.tasks.filter((t) => t.done);

    const statusText = todo.length === 0
      ? tf("formatStatusDone", String(done.length), String(state.tasks.length))
      : tf("formatStatusPending", String(todo.length), String(state.tasks.length));

    const autoText = state.autoResume ? t("formatAutoRetryOn") : t("formatAutoRetryOff");

    const header = [
      t("anchorTasksHeader"),
      statusText,
      autoText,
      tf("formatLimit", String(state.maxAutoResume)),
    ].join(" · ");

    const parts: string[] = [header];

    // Show current goal
    if (state.currentGoal) {
      parts.push("");
      parts.push(`  🎯 ${t("goalLabel")} ${state.currentGoal}`);
    }

    if (state.tasks.length === 0) {
      parts.push("");
      parts.push(t("noTasksYetFmt"));
      parts.push("");
      parts.push(t("usageLabel"));
      parts.push(t("cmdSetGoal"));
      parts.push(t("cmdShowStatus"));
      parts.push(t("cmdShowHelp"));
    } else {
      parts.push("");

      // Show pending tasks
      if (todo.length > 0) {
        parts.push(tf("pendingList", String(todo.length)));
        parts.push(...todo.map((t) => `    □ #${t.id} ${t.text}`));
      }

      // Show completed (limited)
      if (done.length > 0) {
        parts.push(tf("completedList", String(done.length)));
        parts.push(...done.slice(0, 3).map((t) => `    ✓ #${t.id} ${t.text}`));
        if (done.length > 3) {
          parts.push(tf("moreCompleted", String(done.length - 3)));
        }
      }

      parts.push("");
      parts.push(t("hintHelpGoal"));
    }

    return parts.join("\n");
  };

  pi.registerCommand("anchor", {
    description: "Show task status, set goal, or configure: /anchor [help|auto retry|limit|clear|<goal>]", 
    
    // Dynamic argument completions
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const prefix = argumentPrefix.trim().toLowerCase();
      
      // If no prefix, show all commands
      if (!prefix) {
        return ANCHOR_COMMANDS;
      }
      
      // Filter commands by prefix
      const filtered = ANCHOR_COMMANDS.filter(
        (item) => 
          item.value.toLowerCase().startsWith(prefix) ||
          (item.description && item.description.toLowerCase().includes(prefix))
      );
      
      // If prefix matches a command, return those
      if (filtered.length > 0) {
        return filtered;
      }
      
      // Otherwise, treat as a goal prompt (no completions, free text)
      return null;
    },

    handler: async (args: unknown, ctx: ExtensionContext) => {
      const runtime = refreshRuntime(ctx);
      const { state } = runtime;
      // Show widget when user explicitly invokes /anchor
      state.showWidget = true;
      if (!saveRuntime(ctx, runtime)) {
        ctx.ui.notify(t("errSaveState"), "error");
        return;
      }
      updateTodoWidget(ctx, runtime);
      const argv = parseCommandArgs(args);
      const op = (argv[0] ?? "").toLowerCase();

      // No args - show status
      if (!op) {
        ctx.ui.notify(formatTaskList(state), "info");
        return;
      }

      // Help (match with or without extra args)
      if (["help", "-h", "--help"].includes(op)) {
        const theme = ctx.ui.theme;
        ctx.ui.notify(
          [
            theme.fg("accent", t("anchorTaskCommands")),
            "",
            `  ${theme.fg("success", t("helpSetGoal"))}`,
            `  ${theme.fg("success", t("helpShowStatus"))}`,
            `  ${theme.fg("success", t("helpShowHelp"))}`,
            `  ${theme.fg("success", t("helpAutoToggle"))}`,
            `  ${theme.fg("success", t("helpLimit"))}`,
            `  ${theme.fg("success", t("helpClear"))}`,
            "",
            theme.fg("dim", t("workflowLabel")),
            theme.fg("dim", t("workflow1")),
            theme.fg("dim", t("workflow2")),
            theme.fg("dim", t("workflow3")),
            theme.fg("dim", t("workflow4")),
          ].join("\n"),
          "info"
        );
        return;
      }

      // Auto-retry toggle
      // Supports both "/anchor auto on|off" and "/anchor auto retry on|off"
      if (op === "auto") {
        let value = "";
        if ((argv[1] ?? "").toLowerCase() === "retry") {
          value = (argv[2] ?? "").toLowerCase();
        } else if (argv[1]) {
          value = argv[1].toLowerCase();
        }
        if (!["on", "off"].includes(value)) {
          ctx.ui.notify(tf("autoRetryStatus", state.autoResume ? t("on") : t("off")), "info");
          return;
        }
        state.autoResume = value === "on";
        runtime.autoResumeCount = 0;
        if (!state.autoResume) {
          cancelPending(runtime);
        }
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify(t("errSaveState"), "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        ctx.ui.notify(state.autoResume ? t("autoRetryOn") : t("autoRetryOff"), "info");
        return;
      }

      // Limit (require "limit <number>" format)
      if (op === "limit") {
        const limit = Number(argv[1]);
        if (!Number.isInteger(limit) || limit < 0) {
          ctx.ui.notify(t("limitUsage"), "error");
          return;
        }
        state.maxAutoResume = limit;
        runtime.autoResumeCount = 0;
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify(t("errSaveState"), "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        ctx.ui.notify(tf("limitSet", String(limit)), "info");
        return;
      }

      // Clear all - only match as command when it's the exact word "clear" with no extra args
      // This prevents "/anchor clear failing tests" from clearing tasks instead of setting a goal
      if (op === "clear" && argv.length === 1) {
        const count = state.tasks.length;
        state.tasks = [];
        state.nextId = 1;
        state.currentGoal = undefined;
        state.goalId = undefined;
        state.showWidget = false;
        runtime.autoResumeCount = 0;
        cancelPending(runtime);
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify(t("errSaveState"), "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        ctx.ui.notify(tf("clearedTasks", String(count)), "info");
        return;
      }

      // List/status aliases (match with or without extra args)
      if (["list", "status", "ls"].includes(op)) {
        ctx.ui.notify(formatTaskList(state), "info");
        return;
      }

      // Treat anything else as a goal
      const goalText = sanitizeText(commandArgsToText(args), MAX_GOAL_TEXT_LENGTH);
      if (goalText) {
        state.currentGoal = goalText;
        state.goalId = generateGoalId();
        state.tasks = [];
        state.nextId = 1;
        runtime.autoResumeCount = 0;
        cancelPending(runtime);
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify(t("errSaveGoal"), "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        
        // Send a message to AI to decompose the goal
        const message = [
          `🎯 ${tf("newGoalSet", goalText)}`,
          "",
          t("decomposeRequest"),
          t("requirementsLabel"),
          t("req1"),
          t("req2"),
          t("req3"),
          t("req4"),
        ].join("\n");
        
        ctx.ui.notify(tf("goalSetDecomposing", goalText), "info");
        
        // Send to AI for decomposition
        pi.sendUserMessage(message);
        return;
      }

      // Fallback
      ctx.ui.notify(t("unknownCommand"), "error");
    },
  });
}
