/**
 * Minimal i18n for pi-anchor.
 * Default language is English (en). Chinese (zh) is available.
 *
 * To switch language, set `process.env.PI_ANCHOR_LANG = 'zh'`
 * before the extension loads.
 */

declare const process: { env: Record<string, string | undefined> };

export type Lang = "en" | "zh";

let currentLang: Lang = (process.env.PI_ANCHOR_LANG as Lang) ?? "en";

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: keyof typeof translations): string {
  return (translations[key] as Record<Lang, string>)[currentLang];
}

/** Simple template replacement: t("pendingCount", n.toString()) */
export function tf(key: keyof typeof translations, ...args: string[]): string {
  let text = translations[key][currentLang];
  args.forEach((arg, i) => {
    text = text.replace(new RegExp(`\\{${i}\\}`, "g"), arg);
  });
  return text;
}

const translations: Record<string, Record<Lang, string>> = {
  // Command completions
  cmdHelpDesc: { en: "Show available commands", zh: "显示可用命令" },
  cmdAutoOnDesc: { en: "Enable auto-retry", zh: "开启自动续命" },
  cmdAutoOffDesc: { en: "Disable auto-retry", zh: "关闭自动续命" },
  cmdAutoRetryOnDesc: { en: "Enable auto-retry (full syntax)", zh: "开启自动续命（完整写法）" },
  cmdAutoRetryOffDesc: { en: "Disable auto-retry (full syntax)", zh: "关闭自动续命（完整写法）" },
  cmdLimitDesc: { en: "Set max auto-retries, e.g. limit 20", zh: "设置最大自动续命次数，如 limit 20" },
  cmdListDesc: { en: "Show current task list", zh: "显示当前任务列表" },
  cmdClearDesc: { en: "Clear all tasks and goal", zh: "清除所有任务和目标" },

  // Resume message
  userGoal: { en: "User Goal", zh: "用户目标" },
  decomposedTasks: { en: "Decomposed Tasks", zh: "分解的任务" },
  remainingTasks: { en: "Remaining Tasks", zh: "剩余任务" },
  pendingCount: { en: "{0} task(s) remaining. Let's keep going.", zh: "还有 {0} 个任务待完成，让我们继续推进。" },

  // Errors
  errSaveState: { en: "Error: failed to save state", zh: "错误：保存状态失败" },
  errSaveTaskState: { en: "Error: failed to save task state", zh: "错误：保存任务状态失败" },
  errAddTextRequired: { en: "Error: text parameter is required to add a task", zh: "错误：添加任务需要提供 text 参数" },
  errToggleIdRequired: { en: "Error: id parameter is required to toggle a task", zh: "错误：切换任务状态需要提供 id 参数" },
  errDeleteIdRequired: { en: "Error: id parameter is required to delete a task", zh: "错误：删除任务需要提供 id 参数" },
  errTaskNotFound: { en: "Task #{0} not found", zh: "未找到任务 #{0}" },
  errSaveGoal: { en: "Error: failed to save new goal", zh: "错误：保存新目标失败" },

  // Task tool list
  noTasksYet: { en: "No tasks yet.", zh: "暂无任务。" },
  tasksLabel: { en: "Tasks:", zh: "任务:" },
  pendingLabel: { en: "pending", zh: "未完成" },

  // Task tool responses
  addedTask: { en: "Added task #{0}: {1}", zh: "已添加任务 #{0}: {1}" },
  taskCompleted: { en: "Task #{0} completed", zh: "任务 #{0} 已完成" },
  taskReopened: { en: "Task #{0} reopened", zh: "任务 #{0} 已重新打开" },
  deletedTask: { en: "Deleted task #{0}: {1}", zh: "已删除任务 #{0}: {1}" },
  clearedTasksTool: { en: "Cleared {0} tasks and goal", zh: "已清除 {0} 个任务和目标" },
  unknownAction: { en: "Unknown action: {0}", zh: "未知操作: {0}" },

  // Widget display
  anchorTasksHeader: { en: "⚓ Tasks", zh: "⚓ 任务" },
  autoRetryOnWidget: { en: "auto retry on", zh: "自动续命 开启" },
  autoRetryOffWidget: { en: "auto retry off", zh: "自动续命 关闭" },
  statusDone: { en: "{0}/{1} done", zh: "{0}/{1} 完成" },
  statusPending: { en: "{0}/{1} pending", zh: "{0}/{1} 待完成" },
  retryCount: { en: "retry {0}/{1}", zh: "重试 {0}/{1}" },

  // Widget
  setGoalHint: { en: "/anchor <goal>", zh: "/anchor <目标>" },
  setGoalPipe: { en: " set goal | ", zh: " 设置目标 | " },
  noTasksWidget: { en: "  No tasks", zh: "  暂无任务" },
  moreTasks: { en: "  … {0} more", zh: "  … 还有 {0} 个" },

  // formatTaskList
  goalLabel: { en: "Goal:", zh: "目标:" },
  noTasksYetFmt: { en: "  No tasks yet.", zh: "  还没有任务。" },
  usageLabel: { en: "  💡 Usage:", zh: "  💡 使用方法:" },
  cmdSetGoal: { en: "    /anchor <goal>          Set goal, AI auto-decomposes", zh: "    /anchor <目标>          设置目标，AI 自动拆解任务" },
  cmdShowStatus: { en: "    /anchor                 Show current status", zh: "    /anchor                 查看当前状态" },
  cmdShowHelp: { en: "    /anchor help            Show all commands", zh: "    /anchor help            查看所有命令" },
  pendingList: { en: "  📋 Pending ({0}):", zh: "  📋 待完成 ({0}):" },
  completedList: { en: "  ✅ Completed ({0}):", zh: "  ✅ 已完成 ({0}):" },
  moreCompleted: { en: "    ... {0} more", zh: "    ... 还有 {0} 个" },
  hintHelpGoal: { en: "  💡 /anchor help for commands | /anchor <goal> to set goal", zh: "  💡 /anchor help 查看命令 | /anchor <目标> 设置目标" },
  formatStatusDone: { en: "✓ {0}/{1} done", zh: "✓ {0}/{1} 完成" },
  formatStatusPending: { en: "⏳ {0}/{1} pending", zh: "⏳ {0}/{1} 待完成" },
  formatAutoRetryOn: { en: "auto retry on", zh: "自动续命 开启" },
  formatAutoRetryOff: { en: "auto retry off", zh: "自动续命 关闭" },
  formatLimit: { en: "limit: {0}", zh: "上限: {0}" },

  // Help command
  anchorTaskCommands: { en: "⚓ Task Commands", zh: "⚓ 任务命令" },
  helpSetGoal: { en: "  /anchor <goal>        Set goal, AI auto-decomposes into tasks", zh: "  /anchor <目标>        设置目标，AI 自动拆解为具体任务" },
  helpShowStatus: { en: "  /anchor                 Show current status and task list", zh: "  /anchor                 显示当前状态和任务列表" },
  helpShowHelp: { en: "  /anchor help            Show this help", zh: "  /anchor help            显示此帮助" },
  helpAutoToggle: { en: "  /anchor auto on|off         Enable/disable auto-retry (also auto retry on|off)", zh: "  /anchor auto on|off         开启/关闭自动续命（兼容 auto retry on|off）" },
  helpLimit: { en: "  /anchor limit <n>       Set max retry limit", zh: "  /anchor limit <n>       设置最大重试次数" },
  helpClear: { en: "  /anchor clear           Clear all tasks and goal", zh: "  /anchor clear           清除所有任务和目标" },
  workflowLabel: { en: "  Workflow:", zh: "  工作流程:" },
  workflow1: { en: "  1. User sets goal: /anchor implement user login", zh: "  1. 用户设置目标: /anchor 实现用户登录功能" },
  workflow2: { en: "  2. AI auto-decomposes into concrete tasks", zh: "  2. AI 自动拆解成具体任务" },
  workflow3: { en: "  3. AI completes each task step by step", zh: "  3. AI 逐步完成每个任务" },
  workflow4: { en: "  4. Auto-reminder when idle", zh: "  4. 空闲时自动提醒继续" },

  // Auto command
  autoRetryStatus: { en: "Auto-retry: {0}. Usage: /anchor auto on|off (or auto retry on|off)", zh: "自动续命: {0}。用法: /anchor auto on|off（或 auto retry on|off）" },
  autoRetryOn: { en: "Auto-retry enabled", zh: "自动重试已开启" },
  autoRetryOff: { en: "Auto-retry disabled", zh: "自动重试已关闭" },
  on: { en: "on", zh: "开启" },
  off: { en: "off", zh: "关闭" },

  // Limit command
  limitUsage: { en: "Usage: /anchor limit <non-negative integer>", zh: "用法: /anchor limit <非负整数>" },
  limitSet: { en: "Max retry limit set to {0}", zh: "最大重试次数已设置为 {0}" },

  // Clear command
  clearedTasks: { en: "Cleared {0} task(s) and goal", zh: "已清除 {0} 个任务和目标" },

  // Goal setting
  goalSetDecomposing: { en: "Goal set: {0}\nDecomposing tasks...", zh: "目标已设置: {0}\n正在让 AI 拆解任务..." },

  // AI decomposition message
  newGoalSet: { en: "New goal set by user: {0}", zh: "用户设置了新目标: {0}" },
  decomposeRequest: { en: "Please decompose this goal into concrete, actionable task steps.", zh: "请帮我将这个目标拆解成具体的、可执行的任务步骤。" },
  requirementsLabel: { en: "Requirements:", zh: "要求:" },
  req1: { en: "1. Each task should be a concrete, actionable small step", zh: "1. 每个任务应该是具体、可执行的小步骤" },
  req2: { en: "2. Arrange in logical order", zh: "2. 按照逻辑顺序排列" },
  req3: { en: "3. Use the task tool's add action to add them one by one", zh: "3. 使用 task tool 的 add 操作逐个添加" },
  req4: { en: "4. After adding all tasks, confirm the task list", zh: "4. 添加完所有任务后，确认任务列表" },

  // Fallback
  unknownCommand: { en: "Unknown command. Try /anchor help", zh: "未知命令。试试 /anchor help" },

  // Retry limit reached
  retryLimitReached: { en: "Task auto-retry limit reached ({0})", zh: "自动续命次数已达上限 ({0})" },
};
