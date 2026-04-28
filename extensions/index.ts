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
  pendingMessage: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AUTO_RESUME = 20;
const RESUME_DELAY_MS = 800;
const TASK_DIR = ".pi";
const TASK_SUBDIR = "tasks";

/** Command completions for /anchor */
const ANCHOR_COMMANDS: AutocompleteItem[] = [
  { value: "help", description: "显示可用命令" },
  { value: "auto on", description: "开启自动续命" },
  { value: "auto off", description: "关闭自动续命" },
  { value: "auto retry on", description: "开启自动续命（完整写法）" },
  { value: "auto retry off", description: "关闭自动续命（完整写法）" },
  { value: "limit", description: "设置最大自动续命次数，如 limit 20" },
  { value: "list", description: "显示当前任务列表" },
  { value: "clear", description: "清除所有任务和目标" },
];

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function safeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
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
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  if (typeof text !== "string") return null;
  if (typeof done !== "boolean") return null;

  return {
    id,
    text,
    done,
    createdAt: typeof createdAt === "number" ? createdAt : Date.now(),
    goalId: typeof goalId === "string" ? goalId : undefined,
  };
}

function loadState(cwd: string, sessionKey: string): TaskState {
  const file = taskFilePath(cwd, sessionKey);
  try {
    if (fs.existsSync(file)) {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (isRecord(data) && Array.isArray(data.tasks)) {
        const tasks = data.tasks.map(sanitizeTask).filter((t): t is Task => t !== null);
        const maxTaskId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
        const storedNextId = data.nextId;
        const storedMaxAutoResume = data.maxAutoResume;
        const nextId = typeof storedNextId === "number" && Number.isInteger(storedNextId) && storedNextId > maxTaskId
          ? storedNextId
          : maxTaskId + 1;
        const maxAutoResume = typeof storedMaxAutoResume === "number" && Number.isInteger(storedMaxAutoResume) && storedMaxAutoResume >= 0
          ? storedMaxAutoResume
          : DEFAULT_MAX_AUTO_RESUME;

        return {
          tasks,
          nextId,
          autoResume: typeof data.autoResume === "boolean" ? data.autoResume : true,
          maxAutoResume,
          currentGoal: typeof data.currentGoal === "string" && data.currentGoal ? data.currentGoal : undefined,
          goalId: typeof data.goalId === "string" && data.goalId ? data.goalId : undefined,
          showWidget: typeof data.showWidget === "boolean" ? data.showWidget : false,
        };
      }
    }
  } catch {
    // ignore corrupted file
  }
  return { tasks: [], nextId: 1, autoResume: true, maxAutoResume: DEFAULT_MAX_AUTO_RESUME, showWidget: false };
}

function saveState(cwd: string, sessionKey: string, state: TaskState): boolean {
  try {
    ensureTaskDir(cwd);
    const file = taskFilePath(cwd, sessionKey);
    const tmpFile = file + ".tmp";
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
    parts.push(`🎯 用户目标: ${state.currentGoal}`);
    parts.push("");
    parts.push(`📋 分解的任务 (${undone.length}/${state.tasks.length} 未完成):`);
  } else {
    parts.push(`📋 剩余任务 (${undone.length}/${state.tasks.length}):`);
  }

  parts.push(...undone.map((t) => `- [ ] #${t.id}: ${t.text}`));
  parts.push("");
  parts.push(`还有 ${undone.length} 个任务待完成，让我们继续推进。`);

  return parts.join("\n");
}

function hasUndoneTasks(state: TaskState): boolean {
  return state.tasks.some((t) => !t.done);
}

function createRuntime(): Runtime {
  return {
    state: { tasks: [], nextId: 1, autoResume: true, maxAutoResume: DEFAULT_MAX_AUTO_RESUME, showWidget: false },
    autoResumeCount: 0,
    pendingTimer: null,
    pendingMessage: null,
  };
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

export default function taskPersistenceExtension(pi: ExtensionAPI) {
  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): Runtime => runtimeStore.ensure(getSessionKey(ctx));

  const refreshRuntime = (ctx: ExtensionContext): Runtime => {
    const runtime = getRuntime(ctx);
    runtime.state = loadState(ctx.cwd, getSessionKey(ctx));
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
    const autoText = state.autoResume ? theme.fg("success", "auto retry on") : theme.fg("warning", "auto retry off");
    const retryText = runtime.autoResumeCount > 0
      ? theme.fg("warning", `retry ${runtime.autoResumeCount}/${state.maxAutoResume}`)
      : theme.fg("dim", `retry 0/${state.maxAutoResume}`);
    const statusText = todo.length === 0
      ? theme.fg("success", `${done.length}/${state.tasks.length} done`)
      : theme.fg("warning", `${done.length}/${state.tasks.length} pending`);
    
    const header = [
      theme.fg("accent", "⚓ Tasks"),
      statusText,
      autoText,
      retryText,
    ].join(" · ");

    const helpHint = theme.fg("dim", "  💡 ") + theme.fg("accent", "/anchor <目标>") + theme.fg("dim", " 设置目标 | ") + theme.fg("accent", "/anchor help");

    // Show current goal if exists
    const goalLine = state.currentGoal
      ? [theme.fg("accent", "  🎯 ") + theme.fg("text", state.currentGoal)]
      : [];

    if (state.tasks.length === 0) {
      ctx.ui.setWidget("pi-anchor", [header, ...goalLine, theme.fg("dim", "  暂无任务"), "", helpHint]);
      return;
    }

    const visible = [...todo, ...done].slice(0, 10);
    const lines = visible.map((t) => {
      if (t.done) return theme.fg("success", `  ✓ #${t.id} ${t.text}`);
      if (activeTask?.id === t.id) return theme.fg("warning", `  ▶ #${t.id} ${t.text}`);
      return theme.fg("text", `  □ #${t.id} ${t.text}`);
    });
    const extra = state.tasks.length > visible.length
      ? [theme.fg("dim", `  … 还有 ${state.tasks.length - visible.length} 个`)]
      : [];
    ctx.ui.setWidget("pi-anchor", [header, ...goalLine, ...lines, ...extra, "", helpHint]);
  };

  // Cancel any pending auto-resume
  const cancelPending = (runtime: Runtime): void => {
    if (runtime.pendingTimer) {
      clearTimeout(runtime.pendingTimer);
      runtime.pendingTimer = null;
      runtime.pendingMessage = null;
    }
  };

  // Schedule an auto-resume message
  const scheduleResume = (ctx: ExtensionContext, runtime: Runtime): void => {
    cancelPending(runtime);
    runtime.pendingTimer = setTimeout(() => {
      runtime.pendingTimer = null;
      runtime.pendingMessage = null;

      // Double-check the current state before injecting a follow-up.
      if (!runtime.state.autoResume) return;
      if (!hasUndoneTasks(runtime.state)) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

      if (runtime.autoResumeCount >= runtime.state.maxAutoResume) {
        ctx.ui.notify(`Task auto-retry limit reached (${runtime.state.maxAutoResume})`, "info");
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
    const runtime = refreshRuntime(ctx);
    runtime.autoResumeCount = 0;
    cancelPending(runtime);
    runtime.state.showWidget = false;
    saveRuntime(ctx, runtime);
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
            parts.push("Tasks:");
            parts.push(...state.tasks.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`));
          } else {
            parts.push("暂无任务。");
          }
          
          parts.push("");
          parts.push(`(${undone}/${state.tasks.length} pending)`);

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
          if (!params.text) {
            return {
              content: [{ type: "text", text: "错误：添加任务需要提供 text 参数" }],
              details: {
                action: "add",
                tasks: [...state.tasks],
                nextId: state.nextId,
                error: "text required",
              } as TaskDetails,
            };
          }
          const task: Task = {
            id: state.nextId++,
            text: params.text,
            done: false,
            createdAt: Date.now(),
            goalId: state.goalId, // Associate with current goal if exists
          };
          state.tasks.push(task);
          if (!saveRuntime(ctx, runtime)) {
            return {
              content: [{ type: "text", text: "错误：保存任务状态失败" }],
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
              { type: "text", text: `Added task #${task.id}: ${task.text}` },
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
                { type: "text", text: "错误：切换任务状态需要提供 id 参数" },
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
                  text: `未找到任务 #${params.id}`,
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
          task.done = !task.done;
          if (!saveRuntime(ctx, runtime)) {
            return {
              content: [{ type: "text", text: "错误：保存任务状态失败" }],
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
                text: `Task #${task.id} ${task.done ? "completed" : "reopened"}`,
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
                { type: "text", text: "错误：删除任务需要提供 id 参数" },
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
                  text: `未找到任务 #${params.id}`,
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
          const [removed] = state.tasks.splice(index, 1);
          if (!saveRuntime(ctx, runtime)) {
            return {
              content: [{ type: "text", text: "错误：保存任务状态失败" }],
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
              { type: "text", text: `Deleted task #${removed.id}: ${removed.text}` },
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
          state.tasks = [];
          state.nextId = 1;
          state.currentGoal = undefined;
          state.goalId = undefined;
          runtime.autoResumeCount = 0;
          cancelPending(runtime);
          state.showWidget = false;
          if (!saveRuntime(ctx, runtime)) {
            return {
              content: [{ type: "text", text: "错误：保存任务状态失败" }],
              details: {
                action: "clear",
                tasks: [],
                nextId: 1,
                currentGoal: undefined,
                error: "save failed",
              } as TaskDetails,
            };
          }
          updateTodoWidget(ctx, runtime);
          return {
            content: [
              { type: "text", text: `Cleared ${count} tasks and goal` },
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
                text: `Unknown action: ${params.action}`,
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

    // Return plain text - notify() wraps with its own color
    const statusText = todo.length === 0
      ? `✓ ${done.length}/${state.tasks.length} done`
      : `⏳ ${todo.length}/${state.tasks.length} pending`;

    const autoText = state.autoResume ? "auto retry on" : "auto retry off";

    const header = [
      "⚓ Tasks",
      statusText,
      autoText,
      `limit: ${state.maxAutoResume}`,
    ].join(" · ");

    const parts: string[] = [header];

    // Show current goal
    if (state.currentGoal) {
      parts.push("");
      parts.push(`  🎯 目标: ${state.currentGoal}`);
    }

    if (state.tasks.length === 0) {
      parts.push("");
      parts.push("  还没有任务。");
      parts.push("");
      parts.push("  💡 使用方法:");
      parts.push("    /anchor <目标>          设置目标，AI 自动拆解任务");
      parts.push("    /anchor                 查看当前状态");
      parts.push("    /anchor help            查看所有命令");
    } else {
      parts.push("");

      // Show pending tasks
      if (todo.length > 0) {
        parts.push(`  📋 待完成 (${todo.length}):`);
        parts.push(...todo.map((t) => `    □ #${t.id} ${t.text}`));
      }

      // Show completed (limited)
      if (done.length > 0) {
        parts.push(`  ✅ 已完成 (${done.length}):`);
        parts.push(...done.slice(0, 3).map((t) => `    ✓ #${t.id} ${t.text}`));
        if (done.length > 3) {
          parts.push(`    ... 还有 ${done.length - 3} 个`);
        }
      }

      parts.push("");
      parts.push("  💡 /anchor help 查看命令 | /anchor <目标> 设置目标");
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
        ctx.ui.notify("错误：保存状态失败", "error");
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

      // Help
      if (["help", "-h", "--help"].includes(op)) {
        const theme = ctx.ui.theme;
        ctx.ui.notify(
          [
            theme.fg("accent", "⚓ Task Commands"),
            "",
            `  ${theme.fg("success", "/anchor <目标>")}        设置目标，AI 自动拆解为具体任务`,
            `  ${theme.fg("success", "/anchor")}                 显示当前状态和任务列表`,
            `  ${theme.fg("success", "/anchor help")}            显示此帮助`,
            `  ${theme.fg("success", "/anchor auto on|off")}         开启/关闭自动续命（兼容 auto retry on|off）`,
            `  ${theme.fg("success", "/anchor limit <n>")}       设置最大重试次数`,
            `  ${theme.fg("success", "/anchor clear")}           清除所有任务和目标`,
            "",
            theme.fg("dim", "  工作流程:"),
            theme.fg("dim", "  1. 用户设置目标: /anchor 实现用户登录功能"),
            theme.fg("dim", "  2. AI 自动拆解成具体任务"),
            theme.fg("dim", "  3. AI 逐步完成每个任务"),
            theme.fg("dim", "  4. 空闲时自动提醒继续"),
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
          ctx.ui.notify(`自动续命: ${state.autoResume ? "开启" : "关闭"}。用法: /anchor auto on|off（或 auto retry on|off）`, "info");
          return;
        }
        state.autoResume = value === "on";
        runtime.autoResumeCount = 0;
        if (!state.autoResume) {
          cancelPending(runtime);
        }
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify("错误：保存状态失败", "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        ctx.ui.notify(`自动重试${state.autoResume ? "已开启" : "已关闭"}`, "info");
        return;
      }

      // Limit
      if (op === "limit") {
        const limit = Number(argv[1]);
        if (!Number.isInteger(limit) || limit < 0) {
          ctx.ui.notify("用法: /anchor limit <非负整数>", "error");
          return;
        }
        state.maxAutoResume = limit;
        runtime.autoResumeCount = 0;
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify("错误：保存状态失败", "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        ctx.ui.notify(`最大重试次数已设置为 ${limit}`, "info");
        return;
      }

      // Clear all
      if (op === "clear") {
        const count = state.tasks.length;
        state.tasks = [];
        state.nextId = 1;
        state.currentGoal = undefined;
        state.goalId = undefined;
        state.showWidget = false;
        runtime.autoResumeCount = 0;
        cancelPending(runtime);
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify("错误：保存状态失败", "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        ctx.ui.notify(`已清除 ${count} 个任务和目标`, "info");
        return;
      }

      // List/status aliases
      if (["list", "status", "ls"].includes(op)) {
        ctx.ui.notify(formatTaskList(state), "info");
        return;
      }

      // Treat anything else as a goal
      const goalText = commandArgsToText(args);
      if (goalText) {
        state.currentGoal = goalText;
        state.goalId = generateGoalId();
        state.tasks = [];
        state.nextId = 1;
        runtime.autoResumeCount = 0;
        cancelPending(runtime);
        if (!saveRuntime(ctx, runtime)) {
          ctx.ui.notify("错误：保存新目标失败", "error");
          return;
        }
        updateTodoWidget(ctx, runtime);
        
        // Send a message to AI to decompose the goal
        const message = [
          `🎯 用户设置了新目标: ${goalText}`,
          "",
          "请帮我将这个目标拆解成具体的、可执行的任务步骤。",
          "要求:",
          "1. 每个任务应该是具体、可执行的小步骤",
          "2. 按照逻辑顺序排列",
          "3. 使用 task tool 的 add 操作逐个添加",
          "4. 添加完所有任务后，确认任务列表",
        ].join("\n");
        
        ctx.ui.notify(`目标已设置: ${goalText}\n正在让 AI 拆解任务...`, "info");
        
        // Send to AI for decomposition
        pi.sendUserMessage(message);
        return;
      }

      // Fallback
      ctx.ui.notify("未知命令。试试 /anchor help", "error");
    },
  });
}
