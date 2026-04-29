/**
 * /anchor command registration for pi-anchor.
 *
 * Registers the /anchor user command with argument completions.
 * Supports: help, auto on|off, limit, clear, list/status/ls, <goal>
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { type Runtime, ANCHOR_COMMANDS, MAX_GOAL_TEXT_LENGTH } from "./types.js";
import {
  generateGoalId,
  cancelPending,
  sanitizeText,
} from "./storage.js";
import { updateTodoWidget, formatTaskList } from "./widget.js";
import { t, tf } from "./i18n.js";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

export function parseCommandArgs(args: unknown): string[] {
  if (Array.isArray(args)) return args.map(String);
  if (typeof args === "string") return args.trim() ? args.trim().split(/\s+/) : [];
  return [];
}

export function commandArgsToText(args: unknown): string {
  if (Array.isArray(args)) return args.map(String).join(" ").trim();
  if (typeof args === "string") return args.trim();
  return "";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAnchorCommand(
  pi: ExtensionAPI,
  getRuntime: (ctx: ExtensionContext) => Runtime,
  refreshRuntime: (ctx: ExtensionContext) => Runtime,
  saveRuntime: (ctx: ExtensionContext, runtime: Runtime) => boolean,
): void {
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
          (item.description && item.description.toLowerCase().includes(prefix)),
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
        ctx.ui.notify(formatTaskList(state, runtime, ctx.ui.theme), "info");
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
          "info",
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
        ctx.ui.notify(formatTaskList(state, runtime, ctx.ui.theme), "info");
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
