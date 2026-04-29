import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMock);
vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (value: unknown) => value,
}));
vi.mock("typebox", () => ({
  Type: {
    Object: (value: unknown) => value,
    Optional: (value: unknown) => value,
    String: (value: unknown) => value,
    Number: (value: unknown) => value,
  },
}));

import taskPersistenceExtension from "../index";

const CWD = "/repo";
const SESSION_ID = "session/1?test";

function safeSessionKey(sessionKey: string): string {
  const sanitized = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized === sessionKey) return sanitized;
  let hash = 0;
  for (let i = 0; i < sessionKey.length; i++) {
    const char = sessionKey.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `${sanitized}_${Math.abs(hash).toString(36)}`;
}

function taskFile(sessionKey = SESSION_ID): string {
  return path.join(CWD, ".pi", "tasks", `${safeSessionKey(sessionKey)}.json`);
}

function createPI() {
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => Promise<unknown> | unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();

  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: any) => Promise<unknown> | unknown) => {
      const arr = handlers.get(name) ?? [];
      arr.push(handler);
      handlers.set(name, arr);
    }),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    sendUserMessage: vi.fn(),
  };

  const emit = async (name: string, event: unknown, ctx: any) => {
    const arr = handlers.get(name) ?? [];
    for (const handler of arr) {
      await handler(event, ctx);
    }
  };

  return { pi, handlers, tools, commands, emit };
}

function createCtx(sessionId = SESSION_ID) {
  const theme = {
    fg: vi.fn((_color: string, text: string) => text),
  };

  return {
    cwd: CWD,
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
    },
    ui: {
      theme,
      notify: vi.fn(),
      setWidget: vi.fn(),
    },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
  };
}

function setupExtension() {
  const api = createPI();
  taskPersistenceExtension(api.pi as any);
  return api;
}

describe("pi-anchor extension comprehensive tests", () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    files.clear();
    dirs.clear();

    fsMock.existsSync.mockImplementation((target: string) => files.has(String(target)) || dirs.has(String(target)));
    fsMock.mkdirSync.mockImplementation((target: string) => {
      dirs.add(String(target));
    });
    fsMock.readFileSync.mockImplementation((target: string) => {
      const content = files.get(String(target));
      if (content === undefined) throw new Error("ENOENT");
      return content;
    });
    fsMock.writeFileSync.mockImplementation((target: string, content: string) => {
      files.set(String(target), String(content));
    });
    fsMock.renameSync.mockImplementation((src: string, dest: string) => {
      const content = files.get(String(src));
      if (content !== undefined) {
        files.set(String(dest), String(content));
        files.delete(String(src));
      }
    });
  });

  describe("状态管理（loadState/saveState）", () => {
    it("loads persisted state, sanitizes tasks, and fixes nextId", async () => {
      files.set(
        taskFile(),
        JSON.stringify({
          tasks: [
            { id: 2, text: "valid", done: false, createdAt: 111, goalId: "g1" },
            { id: -1, text: "invalid", done: false, createdAt: 222 },
            { id: 5, text: "done", done: true, createdAt: "bad" },
          ],
          nextId: 3,
          autoResume: false,
          maxAutoResume: 7,
          currentGoal: "finish auth",
          goalId: "g1",
        })
      );

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const list = await taskTool.execute("1", { action: "list" }, undefined, undefined, ctx);

      expect(list.details.tasks).toHaveLength(2);
      expect(list.details.tasks.map((t: any) => t.id)).toEqual([2, 5]);
      expect(list.details.currentGoal).toBe("finish auth");
      expect(list.details.nextId).toBe(6);

      const add = await taskTool.execute("2", { action: "add", text: "new" }, undefined, undefined, ctx);
      // nextId should be 6 since max existing id is 5
      expect(add.content[0].text).toContain("#6");
    });

    it("saves state on shutdown with sanitized session filename", async () => {
      const api = setupExtension();
      const ctx = createCtx("bad/session:id?");
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task-1" }, undefined, undefined, ctx);
      await api.emit("session_shutdown", {}, ctx);

      const writes = fsMock.writeFileSync.mock.calls;
      const lastWrite = writes[writes.length - 1];
      // Temp file now includes pid, timestamp, and random suffix for uniqueness
      expect(lastWrite[0]).toMatch(new RegExp(`^${taskFile("bad/session:id?").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\..*\\.tmp$`));

      // Verify rename was called with matching src/dest pattern
      const renameCall = fsMock.renameSync.mock.calls[0];
      expect(renameCall[0]).toMatch(new RegExp(`^${taskFile("bad/session:id?").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\..*\\.tmp$`));
      expect(renameCall[1]).toBe(taskFile("bad/session:id?"));

      expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-anchor", undefined);
      expect(files.get(taskFile("bad/session:id?"))).toContain("task-1");
    });

    it("falls back to default state when file is corrupted", async () => {
      files.set(taskFile(), "{broken json");
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const list = await taskTool.execute("1", { action: "list" }, undefined, undefined, ctx);

      expect(list.details.tasks).toEqual([]);
      expect(list.details.nextId).toBe(1);
    });
  });

  describe("帮助函数相关行为", () => {
    it("builds auto-resume message with goal and only undone tasks", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["实现", "登录"], ctx);
      api.pi.sendUserMessage.mockClear();

      await taskTool.execute("1", { action: "add", text: "设计接口" }, undefined, undefined, ctx);
      await taskTool.execute("2", { action: "add", text: "写测试" }, undefined, undefined, ctx);
      await taskTool.execute("3", { action: "toggle", id: 2 }, undefined, undefined, ctx);

      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);

      expect(api.pi.sendUserMessage).toHaveBeenCalledTimes(1);
      const msg = api.pi.sendUserMessage.mock.calls[0][0] as string;
      expect(msg).toContain("🎯 User Goal: 实现 登录");
      expect(msg).toContain("- [ ] #1: 设计接口");
      expect(msg).not.toContain("写测试");
    });

    it("hasUndoneTasks behavior: no resume when all tasks are done", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "done-task" }, undefined, undefined, ctx);
      await taskTool.execute("2", { action: "toggle", id: 1 }, undefined, undefined, ctx);

      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(1000);

      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("命令解析（parseCommandArgs/commandArgsToText）", () => {
    it("parses string args for auto retry toggle", async () => {
      vi.useFakeTimers();
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "pending" }, undefined, undefined, ctx);

      await anchorCommand.handler("auto retry off", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "info");

      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("parses array args for limit and goal text", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["limit", "3"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Max retry limit set to 3", "info");

      await anchorCommand.handler(["实现", "支付", "流程"], ctx);
      expect(api.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("New goal set by user: 实现 支付 流程"));

      const list = await taskTool.execute("1", { action: "list" }, undefined, undefined, ctx);
      expect(list.details.currentGoal).toBe("实现 支付 流程");
    });

    it("shows status when command args are blank text", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler("   ", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("⚓ Tasks"), "info");
    });
  });

  describe("任务操作（add/toggle/delete/clear）", () => {
    it("handles add/toggle/delete/clear success flow", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);

      const add1 = await taskTool.execute("1", { action: "add", text: "t1" }, undefined, undefined, ctx);
      const add2 = await taskTool.execute("2", { action: "add", text: "t2" }, undefined, undefined, ctx);
      expect(add1.content[0].text).toContain("#1");
      expect(add2.content[0].text).toContain("#2");

      const toggle = await taskTool.execute("3", { action: "toggle", id: 1 }, undefined, undefined, ctx);
      expect(toggle.content[0].text).toContain("completed");

      const del = await taskTool.execute("4", { action: "delete", id: 2 }, undefined, undefined, ctx);
      expect(del.content[0].text).toContain("Deleted task #2");

      const clear = await taskTool.execute("5", { action: "clear" }, undefined, undefined, ctx);
      expect(clear.content[0].text).toContain("Cleared");

      const list = await taskTool.execute("6", { action: "list" }, undefined, undefined, ctx);
      expect(list.details.tasks).toEqual([]);
      expect(list.details.nextId).toBe(1);
    });

    it("returns proper errors for invalid add/toggle/delete params", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);

      const addErr = await taskTool.execute("1", { action: "add" }, undefined, undefined, ctx);
      expect(addErr.details.error).toBe("text required");

      const toggleMissingId = await taskTool.execute("2", { action: "toggle" }, undefined, undefined, ctx);
      expect(toggleMissingId.details.error).toBe("id required");

      const toggleNotFound = await taskTool.execute("3", { action: "toggle", id: 99 }, undefined, undefined, ctx);
      expect(toggleNotFound.details.error).toContain("#99 not found");

      const deleteMissingId = await taskTool.execute("4", { action: "delete" }, undefined, undefined, ctx);
      expect(deleteMissingId.details.error).toBe("id required");

      const deleteNotFound = await taskTool.execute("5", { action: "delete", id: 88 }, undefined, undefined, ctx);
      expect(deleteNotFound.details.error).toContain("#88 not found");
    });
  });

  describe("自动续命逻辑", () => {
    it("cancels pending resume when agent_start fires", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "pending" }, undefined, undefined, ctx);

      await api.emit("agent_end", {}, ctx);
      await api.emit("agent_start", {}, ctx);
      await vi.advanceTimersByTimeAsync(1000);

      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("does not auto-resume when not idle or with pending messages", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "pending" }, undefined, undefined, ctx);

      ctx.isIdle.mockReturnValue(false);
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();

      ctx.isIdle.mockReturnValue(true);
      ctx.hasPendingMessages.mockReturnValue(true);
      await api.emit("session_compact", {}, ctx);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("边界情况和错误处理", () => {
    it("validates /anchor limit input", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["limit", "-1"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("non-negative integer"), "error");

      await anchorCommand.handler(["limit", "abc"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("non-negative integer"), "error");
    });

    it("handles saveState write failures without throwing", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("disk full");
      });

      await api.emit("session_start", {}, ctx);
      const result = await taskTool.execute("1", { action: "add", text: "safe-add" }, undefined, undefined, ctx);

      expect(result.content[0].text).toContain("Error: failed to save task state");
      expect(result.details.error).toBe("save failed");
      expect(errorSpy).toHaveBeenCalledWith("[anchor] failed to save state:", expect.any(Error));

      errorSpy.mockRestore();
    });
  });

  describe("命令补全 (getArgumentCompletions)", () => {
    it("returns all commands for empty prefix", async () => {
      const api = setupExtension();
      const anchorCommand = api.commands.get("anchor");

      const completions = anchorCommand.getArgumentCompletions("");
      expect(completions).not.toBeNull();
      expect(completions.length).toBeGreaterThan(0);
      expect(completions.map((c: any) => c.value)).toContain("help");
      expect(completions.map((c: any) => c.value)).toContain("auto on");
      expect(completions.map((c: any) => c.value)).toContain("auto off");
      expect(completions.map((c: any) => c.value)).toContain("clear");
      expect(completions.map((c: any) => c.value)).toContain("limit");
      expect(completions.map((c: any) => c.value)).toContain("list");
    });

    it("filters commands by prefix", async () => {
      const api = setupExtension();
      const anchorCommand = api.commands.get("anchor");

      const completions = anchorCommand.getArgumentCompletions("auto");
      expect(completions).not.toBeNull();
      expect(completions.map((c: any) => c.value)).toContain("auto on");
      expect(completions.map((c: any) => c.value)).toContain("auto off");
      expect(completions.map((c: any) => c.value)).toContain("auto retry on");
      expect(completions.map((c: any) => c.value)).toContain("auto retry off");
    });

    it("returns null for free text goals", async () => {
      const api = setupExtension();
      const anchorCommand = api.commands.get("anchor");

      const completions = anchorCommand.getArgumentCompletions("implement login");
      expect(completions).toBeNull();
    });

    it("matches by description too", async () => {
      const api = setupExtension();
      const anchorCommand = api.commands.get("anchor");

      const completions = anchorCommand.getArgumentCompletions("auto-retry");
      // Should match commands whose description contains "auto-retry"
      expect(completions).not.toBeNull();
      expect(completions.length).toBeGreaterThan(0);
    });
  });

  describe("命令路径覆盖", () => {
    it("shows help for /anchor help", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["help"], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Task Commands"),
        "info"
      );
    });

    it("shows list for /anchor list, status, ls", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);

      await anchorCommand.handler(["list"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("⚓ Tasks"), "info");

      vi.clearAllMocks();
      await anchorCommand.handler(["status"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("⚓ Tasks"), "info");

      vi.clearAllMocks();
      await anchorCommand.handler(["ls"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("⚓ Tasks"), "info");
    });

    it("shows auto status when /anchor auto has no on/off arg", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["auto"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Auto-retry: on"), "info");
    });

    it("handles /anchor auto on and auto off", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);

      await anchorCommand.handler(["auto", "off"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Auto-retry disabled", "info");

      await anchorCommand.handler(["auto", "on"], ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Auto-retry enabled", "info");
    });

    it("shows error for unknown /anchor command with no goal text", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      // Empty string after trim should show status, not error
      await anchorCommand.handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("⚓ Tasks"), "info");
    });

    it("/anchor clear with extra args is treated as a goal", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["clear", "failing", "tests"], ctx);

      // Should be treated as a goal, not as clear command
      expect(api.pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("New goal set by user: clear failing tests")
      );
    });
  });

  describe("自动续命限制", () => {
    it("stops auto-resume at maxAutoResume limit", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["limit", "2"], ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);

      // First resume
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);
      expect(api.pi.sendUserMessage).toHaveBeenCalledTimes(1);

      // Second resume
      api.pi.sendUserMessage.mockClear();
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);
      expect(api.pi.sendUserMessage).toHaveBeenCalledTimes(1);

      // Third attempt should be blocked
      api.pi.sendUserMessage.mockClear();
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);
      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("resets auto-resume count on interactive input", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);

      // Trigger resume to increment count
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);
      expect(api.pi.sendUserMessage).toHaveBeenCalledTimes(1);

      // Interactive input should reset count
      api.pi.sendUserMessage.mockClear();
      await api.emit("input", { source: "interactive" }, ctx);

      // Should be able to resume again
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);
      expect(api.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("does not reset auto-resume count on non-interactive input", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["limit", "1"], ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);

      // Trigger resume to increment count
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);
      expect(api.pi.sendUserMessage).toHaveBeenCalledTimes(1);

      // Non-interactive input should NOT reset count
      api.pi.sendUserMessage.mockClear();
      await api.emit("input", { source: "auto" }, ctx);

      // Should be blocked at limit
      await api.emit("agent_end", {}, ctx);
      await vi.advanceTimersByTimeAsync(801);
      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("生命周期事件", () => {
    it("saves and cancels on session_before_switch", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);

      // Start a pending resume
      await api.emit("agent_end", {}, ctx);

      // Switch should cancel pending and save
      await api.emit("session_before_switch", {}, ctx);
      await vi.advanceTimersByTimeAsync(1000);

      // Resume should not fire after switch
      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("saves and cancels on session_before_fork", async () => {
      vi.useFakeTimers();

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);

      // Start a pending resume
      await api.emit("agent_end", {}, ctx);

      // Fork should cancel pending and save
      await api.emit("session_before_fork", {}, ctx);
      await vi.advanceTimersByTimeAsync(1000);

      expect(api.pi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("hides widget on session shutdown", async () => {
      const api = setupExtension();
      const ctx = createCtx();

      await api.emit("session_start", {}, ctx);
      await api.emit("session_shutdown", {}, ctx);

      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-anchor", undefined);
    });
  });

  describe("Widget 渲染", () => {
    it("hides widget by default (showWidget=false)", async () => {
      const api = setupExtension();
      const ctx = createCtx();

      await api.emit("session_start", {}, ctx);

      // Widget should be hidden on session start
      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-anchor", undefined);
    });

    it("shows widget after /anchor is invoked", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler([], ctx);

      // Widget should now be visible
      const setWidgetCalls = ctx.ui.setWidget.mock.calls;
      const lastCall = setWidgetCalls[setWidgetCalls.length - 1];
      expect(lastCall[0]).toBe("pi-anchor");
      expect(lastCall[1]).not.toBeUndefined();
      expect(Array.isArray(lastCall[1])).toBe(true);
    });

    it("shows goal line when goal is set", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["implement", "login"], ctx);

      const setWidgetCalls = ctx.ui.setWidget.mock.calls;
      const lastCall = setWidgetCalls[setWidgetCalls.length - 1];
      const content = lastCall[1] as string[];
      const contentStr = content.join("\n");
      expect(contentStr).toContain("implement login");
    });

    it("shows task list with active and done markers", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler([], ctx);
      await taskTool.execute("1", { action: "add", text: "task1" }, undefined, undefined, ctx);
      await taskTool.execute("2", { action: "add", text: "task2" }, undefined, undefined, ctx);
      await taskTool.execute("3", { action: "toggle", id: 1 }, undefined, undefined, ctx);

      // Trigger widget update
      await api.emit("agent_end", {}, ctx);

      const setWidgetCalls = ctx.ui.setWidget.mock.calls;
      const lastCall = setWidgetCalls[setWidgetCalls.length - 1];
      const content = (lastCall[1] as string[]).join("\n");
      // task1 is done, task2 is active
      expect(content).toContain("✓");
      expect(content).toContain("▶");
    });
  });

  describe("状态持久化边界情况", () => {
    it("handles missing file gracefully (new session)", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const list = await taskTool.execute("1", { action: "list" }, undefined, undefined, ctx);

      expect(list.details.tasks).toEqual([]);
      expect(list.details.nextId).toBe(1);
    });

    it("handles JSON object without tasks array", async () => {
      files.set(taskFile(), JSON.stringify({ notTasks: "invalid" }));

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const list = await taskTool.execute("1", { action: "list" }, undefined, undefined, ctx);

      // Should fall back to empty state since file has invalid structure
      expect(list.details.tasks).toEqual([]);
    });

    it("handles invalid autoResume and maxAutoResume fields", async () => {
      files.set(
        taskFile(),
        JSON.stringify({
          tasks: [],
          nextId: 1,
          autoResume: "yes",
          maxAutoResume: -5,
        })
      );

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const list = await taskTool.execute("1", { action: "list" }, undefined, undefined, ctx);

      // Should use defaults
      expect(list.details.nextId).toBe(1);
    });

    it("deduplicates tasks with duplicate IDs", async () => {
      files.set(
        taskFile(),
        JSON.stringify({
          tasks: [
            { id: 1, text: "first", done: false, createdAt: 100 },
            { id: 1, text: "duplicate", done: false, createdAt: 200 },
            { id: 2, text: "unique", done: false, createdAt: 300 },
          ],
          nextId: 3,
        })
      );

      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const list = await taskTool.execute("1", { action: "list" }, undefined, undefined, ctx);

      // Should keep only the first occurrence of duplicate ID
      expect(list.details.tasks).toHaveLength(2);
      expect(list.details.tasks[0].text).toBe("first");
    });

    it("does not overwrite corrupted file on session start", async () => {
      files.set(taskFile(), "{corrupted json");

      const api = setupExtension();
      const ctx = createCtx();

      // Track writeFileSync calls
      const writeCallsBefore = fsMock.writeFileSync.mock.calls.length;

      await api.emit("session_start", {}, ctx);

      // Should NOT have written to disk since file was corrupted
      expect(fsMock.writeFileSync.mock.calls.length).toBe(writeCallsBefore);
    });
  });

  describe("文本清理和边界值", () => {
    it("rejects blank/whitespace-only task text", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);

      const result = await taskTool.execute("1", { action: "add", text: "   " }, undefined, undefined, ctx);
      expect(result.details.error).toBe("text required");
    });

    it("trims task text", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const result = await taskTool.execute("1", { action: "add", text: "  my task  " }, undefined, undefined, ctx);

      expect(result.content[0].text).toContain("my task");
    });

    it("handles reopening a completed task", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);
      await taskTool.execute("2", { action: "toggle", id: 1 }, undefined, undefined, ctx);

      const reopen = await taskTool.execute("3", { action: "toggle", id: 1 }, undefined, undefined, ctx);
      expect(reopen.content[0].text).toContain("reopened");
    });

    it("handles unknown action in task tool", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");

      await api.emit("session_start", {}, ctx);
      const result = await taskTool.execute("1", { action: "unknown" as any }, undefined, undefined, ctx);

      expect(result.content[0].text).toContain("Unknown action");
      expect(result.details.error).toContain("unknown action");
    });

    it("associates tasks with current goal", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const anchorCommand = api.commands.get("anchor");

      await api.emit("session_start", {}, ctx);
      await anchorCommand.handler(["implement", "auth"], ctx);

      const add = await taskTool.execute("1", { action: "add", text: "task1" }, undefined, undefined, ctx);
      expect(add.details.tasks[0].goalId).toBeDefined();
    });
  });

  describe("保存失败回滚", () => {
    it("rolls back state on add save failure", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await api.emit("session_start", {}, ctx);

      // Add a task first to have some state
      await taskTool.execute("1", { action: "add", text: "existing" }, undefined, undefined, ctx);

      // Now make writes fail
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("disk full");
      });

      const result = await taskTool.execute("2", { action: "add", text: "new" }, undefined, undefined, ctx);
      expect(result.details.error).toBe("save failed");

      // State should be rolled back - next task should still be #2
      fsMock.writeFileSync.mockReset();
      fsMock.writeFileSync.mockImplementation((target: string, content: string) => {
        files.set(String(target), String(content));
      });
      const list = await taskTool.execute("3", { action: "list" }, undefined, undefined, ctx);
      // The failed add should not have incremented nextId
      expect(list.details.tasks).toHaveLength(1);

      errorSpy.mockRestore();
    });

    it("rolls back state on toggle save failure", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);

      // Make writes fail
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("disk full");
      });

      const result = await taskTool.execute("2", { action: "toggle", id: 1 }, undefined, undefined, ctx);
      expect(result.details.error).toBe("save failed");

      // State should be rolled back - task should still be undone
      fsMock.writeFileSync.mockReset();
      fsMock.writeFileSync.mockImplementation((target: string, content: string) => {
        files.set(String(target), String(content));
      });
      const list = await taskTool.execute("3", { action: "list" }, undefined, undefined, ctx);
      expect(list.details.tasks[0].done).toBe(false);

      errorSpy.mockRestore();
    });

    it("rolls back state on delete save failure", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task" }, undefined, undefined, ctx);

      // Make writes fail
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("disk full");
      });

      const result = await taskTool.execute("2", { action: "delete", id: 1 }, undefined, undefined, ctx);
      expect(result.details.error).toBe("save failed");

      // State should be rolled back - task should still exist
      fsMock.writeFileSync.mockReset();
      fsMock.writeFileSync.mockImplementation((target: string, content: string) => {
        files.set(String(target), String(content));
      });
      const list = await taskTool.execute("3", { action: "list" }, undefined, undefined, ctx);
      expect(list.details.tasks).toHaveLength(1);

      errorSpy.mockRestore();
    });

    it("rolls back state on clear save failure", async () => {
      const api = setupExtension();
      const ctx = createCtx();
      const taskTool = api.tools.get("task");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await api.emit("session_start", {}, ctx);
      await taskTool.execute("1", { action: "add", text: "task1" }, undefined, undefined, ctx);
      await taskTool.execute("2", { action: "add", text: "task2" }, undefined, undefined, ctx);

      // Make writes fail
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("disk full");
      });

      const result = await taskTool.execute("3", { action: "clear" }, undefined, undefined, ctx);
      expect(result.details.error).toBe("save failed");

      // State should be rolled back - tasks should still exist
      fsMock.writeFileSync.mockReset();
      fsMock.writeFileSync.mockImplementation((target: string, content: string) => {
        files.set(String(target), String(content));
      });
      const list = await taskTool.execute("4", { action: "list" }, undefined, undefined, ctx);
      expect(list.details.tasks).toHaveLength(2);

      errorSpy.mockRestore();
    });
  });
});
