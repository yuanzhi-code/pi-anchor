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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Runtime, RESUME_DELAY_MS } from "./types.js";
import {
  loadState,
  saveState,
  hasUndoneTasks,
  cancelPending,
  createRuntimeStore,
  buildResumeMessage,
} from "./storage.js";
import { updateTodoWidget } from "./widget.js";
import { registerTaskTool } from "./tool.js";
import { registerAnchorCommand } from "./command.js";
import { tf } from "./i18n.js";

// Re-export for test compatibility
export { safeSessionKey, taskFilePath } from "./storage.js";

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

  // -----------------------------------------------------------------------
  // Auto-resume scheduling
  // -----------------------------------------------------------------------

  /**
   * Shared auto-resume logic for agent_end and session_compact.
   * Checks conditions and schedules a delayed resume if needed.
   */
  const maybeScheduleResume = (ctx: ExtensionContext, runtime: Runtime): void => {
    updateTodoWidget(ctx, runtime);
    cancelPending(runtime);

    if (!runtime.state.autoResume) return;
    if (!hasUndoneTasks(runtime.state)) return;
    if (runtime.autoResumeCount >= runtime.state.maxAutoResume) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    scheduleResume(ctx, runtime);
  };

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
    maybeScheduleResume(ctx, runtime);
  });

  pi.on("session_compact", async (_event: unknown, ctx: ExtensionContext) => {
    const runtime = refreshRuntime(ctx);
    maybeScheduleResume(ctx, runtime);
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
  // Register tool and command
  // -----------------------------------------------------------------------

  registerTaskTool(pi, getRuntime, refreshRuntime, saveRuntime);
  registerAnchorCommand(pi, getRuntime, refreshRuntime, saveRuntime);
}
