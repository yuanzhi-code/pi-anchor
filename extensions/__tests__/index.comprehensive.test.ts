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
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
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
      expect(lastWrite[0]).toBe(taskFile("bad/session:id?") + ".tmp");

      expect(fsMock.renameSync).toHaveBeenCalledWith(
        taskFile("bad/session:id?") + ".tmp",
        taskFile("bad/session:id?")
      );

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
    it("validates /tasks limit input", async () => {
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
});
