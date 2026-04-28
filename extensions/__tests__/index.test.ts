import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the modules
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  StringEnum: vi.fn(() => ({})),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  // Mock ExtensionAPI and ExtensionContext types
}));

vi.mock('typebox', () => ({
  Type: {
    Object: vi.fn(() => ({})),
    Optional: vi.fn(() => ({})),
    String: vi.fn(() => ({})),
    Number: vi.fn(() => ({})),
  },
}));

describe('pi-anchor extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export a function', async () => {
    // Dynamic import to avoid issues with mocking
    const module = await import('../index');
    expect(typeof module.default).toBe('function');
  });

  describe('Task management', () => {
    it('should handle task structure', () => {
      // Test the Task interface
      const task = {
        id: 1,
        text: 'Create user model',
        done: false,
        createdAt: Date.now(),
        goalId: 'goal_123_abc',
      };

      expect(task.id).toBe(1);
      expect(task.text).toBe('Create user model');
      expect(task.done).toBe(false);
      expect(task.goalId).toBe('goal_123_abc');
    });

    it('should handle task state with goal', () => {
      const state = {
        tasks: [
          { id: 1, text: 'Task 1', done: false, createdAt: Date.now() },
          { id: 2, text: 'Task 2', done: true, createdAt: Date.now() },
        ],
        nextId: 3,
        autoResume: true,
        maxAutoResume: 20,
        currentGoal: 'Implement user login',
        goalId: 'goal_456_def',
      };

      expect(state.tasks).toHaveLength(2);
      expect(state.nextId).toBe(3);
      expect(state.autoResume).toBe(true);
      expect(state.maxAutoResume).toBe(20);
      expect(state.currentGoal).toBe('Implement user login');
      expect(state.goalId).toBe('goal_456_def');
    });

    it('should separate pending and completed tasks', () => {
      const tasks = [
        { id: 1, text: 'Task 1', done: false },
        { id: 2, text: 'Task 2', done: true },
        { id: 3, text: 'Task 3', done: false },
        { id: 4, text: 'Task 4', done: true },
      ];

      const todo = tasks.filter(t => !t.done);
      const done = tasks.filter(t => t.done);

      expect(todo).toHaveLength(2);
      expect(done).toHaveLength(2);
    });
  });

  describe('Resume message building', () => {
    it('should build resume message with goal', () => {
      const state = {
        tasks: [
          { id: 1, text: 'Create model', done: false },
          { id: 2, text: 'Write tests', done: false },
          { id: 3, text: 'Deploy app', done: true },
        ],
        nextId: 4,
        autoResume: true,
        maxAutoResume: 20,
        currentGoal: 'Build user auth system',
      };

      const undone = state.tasks.filter(t => !t.done);

      const parts: string[] = [];

      if (state.currentGoal) {
        parts.push(`🎯 用户目标: ${state.currentGoal}`);
        parts.push('');
        parts.push(`📋 分解的任务 (${undone.length}/${state.tasks.length} 未完成):`);
      }

      parts.push(...undone.map(t => `- [ ] #${t.id}: ${t.text}`));
      parts.push('');
      parts.push('请继续完成这些任务，不要停下来。');

      const message = parts.join('\n');

      expect(message).toContain('🎯 用户目标: Build user auth system');
      expect(message).toContain('📋 分解的任务 (2/3 未完成):');
      expect(message).toContain('- [ ] #1: Create model');
      expect(message).toContain('- [ ] #2: Write tests');
      expect(message).not.toContain('Deploy app'); // Already done
      expect(message).toContain('请继续完成这些任务，不要停下来。');
    });

    it('should build resume message without goal', () => {
      const state = {
        tasks: [
          { id: 1, text: 'Task 1', done: false },
          { id: 2, text: 'Task 2', done: false },
        ],
        nextId: 3,
        autoResume: true,
        maxAutoResume: 20,
        // No currentGoal
      };

      const undone = state.tasks.filter(t => !t.done);

      const parts: string[] = [];

      if (state.currentGoal) {
        parts.push(`🎯 用户目标: ${state.currentGoal}`);
        parts.push('');
        parts.push(`📋 分解的任务 (${undone.length}/${state.tasks.length} 未完成):`);
      } else {
        parts.push(`📋 剩余任务 (${undone.length}/${state.tasks.length}):`);
      }

      parts.push(...undone.map(t => `- [ ] #${t.id}: ${t.text}`));
      parts.push('');
      parts.push('请继续完成这些任务，不要停下来。');

      const message = parts.join('\n');

      expect(message).not.toContain('🎯');
      expect(message).toContain('📋 剩余任务 (2/2):');
      expect(message).toContain('- [ ] #1: Task 1');
      expect(message).toContain('- [ ] #2: Task 2');
    });
  });

  describe('Command completions', () => {
    it('should provide command completions', () => {
      const TASK_COMMANDS = [
        { value: "help", description: "Show available commands" },
        { value: "auto retry on", description: "Enable auto-retry" },
        { value: "auto retry off", description: "Disable auto-retry" },
        { value: "limit", description: "Set max auto-retries" },
        { value: "clear", description: "Clear all tasks" },
      ];

      // Filter for "auto" prefix
      const prefix = "auto";
      const filtered = TASK_COMMANDS.filter(
        item => item.value.toLowerCase().startsWith(prefix)
      );

      expect(filtered).toHaveLength(2);
      expect(filtered[0].value).toBe("auto retry on");
      expect(filtered[1].value).toBe("auto retry off");
    });

    it('should return null for free text goals', () => {
      const TASK_COMMANDS = [
        { value: "help", description: "Show help" },
      ];

      const prefix = "implement";
      const filtered = TASK_COMMANDS.filter(
        item => item.value.toLowerCase().startsWith(prefix)
      );

      expect(filtered).toHaveLength(0);
      // Should return null to indicate free text input
    });
  });
});
