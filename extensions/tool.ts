/**
 * Task tool registration for pi-anchor.
 *
 * Registers the "task" tool that AI uses to manage the persistent task list.
 * Actions: list, add, toggle, delete, clear
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { type Runtime, type Task, type TaskDetails, type TaskToolParams, MAX_TASK_TEXT_LENGTH } from "./types.js";
import {
  cancelPending,
  withStateRollback,
  sanitizeText,
} from "./storage.js";
import { updateTodoWidget } from "./widget.js";
import { t, tf } from "./i18n.js";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTaskTool(
  pi: ExtensionAPI,
  getRuntime: (ctx: ExtensionContext) => Runtime,
  refreshRuntime: (ctx: ExtensionContext) => Runtime,
  saveRuntime: (ctx: ExtensionContext, runtime: Runtime) => boolean,
): void {
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
}
