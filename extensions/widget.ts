/**
 * Rendering logic for pi-anchor.
 *
 * Provides shared helpers and two rendering paths:
 * - updateTodoWidget(): compact TUI widget display
 * - formatTaskList(): detailed /anchor command output
 *
 * Shared helpers eliminate duplication between the two paths.
 */

import type { Runtime, Task, TaskState } from "./types.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { t, tf } from "./i18n.js";

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

/**
 * Build the status bar line: "⚓ Tasks · ⏳ 3/5 pending · auto retry on · limit: 20"
 */
export function buildStatusBar(state: TaskState, runtime: Runtime, theme: ExtensionContext["ui"]["theme"]): string {
  const todo = state.tasks.filter((t) => !t.done);
  const done = state.tasks.filter((t) => t.done);

  const statusText = todo.length === 0
    ? theme.fg("success", tf("statusDone", String(done.length), String(state.tasks.length)))
    : theme.fg("warning", tf("statusPending", String(done.length), String(state.tasks.length)));

  const autoText = state.autoResume
    ? theme.fg("success", t("autoRetryOnWidget"))
    : theme.fg("warning", t("autoRetryOffWidget"));

  const retryText = runtime.autoResumeCount > 0
    ? theme.fg("warning", tf("retryCount", String(runtime.autoResumeCount), String(state.maxAutoResume)))
    : theme.fg("dim", tf("retryCount", "0", String(state.maxAutoResume)));

  return [
    theme.fg("accent", t("anchorTasksHeader")),
    statusText,
    autoText,
    retryText,
  ].join(" · ");
}

/**
 * Format a single task item for display.
 *
 * @param task - The task to render
 * @param activeTaskId - ID of the currently active (first undone) task
 * @param theme - UI theme for colorized output
 * @param mode - "widget" (compact, with ▶ marker) or "command" (detail, with □ marker)
 */
export function formatTaskItem(
  task: Task,
  activeTaskId: number | undefined,
  theme: ExtensionContext["ui"]["theme"],
  mode: "widget" | "command",
): string {
  if (task.done) {
    return theme.fg("success", `  ✓ #${task.id} ${task.text}`);
  }
  if (mode === "widget" && activeTaskId === task.id) {
    return theme.fg("warning", `  ▶ #${task.id} ${task.text}`);
  }
  return theme.fg("text", `  □ #${task.id} ${task.text}`);
}

/**
 * Build the goal display line: "  🎯 Goal: implement user login"
 */
export function buildGoalLine(state: TaskState, theme: ExtensionContext["ui"]["theme"]): string[] {
  if (!state.currentGoal) return [];
  return [theme.fg("accent", "  🎯 ") + theme.fg("text", state.currentGoal)];
}

// ---------------------------------------------------------------------------
// Widget rendering (compact TUI display)
// ---------------------------------------------------------------------------

/**
 * Update the pi-anchor TUI widget.
 *
 * Shows a compact view with:
 * - Status bar (status, auto-retry, retry count)
 * - Goal (if set)
 * - Task list (max 10 items, active task highlighted with ▶)
 * - Help hint
 *
 * Widget is hidden by default, only shown after /anchor is invoked.
 */
export function updateTodoWidget(ctx: ExtensionContext, runtime: Runtime): void {
  const { state } = runtime;
  const theme = ctx.ui.theme;

  // Hide widget by default - only show when user explicitly invoked /anchor
  if (!state.showWidget) {
    ctx.ui.setWidget("pi-anchor", undefined);
    return;
  }

  const todo = state.tasks.filter((t) => !t.done);
  const activeTask = todo[0];

  const header = buildStatusBar(state, runtime, theme);
  const helpHint = theme.fg("dim", "  💡 ") + theme.fg("accent", t("setGoalHint")) + theme.fg("dim", t("setGoalPipe")) + theme.fg("accent", "/anchor help");
  const goalLine = buildGoalLine(state, theme);

  if (state.tasks.length === 0) {
    ctx.ui.setWidget("pi-anchor", [header, ...goalLine, theme.fg("dim", t("noTasksWidget")), "", helpHint]);
    return;
  }

  const done = state.tasks.filter((t) => t.done);
  const visible = [...todo, ...done].slice(0, 10);
  const lines = visible.map((task) => formatTaskItem(task, activeTask?.id, theme, "widget"));
  const extra = state.tasks.length > visible.length
    ? [theme.fg("dim", tf("moreTasks", String(state.tasks.length - visible.length)))]
    : [];

  ctx.ui.setWidget("pi-anchor", [header, ...goalLine, ...lines, ...extra, "", helpHint]);
}

// ---------------------------------------------------------------------------
// Command rendering (detailed /anchor output)
// ---------------------------------------------------------------------------

/**
 * Format the task list for the /anchor command response.
 *
 * Shows a detailed view with:
 * - Status bar (with limit info)
 * - Goal (if set)
 * - Pending tasks section
 * - Completed tasks section (max 3 shown)
 * - Usage hint
 */
export function formatTaskList(state: TaskState, runtime: Runtime, theme: ExtensionContext["ui"]["theme"]): string {
  const todo = state.tasks.filter((t) => !t.done);
  const done = state.tasks.filter((t) => t.done);

  // Build header with limit info (command-specific)
  const statusBar = buildStatusBar(state, runtime, theme);
  const header = `${statusBar} · ${tf("formatLimit", String(state.maxAutoResume))}`;

  const parts: string[] = [header];

  // Goal
  const goalLine = buildGoalLine(state, theme);
  if (goalLine.length > 0) {
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

    // Pending tasks
    if (todo.length > 0) {
      parts.push(tf("pendingList", String(todo.length)));
      parts.push(...todo.map((task) => formatTaskItem(task, undefined, theme, "command")));
    }

    // Completed tasks (limited to 3)
    if (done.length > 0) {
      parts.push(tf("completedList", String(done.length)));
      parts.push(...done.slice(0, 3).map((task) => `    ✓ #${task.id} ${task.text}`));
      if (done.length > 3) {
        parts.push(tf("moreCompleted", String(done.length - 3)));
      }
    }

    parts.push("");
    parts.push(t("hintHelpGoal"));
  }

  return parts.join("\n");
}
