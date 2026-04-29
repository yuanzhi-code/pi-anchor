/**
 * Type definitions and constants for pi-anchor.
 */

import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { t } from "./i18n.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Task {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
  /** Which goal this task belongs to */
  goalId?: string;
}

export interface TaskState {
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

export interface TaskDetails {
  action: "list" | "add" | "toggle" | "delete" | "clear";
  tasks: Task[];
  nextId: number;
  currentGoal?: string;
  error?: string;
}

export interface TaskToolParams {
  action: "list" | "add" | "toggle" | "delete" | "clear";
  text?: string;
  id?: number;
}

export interface Runtime {
  state: TaskState;
  autoResumeCount: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_AUTO_RESUME = 20;
export const RESUME_DELAY_MS = 800;
export const TASK_DIR = ".pi";
export const TASK_SUBDIR = "tasks";
export const MAX_TASK_TEXT_LENGTH = 10000;
export const MAX_GOAL_TEXT_LENGTH = 5000;

/** Command completions for /anchor */
export const ANCHOR_COMMANDS: AutocompleteItem[] = [
  { value: "help", description: t("cmdHelpDesc") },
  { value: "auto on", description: t("cmdAutoOnDesc") },
  { value: "auto off", description: t("cmdAutoOffDesc") },
  { value: "auto retry on", description: t("cmdAutoRetryOnDesc") },
  { value: "auto retry off", description: t("cmdAutoRetryOffDesc") },
  { value: "limit", description: t("cmdLimitDesc") },
  { value: "list", description: t("cmdListDesc") },
  { value: "clear", description: t("cmdClearDesc") },
];
