# Anchor (pi-anchor)

> Anchor your tasks — stay on track, miss nothing, and push through to completion.

A persistent task plugin for [Pi](https://pi.dev) with an auto-retry mechanism. When the AI is idle or context is compressed, it pulls the AI back to unfinished tasks like a ship's anchor, preventing the project from "drifting away."

## Core Philosophy

- **Users only set goals** — describe what you want in natural language
- **AI handles decomposition** — breaks big goals into executable small steps
- **Auto-progressive push** — reminds automatically when idle until all tasks are done

## Installation

```bash
# Global install
pi install npm:pi-anchor

# Local install
pi install -l npm:pi-anchor
```

## Usage

### Basic Commands

```text
/anchor <goal>           Set a goal, AI auto-decomposes into tasks
/anchor                  View current status and task list
/anchor help             Show help
/anchor auto on|off      Enable/disable auto-retry (also: auto retry on|off)
/anchor limit <n>        Set max auto-retry count
/anchor clear            Clear all tasks and goal
```

### Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  User: /anchor implement user login                         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  System: Goal set. Asking AI to decompose tasks...          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  AI auto-decomposes and adds tasks:                         │
│    ✓ #1 Create user data model                              │
│    ✓ #2 Implement password hashing                          │
│    ✓ #3 Create login API endpoint                           │
│    ✓ #4 Add JWT token generation                            │
│    ✓ #5 Write unit tests                                    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  AI completes each task step by step, marking them done     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  ⏰ Auto-retry: reminds automatically when tasks remain     │
└─────────────────────────────────────────────────────────────┘
```

### Viewing Status

```
User: /anchor

Display:
  ⚓ Tasks · ⏳ 3/5 pending · auto retry on · limit: 20
  
    🎯 Goal: Implement user login
  
    📋 Pending (3):
      □ #3 Create login API endpoint
      □ #4 Add JWT token generation
      □ #5 Write unit tests
    
    ✅ Completed (2):
      ✓ #1 Create user data model
      ✓ #2 Implement password hashing
```

### Command Autocompletion

After typing `/anchor`, dynamic hints for available commands are shown:

```
> /anchor
┌─────────────────────────────────────────────────┐
│ help             Show available commands        │
│ auto on          Enable auto-retry              │
│ auto off         Disable auto-retry             │
│ auto retry on    Enable auto-retry (full syntax)│
│ auto retry off   Disable auto-retry (full syntax)│
│ limit            Set max auto-retries           │
│ list             Show current task list         │
│ clear            Clear all tasks and goal       │
└─────────────────────────────────────────────────┘
```

Partial input auto-filters:
```
> /anchor au
┌─────────────────────────────────────────┐
│ auto on          Enable auto-retry      │
│ auto off         Disable auto-retry     │
│ auto retry on    Enable (full syntax)   │
│ auto retry off   Disable (full syntax)  │
└─────────────────────────────────────────┘
```

Any other input is treated as a goal:
```
> /anchor implement user login
→ Set goal, trigger AI decomposition
```

### Auto-Retry Mechanism

When the AI finishes a turn, if there are unfinished tasks, a reminder is automatically injected:

```
🎯 User Goal: Implement user login

📋 Decomposed Tasks (3/5 pending):
- [ ] #3: Create login API endpoint
- [ ] #4: Add JWT token generation
- [ ] #5: Write unit tests

3 task(s) remaining. Let's keep going.
```

### State Files

Tasks are stored per session in the project directory:

```
your-project/
├── .pi/
│   └── tasks/
│       └── <session-id>.json
└── ...
```

JSON structure:
```json
{
  "tasks": [
    {
      "id": 1,
      "text": "Create user model",
      "done": false,
      "createdAt": 1234567890,
      "goalId": "goal_123_abc"
    }
  ],
  "nextId": 2,
  "autoResume": true,
  "maxAutoResume": 20,
  "currentGoal": "Implement user login",
  "goalId": "goal_123_abc"
}
```

## Development

### Local Testing

```bash
# Method 1: Build, then install from local path
cd /Users/yuanzhi/code/pi-task-persistence
npm install --legacy-peer-deps
npm run build
cd /path/to/test-project
pi install -l /Users/yuanzhi/code/pi-task-persistence
pi

# Method 2: Load extension source directly
cd /path/to/test-project
pi -e /Users/yuanzhi/code/pi-task-persistence/extensions/index.ts
```

### Verification Checklist

| # | Action | Expected Result |
|---|--------|-----------------|
| 1 | Type `/anchor` | Show status and dynamic command hints |
| 2 | Type `/anchor implement login` | Set goal, show "Asking AI to decompose..." |
| 3 | View TUI widget | Show goal and task list |
| 4 | Observe AI behavior | AI auto-calls task tool to add tasks |
| 5 | Wait for AI finish | Auto-retry reminder injected |
| 6 | AI continues tasks | Tasks marked done progressively |

### Uninstall

```bash
pi remove /Users/yuanzhi/code/pi-task-persistence
```

## Design Philosophy

- **Goal-driven**: Users just say what they want; AI plans how to do it
- **Continuous push**: Through auto-retry, tasks are never forgotten
- **Incremental completion**: Big goals decomposed into small tasks, done step by step
- **Context persistence**: Goals and tasks are persisted and auto-restored after restart

## License

MIT
