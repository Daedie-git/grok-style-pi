# subagent-engine

Claude Code–style subagents for [Pi](https://pi.dev), running in-process. The model delegates work to child agents on its own: it picks an agent type, writes a brief, runs independent agents in parallel, continues them with messages, and gets notified when they finish. Each subagent is a full Pi `AgentSession` in the same process. It has its own identity, transcript, tools and model, and it can survive `/reload`.

The behavior follows Claude Code 2.1.303's subagent orchestration. It was reconstructed from that release's behavior and re-implemented from scratch: none of Claude Code's code or prompt text is included. It needs Pi 1.1.0 or newer and Node 22.18+ on the 22.x line, or Node 24+.

## Install

```bash
pi install /path/to/grok-style-pi/packages/subagent-engine
```

Grok users get the engine through `integrations/subagents.ts` instead. Load exactly one of the two.

## Tools

| Tool | Purpose |
|---|---|
| `Agent` | Launch an agent. Parameters: `description`, `prompt`, `subagent_type` (default `general-purpose`), `model`, `effort`, `run_in_background` (default `true`), `name`, `isolation: "worktree"`. Inside Herdr, `keep` keeps a pane agent's pane open after it finishes; it does not select the pane backend or affect in-process agents. |
| `SendMessage` | `{to, message, summary?}`. A running agent gets the message after its current tool round. A finished agent resumes the same conversation in a new run. `to: "main"` reaches the root conversation. |
| `TaskStop` | Stop an agent. The main conversation can stop any agent; an agent can stop only itself. A stop by the user (Grok activity panel) also stops the agent's descendants, and none of them resume automatically. |
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | A shared task list. Every agent of the root session sees the same list. `owner` is a plain assignment; completed blockers are hidden in `TaskList`. |
| `Workflow` (alias `RunWorkflow`) | Run a JavaScript orchestration script in the background (see below). Launched only on explicit request. |
| `get_subagent_result`, `steer_subagent` | Compatibility aliases for earlier runners. Set `PI_SUBAGENT_ALIASES=0` to disable them. |

Background agents report through a `subagent-notification` message. If the main conversation is idle, the notification starts a new turn; if it's busy, the notification arrives at the next safe point. A foreground `Agent` call returns the report directly, and the child's token usage counts toward the parent's session totals.

## Agent types

Built-in types:

- **`general-purpose`** has the parent's tools.
- **`Explore`** locates code and is read-only.
- **`Plan`** produces an implementation plan and is read-only.
- **`fork`** inherits the conversation, system prompt, model and tools. It's off by default; enable it with `PI_SUBAGENT_FORK=1`.

To add your own, write markdown files with frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model`, `effort`, `skills`, `maxTurns`, `background`, `keep`, `isolation`, `memory`, `hooks`, `mcpServers`, `omitClaudeMd`, and `isolated` (or Herdr's legacy `extensions: false`), which limits the agent to built-in tools; `max_turns` is accepted for `maxTurns`. Definitions are found in these places, lowest priority first:

1. Built-in
2. Package
3. User: `~/.pi/agent/agents/*.md`
4. Project: `.pi/agents`, `.claude/agents` and `.agents/agents` in the project and its parent folders. A deeper folder wins. Untrusted projects are skipped.
5. Command line: `PI_AGENTS_JSON`
6. Managed policy: `PI_AGENTS_POLICY_DIR`

For Herdr panes, agent-file `keep: true` defaults to keeping the pane open after the agent finishes. An explicit `Agent.keep` overrides this default, including `false`; pinning persists across resumes. Owner-gone cleanup still applies. In-process agents ignore `keep`.

The tool language matches Claude's. `Read`, `Bash`, `Glob` and similar names map to Pi's tools. `Agent(Explore, Plan)` limits which types an agent may launch, and `mcp__server` names a whole MCP server. A deny always wins over an allow.

Skills whose frontmatter sets `context: fork` run as their own agents. The model launches one with `subagent_type: "skill:<name>"`; you launch one with `/skill:<name> [arguments]`. Skills with `disable-model-invocation` can only be launched by you.

## Behavior worth knowing

- **Reasoning defaults.** General-purpose, explore and implementer roles default to `medium`; review, research and plan roles default to `high`. Explicit invocation or definition effort overrides these defaults, and `PI_SUBAGENT_EFFORT` overrides all three. Other roles inherit the parent's effort; forks always inherit it.
- **Delegation policy.** The engine adds delegation guidance to the system prompt, and the list of available agent types is recorded in the session as `agent-listing` entries that show only what changed. Set `PI_SUBAGENT_AUTONOMY=explicit`, or use the Grok setting, if agents should launch only when you ask.
- **Limits.**
  - At most 20 agents run at once (`PI_MAX_CONCURRENT_SUBAGENTS`), and agents nest at most 3 levels deep (`PI_MAX_SUBAGENT_SPAWN_DEPTH`). A launch over a limit is refused, not queued.
  - Background agents keep `Agent` while below the depth limit. They don't get `TaskCreate`, `TaskGet` or `TaskUpdate`.
  - `maxTurns` ends an agent after its last allowed turn without another model request.
- **Failed continuations.** If a continuation fails before delivering its messages, those messages remain unread without repeatedly retrying themselves. A new message or wake can retry the conversation with all input already waiting.
- **Parking.** An agent whose own children are still running waits for them, and its report waits too. A child's report wakes the waiting parent agent.
- **Worktrees.** `isolation: "worktree"` gives the agent its own git worktree on branch `agent-<id>`. When the agent finishes with no changes, the worktree is removed. If it changed anything, the worktree and branch are kept for you to inspect. Nothing is committed on the agent's behalf. A worktree is not a security sandbox.
- **Hooks.** `~/.pi/agent/hooks.json`, `.pi/hooks.json` (trusted projects only) and a definition's `hooks` use Claude's command-hook format. Supported events:
  - `SubagentStart` adds context.
  - `SubagentStop` with `decision:"block"` sends feedback and continues the agent; `continue:false` stops it. Blocks are capped at 8 (`PI_STOP_HOOK_BLOCK_CAP`).
  - `TaskCreated` and `TaskCompleted` can veto.
- **Memory.** A definition with `memory: user|project|local` gets a `MEMORY.md` index in its prompt, plus read and write access limited to its memory folder.
- **`/reload`.** Running agents carry over to the reloaded extension. After a restart, agents from the session can still be resumed with `SendMessage`. Runs that were active when the process ended are marked failed.
- **Other extensions.** Extensions can launch agents through `pi.events.emit("subagent-engine:register", { extensionId, reply })`. The per-extension limit relies on each extension honestly reporting its own ID.
- **Auto-background.** Set `PI_AUTO_BACKGROUND_TASKS=1` to move a foreground agent to the background after 120 s. It stays in the foreground while later tool calls from the same message are waiting.

## Workflow

`Workflow` runs a script that coordinates several agents. The script starts with a literal `export const meta = { name, description, phases }`, and its body uses:

- `agent(prompt, opts)` returns the agent's final text, or validated data when `opts.schema` is set. If the agent fails, it returns `null`.
- `parallel([() => ...])` runs all its callbacks, keeps their order, and never fails fast.
- `pipeline(items, ...stages)` runs the stages in order for each item; `null` skips the rest of that item's stages.
- `phase(title)` groups progress.
- `workflow(name | {scriptPath}, args)` runs one nested workflow.
- `log` and `budget` record output and report token use.

Where scripts come from and who approves them:

- **Inline and file scripts** need your approval of the exact text, unless you set `PI_WORKFLOW_APPROVE=1`.
- **Saved workflows** run without asking. They are `.js` files in `~/.pi/agent/workflows` and in the project's `.pi/workflows` and `.claude/workflows` folders, the project ones only when the project is trusted.

How runs behave:

- **Agents and concurrency.** Each `agent()` is a normal engine agent, but it can't use `Agent` or `Workflow` itself. At most `min(16, max(2, cores - 2))` agents run at once (`PI_WORKFLOW_CONCURRENCY`), and a run makes at most 1,000 agent calls.
- **Determinism.** `Date.now()`, `new Date()` without arguments, and `Math.random()` are unavailable, so a run can be replayed.
- **Resume.** `resumeFromRunId` re-runs the script from the start. Completed `agent()` calls whose prompt and options haven't changed return their saved results instantly; edited or new calls run again. Stop the old run with `TaskStop` first.
- **Not a sandbox.** Scripts run in a restricted VM inside the Pi process.

## Known differences from Claude Code

- No cloud `isolation: "remote"`. The Herdr backend's `machine` option fills that role.
- No legacy teammates or cross-session messaging, and no `ListAgents` tool.
- Pi has no permission modes, so `permissionMode` is ignored with a diagnostic.
- Only command hooks are supported.
- Background usage is shown in notices but isn't added to Pi's own session totals.
- Parent tools that exist only at runtime can't be copied into a fork; the missing names are recorded.
- The Explore model cap is opt-in.
- The delegation thresholds in the guidance are rules of thumb, not measured savings.
- Workflow: no cloud remote workflows or server-delivered launches, and no reactive (v2) API. Resuming waits until every agent call and journal write from the previous run has finished, a stricter rule than Claude Code's. The VM bounds synchronous script code but doesn't fully harden async boundaries.

## Development

```bash
npm test --workspace subagent-engine
```

The end-to-end tests run real Pi `AgentSession`s with scripted fake models and need no network.
