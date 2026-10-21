# Plan: Claude Code–style subagent engine for Pi (v2)

Status: v2, revised after a four-way REA audit (2026-10-21). Target behavior is Claude Code 2.1.303.

Sources:
- Dossier: `C:/git/claude-sidecar/analysis/claude-code-2.1.303/`
- Recovered shipped JS: `C:/git/claude-sidecar/.scratch/claude-multiagent-analysis/` (WORK)
- Audit findings (slot/number): definitions/context = D1–D9, lifecycle = L1–L11, messaging/tasks = M1–M8, autonomy/hooks = A1–A11. Each requirement below names the finding it resolves.

## Fixed user decisions

- **Architecture:** an in-process engine on Pi's `createAgentSession`, plus interchangeable backends. Herdr panes become the second backend. The engine replaces `@tintinweb/pi-subagents`.
- **Public tool surface:** Claude Code 2.1.303: `Agent`, `SendMessage`, `TaskStop`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`. The aliases `get_subagent_result`, `steer_subagent` and `Agent.resume` remain.
- **In scope:** fork, worktree isolation, the shared task list, hooks (SubagentStart/Stop, TaskCreated/Completed), live steering, and agent memory.
- **Autonomous delegation:** the Claude Code positive-delegation profile (A3) is the default. A setting restores explicit-request-only mode.
- **Clean room:** original code and prose only.
- **Public Pi APIs only:** no private-field casts (D1).

## Fidelity profile and declared deviations

Claude Code's behavior varies with subscription, feature flags and mode. This clone targets: the default (non-lean, non-Pro, non-coordinator) profile, fork enabled, task tools enabled, and legacy teams disabled.

Deliberate deviations:
- Cloud `isolation:"remote"`, legacy teammates (TeamCreate, mailboxes, the shutdown protocol), cross-session sockets, and `ListAgents` are excluded. The Herdr `machine` option stands in for remote execution.
- Pi has no permission modes. `permissionMode` is parsed and reported as unsupported.
- Only command hooks are supported. Prompt, agent and HTTP hook types are rejected with a diagnostic (A6).
- Worktrees are created with `git worktree add`. Hook-created worktrees are not supported (L3).
- Optional forwarded parent intent (D5) is not implemented. Effort environment states `unset`/`auto` and numeric effort are simplified as described in §2.4 (D6).
- The conditional built-ins `statusline-setup`, `claude-code-guide`, `web-fetch` and `worker` are omitted (A2).
- Delegation heuristics (context flooding, the >3-query Explore route) are cloned as behavioral guidance. They are not claimed as measured savings (A11, L-measure).

## 0. Runtime foundations (D1, D2, L5)

- **Model runtime.** One `ModelRuntime` per root session, built with the public `createAgentSessionServices({cwd, agentDir})`. It reproduces auth.json credentials, models.json and extension-registered providers. It lacks providers that were registered only at runtime by CLI flags or inline factories. That gap is documented; a child whose parent model is missing from the runtime fails with a clear error. The private `modelRegistry.runtime` is never read. Separately, we file an upstream request for a public accessor.
- **Child capability installation.**
  - The engine's package entry returns early inside a child (AsyncLocalStorage `inChildContext`).
  - Children instead receive an explicit **child installer**, an `InlineExtension` passed through the resource loader's `extensionFactories`. It registers `Agent` (when the depth policy allows it), `SendMessage`, `TaskStop`, the task tools, the policy handlers (`tool_call` enforcement, turn budget, hooks), and the listing refresh. All of these are bound to the *shared* root engine services: registry, task store, outbox and runtime.
  - Other extensions load normally in the child, through its own `DefaultResourceLoader` and inheriting project trust.
  - The engine forwards Pi's codemode, tool-search and MCP factories (`createCodemodeExtension` etc.) when the parent has them enabled, because SDK sessions don't install them by default.
  - Grok's package exports `inChildContext` so its chrome no-ops inside children.
- **Ownership generations.** Every root session gets `ownerKey = {sessionId, runtimeGeneration}`. The generation increments on each `session_start` (startup, reload, new, resume, fork). Captured `ctx`/`pi` handles are only used through the current generation's binding.
- **Shutdown.**
  - `reload`: background children are detached and persisted, then reattached by agentId when the new generation starts. Notices are re-delivered from the durable outbox.
  - `new`/`resume`/`fork`/`quit`: running children are cancelled with source `session-end`. The sequence is abort → await settle (bounded, 5 s) → emit child `session_shutdown` → `dispose`. Each terminal record is persisted before disposal.

## 1. Definitions (D4, D9, A2)

- **Sources**, in increasing priority:
  1. built-in
  2. package-declared
  3. user (`<agentDir>/agents`)
  4. project: `.pi/agents`, `.claude/agents` and `.agents/agents` in additional dirs, then ancestors shallow→deep, stopping at home or the project root
  5. flag (`--agents` JSON / `PI_AGENTS_JSON`)
  6. managed policy dir

  The last assignment by exact `agentType` wins. An untrusted project skips project sources. Inode deduplication applies where supported. Duplicates produce diagnostics.
- **Validation:**
  - `name` and `description` are required strings.
  - A name may not start with `-`, contain a colon (reserved for the `plugin:ns:name` package namespace), or be over-long.
  - `inherit` (case-insensitive) is the parent's model.
  - Tools omitted, or a list containing `*`, inherit. An explicit `[]` means no tools.
  - Package-sourced definitions ignore `hooks`, `mcpServers` and `permissionMode`.
- **Selection:** an exact name, then a normalized name. An ambiguous normalized name is an error. A user definition named `fork` never gets built-in fork semantics. Built-in fork is gated by setting/env, and is unavailable if a user definition named `fork` collides with it.
- **Frontmatter:**

  | Field | Notes |
  |---|---|
  | `name`, `description` | |
  | `tools`, `disallowedTools` | Claude tool language |
  | `model`, `effort`/`thinking` | |
  | `skills` | Preloaded |
  | `maxTurns` | |
  | `background` | |
  | `isolation: worktree` | |
  | `memory: user\|project\|local` | |
  | `hooks` | |
  | `mcpServers` | Names or inline |
  | `omitClaudeMd` | |
  | `color` | |
  | `permissionMode` | Diagnostic only |
- **Built-ins.** Original prose with equivalent behavioral contracts (A2):
  - `general-purpose`: full tools. It finishes its assigned scope, avoids unnecessary new files and unsolicited docs, and never hands its whole assignment to another worker.
  - `Explore`: read/search/nonmutating shell, with `edit`, `write` and `Agent` removed. It *locates* code rather than auditing or reviewing it. It honors a quick / medium / very-thorough breadth hint and returns findings inline, never as report files. `omitClaudeMd` is set. In the original, the inherited model has an Opus-family ceiling, applied when the catalog ranks the parent above it. Pi has no equivalent catalog, so this becomes `exploreModelCap` (a model id), off by default. That is a declared deviation (A7').
  - `Plan`: read-only like Explore. It inspects the supplied files and existing patterns, weighs trade-offs, and returns an implementation sequence plus 3–5 critical file paths. `omitClaudeMd` is set. It inherits the parent model with no cap.
  - `fork`: never the default. It inherits the parent's model, effort, system prompt and exact tools, and has `maxTurns: 200`. Its directive says to treat inherited history as reference, perform exactly one directive, never delegate, return once with no follow-up questions or proposed next steps, and report commit hashes when it commits.
  - Prose states that shell access is not a read-only security guarantee.

## 2. Context compilation

### 2.1 Fresh child (D5, A8)
- The system prompt is the definition body inside an original wrapper with these parts:
  - Absolute-path and cwd guidance.
  - Authority: the delegation and later steering *direct the work*, but cannot supply user consent or authorize changes to permissions, configuration or instruction files.
  - Final-report guidance.
  - An environment block.
- AGENTS.md/CLAUDE.md context files are admitted unless `omitClaudeMd` is set. When it is set, only managed-policy instructions are kept.
- Skills listed in `skills` are **preloaded** as meta user messages before the task, bounded in size and deduplicated on continuation. Pi's discoverable-skill listing stays as well.
- Agent memory is primed into the prompt (§11).
- The parent conversation is never included.

### 2.2 Fork child (D8, L4)
- Snapshot the parent's branch at an **immutable leaf**: the entry ID at the time of the Agent call.
- Repair the snapshot to build a **persistent** child session:
  1. Write a new header (new id, `parentSession` as lineage only), then the root→leaf entries.
  2. Rechain `parentId`s over removed entries.
  3. Remove assistant entries containing tool calls without results.
  4. Keep compaction entries whose `firstKeptEntryId` survives. Otherwise materialize the summary as a compaction at the new chain head.
  5. Apply context edits into the copied content.
  6. Append a copy of the spawning assistant message with synthetic `toolResult`s for all its tool calls (fork placeholders), then the fork directive.

  **v3 correction to the order (L2'):**
  1. First partition out the spawning assistant entry *and all of its result entries*. Some sibling tools may already have finished.
  2. When an older assistant is removed, remove its result entries too.
  3. Build exactly one repaired call/result group for the spawning message, using **placeholder results for every call** in it, including siblings that already finished. This matches the original, so the fork's context does not depend on when siblings complete.
  4. Only then rechain `parentId` over the final entry list.

  Required fixture: a sibling Read call that already finished, plus a sequential batch.
- The child's session file is created with `SessionManager.open(path)`. It is canonical and resumable after a full dispose.
- A fork inherits the parent's rendered system prompt, its model, its thinking level and its tool surface. Overrides are ignored.
  - **Prompt (v3, N3):** the exact rendered text is supplied through the child installer's `before_agent_start` returning `{systemPrompt}` (Pi `forceSystemPrompt`), registered last. Every child run is started through `prompt()`, so the forced prompt applies to every run. Tests assert the outgoing system text for the initial run, a notification-driven run and a resumed run. The loader's `systemPromptOverride` is **not** used, because Pi treats it as a preamble.
  - **Tools:** these are reproduced by the child installer plus forwarded built-in factories. Parent tools that exist only inline or at runtime cannot be reproduced through the public API. That is a declared deviation (D2'). The child gets the closest reproducible set, and the missing names are listed in its meta file.
- Fork inside fork and fork with a remote machine are refused. A path-translation note is added whenever the inherited context root differs from the child's effective root, for example when an ordinary checkout launches a child into a new worktree (N5).

### 2.3 Tool surface (D3, D4, A1)
- **Capability compiler.** Claude tool language is mapped onto the Pi tool names, with these rules:
  - Canonical aliases: `Read→read`, `Bash→bash`, `Edit→edit`, `Write→write`, `Grep→grep`, `Glob→find`, `LS→ls`, `PowerShell→powershell`; extensible.
  - `Agent(typeA,typeB)` grants `Agent` and restricts it to those types.
  - `mcp__server` expands to every tool from that server; `mcp__server__tool` names one tool.
  - `*` means inherit.
  - Unknown names produce an "invalid" diagnostic; known but absent names produce "unavailable".
- **Ordered availability filter:**
  - `Agent` is allowed iff `depth < maxDepth`, decided before any background rule. Background agents keep it.
  - Main-thread-only tools (the task-list *claim*-style UI tools, if any, and `/` command tools) are excluded.
  - Plan mode is not applicable.
- **Then** definition denies, **then** allow selection. Denies win.
- **Definition MCP servers** are connected per child and added after selection, with denies applied and names deduplicated. Engine-created clients are closed on cleanup; shared session clients are never closed by a child.
- **Enforcement** uses three mechanisms:
  - The session's `excludeTools` (never a strict `tools` allowlist, which would drop late-registered MCP tools).
  - A child `tool_call` block for nested calls.
  - Narrowing again on `turn_end`.

### 2.4 Model and effort (D6)
- **Model:**
  1. invocation `model` (alias or Pi provider/id)
  2. definition model
  3. `PI_SUBAGENT_MODEL`
  4. the parent's current model

  Definition `inherit` skips the env value. `PI_SUBAGENT_MODEL_FORCE` overrides everything. An unavailable model falls back to the parent model and records the reason.
- **Effort** (separate contract):
  1. `PI_SUBAGENT_EFFORT` env (`low|medium|high|xhigh|max`)
  2. invocation `effort`
  3. definition effort
  4. role default
  5. the parent's thinking level

  The Claude→Pi mapping is identity for the shared names. Pi levels `off|minimal` are accepted. The value is clamped with `clampThinkingLevel`. Requested and effective values are both recorded.
- **Fork** inherits both and ignores overrides.
- **Models used** are recorded per assistant message. Only *adjacent* duplicates are deduplicated.

### 2.5 Turn budget (D7, A5)
- The engine owns a per-run budget, checked in the child's `turn_end` handler before Pi makes another request. Hitting it steers the run to stop, then aborts it after the current turn.
- What counts:
  - Ordinary tool turns count.
  - Stop-hook retries count.
  - The opening turn of a continuation starts a new run budget.
- `maxTurns` reached produces the `max_turns` terminal classification, with a partial result (§6).

## 3. Registry and admission

### 3.1 Records
- **Agent conversation:** `agentId`, `parentAgentId` (ancestry, immutable), `ownerAgentId` (who receives notices; may change on continuation, L1), `rootOwnerKey`, `depth`, a definition snapshot, `sessionFile`, `metaFile`, `taskListId` (M4), `name`, `stopGeneration`, `stoppedByUser`, `retain`, `pinned`.
- **Run:** `runId`, `agentId`, status `running|completed|failed|killed`, and a `blocked` substate for backends that report it (L2). Flags: `isBackgrounded`, `isIdle`, `parked`, `resuming`, `finalizing`, `notified`. Also a controller, a keepalive-reason set, a terminal classification, `killedBy` (`user|parent|session-end|watchdog`), metrics, and start and end times.
- Runs are persisted as **immutable run summaries** (start/end entry IDs, classification, bounded result, usage) in the meta file (L10).

### 3.2 Admission (L8)
- The cap is 20 (`PI_MAX_CONCURRENT_SUBAGENTS`, a positive integer). `maxDepth` is 3 (`PI_MAX_SUBAGENT_SPAWN_DEPTH`).
- **Check-and-reserve happens synchronously before any asynchronous setup**, and applies to fresh spawns, continuations and notification-driven resumes alike.
- The spawner's identity and stop state are revalidated after setup: a stopping spawner is refused.
- Release is idempotent and happens on every failed start.
- Depth comes from ancestry, not from the owner.

### 3.3 Retention (L10)
- A terminal run is evicted from memory 30 s after it is both terminal and notified, with no keepalives, and only if neither `retain` nor `pinned` is set.
- Eviction drops only the live session object and the cached transcript. Conversation metadata and run summaries persist, so `get_subagent_result(run_id)` works after a later run or a registry rebuild.
- Persisted files are never deleted by the engine.

## 4. Execution lifecycle

### 4.1 Contract (L2, M8)
- Backends implement `launch`, `deliver(message)`, `cancel(reason, source)`, `observe → BackendEvent`, `cleanup`, and declare `capabilities {liveDelivery, continuation, blockedState, maxTurns, worktree, fork}`.
- `BackendEvent` covers `started|progress|blocked|unblocked|turn|settled{classification}|cancel-acknowledged`.
- A cancellation is *requested* until the backend acknowledges it. Admission and ownership are released only on acknowledgement.

### 4.2 In-process backend
- **Run completion** is recorded at `agent_settled` or when `prompt()` resolves, never at `agent_end` (Pi can retry after `agent_end`) (L5, M1).
- **Foreground/background**
  - A foreground run races completion against the background signal.
  - Handing off detaches the parent-abort relay without restarting the run.
  - After the background race is won, terminal state is rechecked; a run that already finished returns its completed result (L7).
- **Auto-background** (opt-in through `PI_AUTO_BACKGROUND_TASKS`) fires at 120 s. It is suppressed while a sequential/exclusive tool call is queued behind `Agent` in the parent's batch, and retried every 1 s while the parent is still streaming (L7). Timers and relays are cleared on every exit.
- **Background default:** Agent calls default to the background unless `run_in_background:false` is passed. A definition's `background:true` forces the background.
- **Watchdog** (L11):
  - **Default:** 600 s, or `PI_SUBAGENT_STALL_TIMEOUT_MS`.
  - **Progress sources:** `message_update` deltas, `tool_execution_*`, `auto_retry_*`, `compaction_*` and `turn_*`.
  - **While tools run:** expiry is deferred.
  - **On expiry:** the run is parked if it has a keepalive. Otherwise it is aborted and fails with classification `stalled`.

### 4.3 Parking and keepalives (L1)
- When a run's model loop settles while it still owns live child agents, the run becomes `parked`, not completed.
  - Its own completion notice is withheld.
  - Its session stays alive, and teardown is deferred.
  - It holds keepalive reason `child:<agentId>` per live child.
- When a child's notice targets a parked owner, the owner is **resumed** with that notice as its next input. This runs through admission and single-flight resume.
- When the last keepalive is released and the owner settles with no pending inbox, the owner completes and notifies its own owner.
- If the owner exits, is cancelled or is evicted, its stranded child notices are rerouted to the owner's owner, and ultimately to the root.

### 4.4 Cancellation and TaskStop (M2)
- `TaskStop {task_id?, shell_id?}`. The deprecated `shell_id` and the aliases `KillShell`/`KillBash` are accepted.
- **Resolution:** a run or agent ID first, then a name. Ambiguous, missing, unauthorized and non-running targets are refused.
- **Authorization:** a caller may stop only agents in its own owner subtree. The root may stop anything in its session.
- **Classification:** a model-requested stop is `killedBy: parent`. A user stop (activity panel Stop, `/agents stop`, Escape on a foreground run) is `killedBy: user`. It persists `stoppedByUser` before eviction and increments `stopGeneration`.
- **Teardown:**
  1. Mark cancellation requested.
  2. Abort the controller.
  3. Cancel the agent's descendants (source `parent`).
  4. Await settle.
  5. Persist the terminal state.
  6. Notify.
  7. Release resources.

  `finish()` is idempotent and guarded by run identity, so late output never overwrites a cancellation, and a blocking stop hook cannot revive an aborted run.
- Shell/background command tasks are out of TaskStop's scope; it targets agents only. The tool says so.

## 5. Transcripts and metadata

- Files live at `<agentDir>/subagents/<rootSessionId>/agent-<agentId>.jsonl` (a Pi session file opened with `SessionManager.open`), with `agent-<agentId>.meta.json` beside it.
- The meta file holds: agentType, isFork, isBuiltIn, `forkParent {sessionFile, leafId}`, worktree `{path, branch, baseCommit}`, `worktreeCleanlyRemoved`, cwd, description, name, toolUseId, parentAgentId, ownerAgentId, spawnDepth, model, effort (requested and effective), taskListId, stoppedByUser, stopGeneration, finished, and run summaries.
  - Optional fields are omitted when absent rather than written as defaults.
  - The meta file is written with an atomic replace.
- Resume reads the canonical session file. Missing, corrupt or no-leaf state fails explicitly; it never starts a fresh replacement.

## 6. Results and usage (L9)

- **Result text:** search backwards for the last assistant message that has text, skipping messages with `stopReason:"error"` or `"aborted"` and tool-call-only messages.
- **Classification matrix:**

  | Outcome | Classification and result |
  |---|---|
  | Success | completed |
  | `max_turns` | completed-partial, with a note |
  | Abort | killed (`killedBy`) |
  | API error, background run | **failed**, with partial text attached (never upgraded to success) |
  | API error, foreground caller, retryable cutoff (`rate_limit`/`overloaded`/`server_error`) **with prior text** | Recovered: the partial response is returned with an error note; the run's own outcome stays failed |
  | API error, foreground caller, any other error, or no recoverable text | The tool call fails |
  | No assistant *message* | failed, `empty-result` |
  | Assistant messages but no text | completed, with an empty report and a tool summary |

  This matrix was revised in v3 (L5').
- **Result size:** the result is bounded to 100,000 characters, and the notice body is truncated further. The full output stays in the session file, and its path is reported.
- **Usage:**
  - `totalTokens` is the latest *metered* assistant message's `input + cacheWrite + cacheRead + output`.
  - The live metric is the latest input plus accumulated output plus the pending stream estimate. It excludes unmetered messages.
  - Notices report `max(live, result)`.
  - Per-run billed totals (summed request usage) are tracked separately and returned in the tool result's `usage`, so the parent is billed.

## 7. Notifications (L6, A10)

- **Durable outbox** in the root session's meta directory (`outbox.jsonl` plus state):
  - States: `pending → submitted → persisted → acknowledged`.
  - A stable `noticeId` (derived from runId and kind) and batch membership.
  - **Delivery:**
    - When the root is idle, submit immediately (`triggerTurn`).
    - When it is busy, submit with `deliverAs:"steer"`, and let Pi place it at its safe boundary.
  - **Receipt:** observed when the persisted `custom_message` entry (customType `subagent-notification`, with `details.noticeIds`) appears in the session. Then every member run is acknowledged.
  - **On reload:** `submitted`-but-not-persisted notices are resubmitted. This gives logical dedup by noticeId; a duplicate submission is possible in the crash window, and the documentation says so.
- **Routing:** to `ownerAgentId` if it is running or parked (§4.3); otherwise to the root.
- **Notice content** (original prose):
  - status and classification
  - agent ID and name
  - a bounded result
  - usage
  - worktree path, branch and a "changes kept" note
  - for partial results, the reason
  - interim status ("this agent is waiting on its own children; another notice will follow")
  - whether further messages already caused an automatic resume
  - cancellation source and resumability
  - for a failure, its class
- **Launch result text** (background): a brief description of the launch; the agent ID (internal metadata, not for quoting to the user); "use SendMessage to continue this agent"; "you will be notified; don't poll, sleep, read its live transcript, or predict its findings; continue other work". The foreground completed result includes a reminder to check real code changes before reporting edits as done.

## 8. Messaging and continuation (M1, M6, M7)

- **Engine-owned durable inbox** per agent. Each envelope holds `{id, from (host-stamped agentId or "main"), to agentId, text, summary, createdAt, deliveredRunId?, consumedAt?}`.
- **`SendMessage {to, message, summary?}`:**
  - `to` is a single bounded line.
  - A blank message, broadcast `*`, and serialized protocol or lifecycle frames are rejected.
  - `summary` is coerced and truncated.
  - The sender must not have a stop pending.
- **Resolution:** resolve and pin the identity (agentId, or a name under a pinned binding), then revalidate inside the per-agent lock. A rebound pinned name returns `success:false` and requires confirmation.
- **Routing:**
  - **`main`:** routes to the root conversation, never the immediate parent. A root caller sending to `main` is refused. `main` is reserved as an agent name. The message enters as a custom message (`subagent-message`, display true, origin attribution); it is not run through slash-command or template expansion.
  - **Live run:** append to the inbox, then inject it with `sendCustomMessage({customType:"agent-message", ...}, {deliverAs:"steer"})` as a literal message. It is not passed to `session.steer`, so it is never transformed or swallowed. Mark it delivered when the entry persists. The result reads "queued for the agent's next tool round", not "consumed".
  - **Run finalizing or settling:** the message stays in the inbox. When finalization finds undelivered inbox messages, it starts a continuation through the same single-flight reservation. The notice says another run will follow.
  - **Finished agent:**
    1. Single-flight resume: a global in-flight map plus the record's `resuming` flag.
    2. Refuse if the previous execution is still exiting.
    3. Recheck `stoppedByUser` and `stopGeneration` immediately before starting.
    4. Start a new run with the same agentId and session file. Inbox messages become the next prompt.
    5. **Ordinary continuation revalidates (§16.5).** Current trust, definition policy and tool availability are checked again. Capabilities that are no longer allowed are dropped. Untrusted provenance, missing state, or a deleted worktree with no explicit alternate root is refused. The essential-tools fallback belongs only to legacy teammate revival, so it is not used here.
  - **Stopped by user:** refuse to revive; the work is to be treated as cancelled. An explicit user command may revive it.
  - **Missing state:** fail.
- **Backends without live delivery** (Herdr Claude Code panes): live delivery returns an explicit unsupported result. Continuation after completion still works (M8).

## 9. Hooks (A4–A7, M3)

- **Configuration:** Claude-format JSON in `<agentDir>/hooks.json`, `<project>/.pi/hooks.json` (only when the project is trusted), and the definition's `hooks`. Packages are excluded. Only the `command` type, run in exec form or through the shell, is supported. Matchers are by agent type or tool name, as in Claude.
- **SubagentStart**
  - Runs the parent's and session's hooks before the child's definition hooks are registered.
  - Input: the common fields (session id, cwd, transcript path, `hook_event_name`) plus `agent_id` and `agent_type`.
  - Blocking errors become child-context messages; they do not veto the launch.
  - `hookSpecificOutput.additionalContext` is inserted.
  - Carried context is deduplicated on continuation.
- **SubagentStop**
  - **Blockable phase:** runs in the child's `agent_before_settle`.
    - Input: the common fields plus `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, and background-work context.
    - Results map as follows:

      | Hook result | Effect |
      |---|---|
      | `decision:"block"` | Feedback, then continue |
      | `continue:false` | Prevent; takes precedence over block |
      | `additionalContext` | Feedback, then continue |
      | Exit 2 | Block from stderr, except the missing-script exception (diagnostic) |
      | Exit 0 without JSON, or `continue:true` alone | Nothing |
      | Invalid JSON, timeouts, other errors | Diagnostics only |
  - **Continuation is engine-owned (A5):**
    - Feedback is appended as a boundary draft entry and the handler returns `continue:true`.
    - On prevention, the engine marks the run `preventContinuation`. Its `tool_call`/`turn_start` guard refuses further turns, and queued inbox messages stay durable for a later continuation instead of extending this run.
  - **Counters:**
    - `stop_hook_active` becomes true after the first feedback retry and stays true.
    - The consecutive block count resets after an ordinary tool turn.
    - Cap: 8 (`PI_STOP_HOOK_BLOCK_CAP`). The 9th block is overridden with a warning. A non-positive cap disables the check.
    - `maxTurns` is checked first.
  - **Reaction phase:** after the final decision, reactions run and cannot restart the run.
  - **Interrupted fallback (A4):** an exactly-once `stopHookAttempted` flag. If a run is aborted or throws before the blockable phase ran, SubagentStop runs once during cleanup, bounded to 5 s, with continuation and block signals ignored.
- **TaskCreated / TaskCompleted** (M3):
  - TaskCreated runs after allocation. A block deletes the task (the watermark is kept) and fails the call.
  - TaskCompleted runs only on a transition into `completed`. A block fails the whole update; no field or dependency change is committed.
- **Trust:** project hooks never run in an untrusted project.

## 10. Shared task list (M4, M5)

- **List identity:** `PI_TASK_LIST_ID`, else the root session's id. It is resolved once at the root, passed explicitly to every child through both backends, and persisted in meta. It is sanitized for filesystem use.
- **Storage:**
  - Records live at `<agentDir>/tasks/<listId>/<id>.json`, with `.highwatermark`.
  - Locks: a list-level lock (`<list>/.lock`, a mkdir lock with a stale threshold and heartbeat) for allocation, deletion and claims, and a per-task lock for updates.
  - Every read-modify-write happens inside its lock, with an atomic replace (a deliberate strengthening).
- **TaskCreate {subject, description, activeForm?, metadata?}:** creates a pending, ownerless task with empty edges. The id is `max(existing numeric ids, highwatermark) + 1`.
- **TaskGet {taskId}:** a narrow projection, or `task: null`.
- **TaskList {}:** sorted numerically. It omits tasks whose `metadata._internal` is truthy, returns summary fields, and filters completed tasks out of each returned `blockedBy` without changing storage.
- **TaskUpdate {taskId, subject?, description?, activeForm?, status?, addBlocks?, addBlockedBy?, owner?, metadata?}:**
  - Metadata merges per key; `null` deletes a key.
  - `owner` is plain assignment.
  - Edges are reciprocal and deduplicated, written as two updates. Missing endpoints are not created, and there is no cycle check (compatibility).
  - Completing a task does not delete its edges.
  - `status:"deleted"` raises the watermark, then removes the task and the reciprocal references.
- **Claim helper** (engine-internal; idle-worker use only): locked. It checks the owner, completion and open blockers (a missing blocker does not count), plus the busy-check variant.
- Public tool input schemas match `sdk-tools.d.ts` exactly.

## 11. Agent memory (D9)

- `memory: user|project|local` maps to these directories:
  - `<agentDir>/agent-memory/<agentType>/` for `user`
  - `<project>/.pi/agent-memory/<agentType>/` for `project`
  - `<project>/.pi/agent-memory-local/<agentType>/` for `local` (gitignored)
- The memory index (`MEMORY.md`) is primed into the prompt, bounded in size.
- When memory is enabled, `read`, `write` and `edit` are added to an explicit tool list, scoped to the memory directory by a `tool_call` path guard.
- Concurrent writes are last-writer-wins per file (documented).

## 12. Worktree isolation (L3)

- **Creation:** `isolation:"worktree"` runs `git worktree add --detach <stateRoot>/worktrees/<agentId> HEAD`. This happens after admission and before registration completes. `baseCommit` is recorded.
- **Cleanup** happens at final completion, never while parked or holding owner edges.
  - **Changes detected** (any of): `git status --porcelain` is non-empty (including untracked files), or `rev-list baseCommit..HEAD` is non-empty.
  - **If there are changes:** keep the worktree, its index, working files and branch `agent-<agentId>` exactly as they are. Do **not** commit for the child. Report the path, the branch and any commits the child itself made (v3, L3').
  - **If there are none:** remove the worktree and its unused branch, and set `worktreeCleanlyRemoved`.
  - **If any inspection or removal fails:** keep everything and report it.
- The worktree is created with `git worktree add -b agent-<agentId> <path> HEAD`.
- **Resume after removal:** the worktree is re-added from the branch, or the cwd falls back to the parent's with a note.
- A worktree is not a sandbox, and the documentation says so.

## 13. Herdr backend (L2, M8)

- Herdr stays **authoritative** for its runs, run IDs, blocked state, cancellation acknowledgement and outbox. The engine registry stores a proxy record (`backend:"herdr"`, Herdr agent and run IDs) and does **not** create its own notice for Herdr runs. Herdr's `herdr-subagent-notification` delivery is kept as is, and the engine maps it into the same notice renderer.
- Capabilities:
  - Pi panes: `liveDelivery` through Herdr steer, but only once accepted.
  - Claude Code panes: `liveDelivery:false`; `maxTurns` and `fork` are unsupported.
- `blocked` returns a foreground wait immediately.
- Admission and depth: the engine counts Herdr runs it launched toward the cap. Each child process enforces depth from its stored depth, as today. Remote nested chains keep Herdr's current per-machine depth and are documented.
- All existing protocols, database versions, markers, session entry types, customTypes, state roots and ID syntax are preserved.

## 14. Autonomy and delegation (A2, A3, A9, A10)

- **Profile:** positive delegation (the default). A `/grok-style autonomy off` setting switches to explicit-request only. In that mode, a request that names an agent type counts as explicit.
- **Guidance** (original prose, in the Agent description and a session-guidance section):
  - Reach for an agent when the task matches a type, for genuinely independent parallel work, or when answering would mean reading across many files. Keep the conclusion rather than the file dumps.
  - Do small or known work inline: a single lookup of a known file or symbol.
  - Launch independent agents in one message.
  - Don't duplicate delegated research.
  - Brief a fresh agent fully, since it has no context; give a fork a directive instead.
  - Continue an existing agent with `SendMessage` rather than launching a new one.
  - The agent's report is not shown to the user, so relay it.
  - Use `run_in_background:false` only when the next step genuinely depends on the result.
  - Set `effort` only on explicit instruction. A `model` override is permitted when it is useful. The explicit-only rule for model choice is coordinator-only and is not part of this profile (A4').
  - Once fork is enabled, prefer a fork for research or multi-step implementation that would fill the parent's context.
  - The Explore route for broad research needing more than 3 queries applies only when fork is unavailable, and excludes reviews, audits, consistency checks and open-ended analysis.
  - Labelled as heuristics.
- **Dynamic agent listing** (A9):
  - The listing is specific to each caller: it filters definitions by the caller's current `Agent` availability and allowed types, and by required MCP tools.
  - It is emitted as a persistent `agent-listing` custom message with add and remove deltas.
  - It is refreshed on definition change, model change, tool-set change and trust change.
  - It is computed before every model request through the `context` event (which also covers turns started by a notification), not only `before_agent_start`.
  - The Agent tool description holds the stable part; the listing deltas carry the dynamic part.
- **Removals:** `EXPLICIT_SUBAGENT_REQUEST` and `withoutSubagentInitiative` go away in positive mode.

## 15. Grok integration

- **Activity panel:** fed from the engine's event stream through the `Activity` contract: run model and thinking, live transcript, and user-source Stop.
- **Rendering:** diamond renderers for `Agent`, `SendMessage`, `TaskStop`, the Task tools, `subagent-notification`, `agent-message`, `subagent-message` and `agent-listing`.
- **Package changes:** remove the `@tintinweb/pi-subagents` dependency and the adapter, and update the README.

## 16. Amendments from the updated dossier (2026-10-21, v2.1)

Sources: `reconstruction-contracts.md` (C§n) and `automatic-delegation.md` with its appendices (AD§n). Where these conflict with earlier sections, these amendments win.

**Dossier error noted.** README §6 and C§6 still say background filtering removes `Agent`. In the shipped code, `ht === "Agent"` (`artifact/root/chunk-2fccb5hn.js`), and `Jd` (`derived/prettified/root/chunk-fbgs9vjp.js:5896`) returns `depth < cap` for Agent *before* the background-tool restriction. Auditors D3 and A1 independently confirmed this. The plan keeps Agent for eligible background agents.

### 16.1 Conversation transaction (C§1–2)
- Each conversation gets a short mutex with a `revision` counter. These operations all go through it:
  - accepting a message
  - reserving and replacing the active run
  - finalizing a run
  - reserving a wake
  - changing an owner edge
- **Invariants:**
  1. One writer per transcript.
  2. Every accepted message has a durable state: pending, delivered or refused.
  3. The user-stop tombstone is checked on ordinary *and* automatic revival, including after eviction.
  4. A run is reserved before any asynchronous work.
  5. Only the current active run can settle. A stale finalizer is ignored.
  6. Acceptance, settlement and wake publication are a single state change (backed by a durable outbox).
  7. Nothing is awaited while the lock is held: no model call, tool, hook, dialog or run lifetime.
- **Acceptance key:** `SendMessage` derives one from the calling `toolCallId`.
  - A retry with the same key returns the existing receipt.
  - The same key with a different payload is a conflict.
- **Reservation is separate from launch:**
  - `reserveContinuation` runs synchronously under the lock.
  - `launchReservedRun` runs outside it. Its startup promise settles once initialization is done, not when the run finishes.
  - If launch fails, the message stays accepted with a retryable wake, or gets an explicit refusal.
- **The finalizer re-reads the inbox inside the transaction.** If messages are pending, it reserves one continuation. Otherwise, if owner edges remain, the run is parked. Otherwise it becomes evictable.

### 16.2 Owner edges (C§3)
- This replaces the keepalive-set wording in §4.3. An owner edge is `{key, ownerAgentId, childAgentId, childRunId, ownerEpoch, state: held|routing|released}`.
- It is acquired before the child becomes visible, and rolled back if reservation fails.
- Releases are idempotent and checked against the epoch, so a stale callback cannot release a newer edge.
- When a launch touches two records, locks are taken in deterministic ID order.
- The transition table follows C§3.
- A worktree or locally owned MCP client is never removed while a parked owner needs it.

### 16.3 Notification identity and passive events (C§4, AD§8)
- **Notice key:** `(rootSessionId, agentId, runId, kind, sequence)`, where `kind` is one of `interim_handback|terminal_result|terminal_failure|stopped|delivery_refusal`.
  - The sequence is assigned once, at the state transition that creates the report.
  - Retries reuse the same identity and payload.
- **Receipt stages are kept distinct:** persisted → routed → appended to history. Being appended to history is not the same as the model having consumed the notice.
- **Passive events** carry `shouldQuery:false` and are recorded and displayed without triggering a model turn. Examples: a completion whose result already reached the parent synchronously, or a pointer/handback event.

### 16.4 Live authorization (C§5)
- Child tool admission is decided at each call against the current policy revision, covering trust, definition availability, depth and stop state. It is not a grant frozen at spawn.
- The engine does not reproduce Claude's permission-mode evaluator. Its revision checks add to, and never replace, the `tool_call` admission and `ui.confirm` dialogs of other loaded extensions. Prompt text never grants a tool (A9').

### 16.5 Restore matrix (C§6)
- Fresh, fork and ordinary continuation are separate paths with separate tests.
- A stored definition snapshot records what ran. It does not authorize continued use of a removed tool, a removed package or a deleted directory.
- There is no degraded-history fallback for ordinary continuation.

### 16.6 Usage fixture (C§7)
- Phase 1 includes the dossier fixture: response 1 = (10, 2, 3, 1), response 2 = (20, 4, 5, 2). Expected values:
  - result `31`
  - request-footprint sum `47`
  - latest input footprint `29`
  - accumulated output `3`
  - live `32`
  - notice `32`
- Also covered: model transitions A→B→A are all kept, and replaying history on continuation does not double-count usage.

### 16.7 Policy rendering and listing (C§8, AD§3–5)
- **Rendering:** a policy renderer resolves channel inputs (profile, fork availability, offered types, autonomy setting) and renders three separate channels:
  - the Agent tool description
  - the session-guidance system section
  - listing messages
- **Golden fixtures per channel** contain both required and forbidden text, for these profiles:
  - positive
  - explicit-only, where conflicting positive nudges are suppressed (a design improvement, labelled as such)
  - fork-enabled
  - no offered types
- **Listing state:**
  - Comparison is against the last *committed* listing in session history. An aborted request preparation consumes no delta.
  - State is rebuilt from history after resume or compaction.
  - A removed type stops being an executable choice immediately.
- **Proactive descriptions:** a definition description such as "use proactively after X" reaches the model through the listing. No regex auto-launcher exists.
- **Executor:** it only validates and schedules the Agent calls the model emits. It never decomposes tasks.

### 16.8 Task-list profiles (C§9)
- **Observed-compatibility semantics** are the default (§10): public owner assignment, ignoring missing blockers, separate owner and status writes, no rollback, no cycle check.
- Storage hardening (atomic replace, read-modify-write under lock) is labelled as a strengthening. It does not change observable semantics.
- Ordering is numeric (IDs 2 before 10).

### 16.9 Host-triggered launches (AD§7)
- **Extension spawn API.** This is the Pi equivalent of `$.agent.spawn`. It is a `pi.events` RPC (`subagent-engine:rpc:spawn|stop|status`).
  - The call is stamped with its origin (the extension id).
  - It is limited by a per-extension cap (default 20) that refuses rather than queues.
  - Launch-only settlement: the slot is held until the child settles. A timed-out wait does not kill the child.
  - Ordinary admission still applies.
- **Skill-scoped children** (v3, N1/A3'). This is **not** the conversation fork of §2.2. A skill whose frontmatter sets `context: fork` runs as a *fresh* child built by a separate skill-subagent compiler:
  - **Agent:** the skill's `agent` (or `general-purpose`), with the skill's `model`/`effort` and scoped `allowed-tools`.
  - **Prompt:** the skill content becomes the prompt, with a fresh read state. The parent conversation is not included.
  - **Continuation:** the skill identity and scope are persisted and revalidated on continuation. A mismatch is refused.
  - **Entry points:**
    - **User:** `/skill:<name>`, intercepted by an `input` handler before Pi expands it inline.
    - **Model:** fork-context skills appear in the agent listing as `skill:<name>` types and are invoked through `Agent`.
      - A skill with `disable-model-invocation: true` is left out of the listing, **and** the engine refuses it when executing a model-originated call.
      - The user route accepts only genuine user input, not prompts from the engine or other extensions (the `input` event's `source`).
      - Separate user and model tests cover this.

    Pi's `Skill` metadata has no `context`/`agent` fields, so the engine parses the frontmatter itself. Phase 7 includes this.
- **Out of scope, as declared deviations:** Workflow phase agents, observers, artifact-comment workers, and agent-type hooks. The `SubagentWorkflow` tool from Pi Subagents is dropped.

### 16.10 Root wake (AD§8, automatic-interactive)
- When an eligible notice exists and the root is idle, one serialized drain submits a single batch.
- **Guards** must all hold:
  - Pi reports `isIdle()`.
  - No `ui_prompt` or dialog is open.
  - Session startup has completed.
  - The current ownership generation matches.

  The guards are checked again just before submission.
- **Mid-turn:** steering is placed at Pi's safe boundary.
- **Parked owners and stranded deliveries** use their own wake router (§16.1) and do not depend on root idleness.
- **No durable daemon:** a wake cannot revive an exited Pi process. Pending notices are delivered at the next session start.

## 17. v3 resolutions from the second audit round

Tags refer to the recheck findings: slot 2 = D*'/N*, slot 3 = L*', slot 4 = M*', slot 5 = A*'. These amendments supersede earlier sections where they conflict.

### 17.1 Root bootstrap trust (N2)
`createAgentSessionServices` receives a `SettingsManager` created with `{projectTrusted: ctx.isProjectTrusted()}` before any resource loading, so an untrusted project's extensions and settings never execute during root bootstrap. A test uses an untrusted project containing a project extension that must not run, covering both root initialization and child creation.

### 17.2 Run prevention and the turn budget (M8', A1', A5')
- Prevention takes effect **inside** the child's `agent_before_settle`, before control returns to Pi:
  1. Call `session.clearQueue()` (the engine owns the child `AgentSession`).
  2. Move every cleared steering or follow-up message back into the durable inbox as `pending`.
  3. Return `{continue:false}`.
- `turn_start` is never used as a veto.
- **Budget:** a turn that ends with a natural final answer at exactly the limit completes normally. Only an *attempt* at an extra turn is denied.
  - **Hook retry at the limit:** this goes through the pre-settle prevention path described above.
  - **Tool loop at the limit** (a `turn_end` whose assistant message has tool calls while `turns >= maxTurns`):
    - **Known SDK result (no spike needed):** `turn_end {continue:false}` does **not** stop Pi's tool-result continuation. Pi maps `false` to "no decision" (`agent-session.js:523`), and the core loop continues on `hasMoreToolCalls` (`agent-loop.js:179`).
    - **Mechanism (verified by probe, 2026-10-21):** the engine wraps the public core callback `session.agent.afterToolCall`. The wrapper awaits any existing callback, keeps the fields it returned, and adds `terminate: true` to **every** finalized result of the last allowed batch, because the core loop ends only when all of them carry it. The tools still execute, and no further provider call is made.
    - **Rejected options:** the extension `tool_result` and `tool_call` terminate fields have no effect. A non-awaited abort from `turn_end` still sends a full request with the tool results, so it is not used.
    - In both cases, the queue is reconciled into the inbox (§17.2a), and the classification comes from the engine's `max_turns` mark.
- **§17.2a Queue reconciliation (A-final #1):**
  - Snapshot `session.agent.peekQueuedMessages()` before calling `clearQueue()`, because `clearQueue()`'s return value omits custom messages.
  - Reconcile by **durable inbox identity**: every envelope that is submitted but not `included` returns to `pending`, whatever the snapshot shows.
- Tests: prevention with an already-queued message makes no further provider call, and a natural answer at budget 1 is not aborted.

### 17.3 Inbox delivery states (M1')
- Envelope states: `pending → submitted → persisted → included → consumed`.
  - **`included`** is recorded only when an **assistant `message_start` follows the envelope's persisted message entry in the same run**, which shows a provider request carrying it was dispatched.
  - The `context` event is used only for selection and projection; it is never treated as proof of inclusion.
  - If the run fails before dispatch, the envelope stays `persisted`, and finalization treats it as undelivered.
  - The envelope ids projected into the *final* transformed context are recorded as `prepared`. An envelope that a later `context` handler removed is never marked `included`.
  - Fixtures cover two cases: a later context handler that strips the envelope, and a failed credential resolution.
- Finalization treats any envelope that is not `included` as undelivered and reserves a continuation for it. It does not matter whether the envelope was persisted.
- Delivery to an idle or settling child is serialized with run reservation under the conversation lock. Messages are never pushed with `triggerTurn` into an unregistered run. A delivery that would need a new run goes through `reserveContinuation`.
- Test: delivery while settlement handlers are suspended.

### 17.4 User-stop propagation and TaskStop authorization (M2', M3')
- A user-source stop marks **every** descendant it cancels as `stoppedByUser` and bumps its `stopGeneration`. The initiating cause is recorded separately from the immediate parent.
- **Authorization matches upstream:**
  - The root (main) caller may stop any agent in the session.
  - A subagent caller may stop a record only when its own identity equals the record's `agentId`, which is the agent's own ID. The predicate never looks at who launched the target, so a subagent cannot stop its children through `TaskStop`. The earlier subtree and direct-child rules are both withdrawn (M3'').
- **Terminal but still exiting:** TaskStop may re-signal a run that is terminal but still exiting. Otherwise, non-running targets are refused.

### 17.5 Task hooks, locks and backends (M4', M5', M6')
- **Hook payloads:**
  - TaskCreated and TaskCompleted receive the common fields plus `task_id`, `task_subject` and `task_description`. `teammate_name` and `team_name` are omitted in this profile.
  - The events are not matched by tool name.
  - TaskCompleted receives the stored subject and description *before* the requested update is applied.
- **One lock domain:**
  - Every task mutation (update, claim, delete, edge add) takes that task's lock.
  - Allocation, deletion and busy-claim take the list lock *first*, then task locks in ascending ID order.
  - Hooks run outside the locks and are revalidated at commit.
- **Backends:**
  - Shared tasks work for the in-process backend and for **local** Herdr Pi panes, which share the same `<agentDir>/tasks` store.
  - Herdr **Claude Code panes** and **remote machines** don't support shared tasks. That's a declared deviation, and Agent results say so.

### 17.6 Herdr notification routing (M9')
- Herdr keeps its authoritative outbox and IDs. Its delivery step is replaced by an adapter that hands each notice to the engine's router, so it reaches the engine's owner (a parked in-process owner gets a resume reservation) or the root.
- The customType `herdr-subagent-notification` and receipt semantics are kept.
- Test: in-process A launches Herdr B; A parks; then A is cancelled.

### 17.7 Definition revocation (M7')
Continuation fails closed when a definition has been removed, is denied by policy, or has lost trust. The only recoverable case is metadata that never recorded an agent type (legacy records); those continue as `general-purpose` with a note.

### 17.8 Skills, memory, omitClaudeMd, model fallback (D5', N4, N6, N7)
- **Skills preload order:** preloaded skill messages come *after* the delegation message, matching the original order. A context-order fixture covers this.
- **Memory grants:** tools added only for memory are scoped to the memory directory. Tools the agent already had keep their full scope. Denies stay authoritative after the memory augmentation.
- **`omitClaudeMd`** is source-sensitive:
  - Built-in and policy definitions drop all context files.
  - Other sources reload with managed instructions only. If that reload is unavailable, they keep the original context.
- **Unavailable model:** try family resolution first (same provider plus the same model family token; declared approximation), then the configured `PI_SUBAGENT_MODEL` default, then the parent's model. `PI_SUBAGENT_MODEL_FORCE` sits under the fork rule.

### 17.9 Background capability set (N8)
- Ordinary **background** children get `read`, `grep`, `find`, `ls`, `bash`/`powershell`, `edit`, `write`, `SendMessage`, `TaskList`, `TaskStop`, `Agent` (below the depth cap) and MCP tools. They do **not** get `TaskCreate`, `TaskGet` or `TaskUpdate`, matching the original background set.
- **Foreground** children get the full set.
- Forks keep their exact-tools exception.

### 17.10 Extension spawn API identity (N9, L8', A8')
- An extension calls `subagent-engine:register {extensionId}` once and receives an engine-issued launcher handle object through the reply. Every spawn goes through that handle, which is how the engine stamps the call's origin.
- The `extensionId` at registration is **self-declared**. The per-extension cap is therefore cooperative accounting between trusted in-process extensions, not a security boundary. A global cap still applies, and the documentation says so.

### 17.11 Reload and shutdown ownership (L3')
- **Live-session broker:** live child sessions are held in a process-stable broker on `globalThis[Symbol.for("subagent-engine.broker.v1")]`, which survives extension reload.
  - On `session_start(reload)`, the new generation adopts every broker entry for its root session in one atomic handover (the generation counter is compared and swapped). Installer services are rebound to the new generation.
  - If the broker is missing or its version doesn't match, children are cancelled and drained instead of being reattached.
- **Timed-out cancellation:** a cancellation still unresolved after the 5 s wait **stays pending**. The run keeps its admission slot and ownership, and is marked `cancel-unacknowledged`. The engine never invents a terminal acknowledgement, and `dispose()` is never treated as one.

### 17.12 Auto-background safeguard (L4')
- Pi's public ToolInfo has no `executionMode`, so the engine takes a conservative public-API fallback: **do not auto-background while the parent's assistant message (read from the persisted branch) contains any tool call after this Agent call.**
- The parent's `isStreaming` is not used as the predicate.
- An upstream request will ask Pi to expose `executionMode` publicly.

### 17.13 Usage attribution (L6')
- Foreground runs return their usage in the Agent tool result, so Pi counts it.
- Background runs are recorded in an engine-owned usage ledger, idempotent per runId, and shown in the notice. They do not appear in Pi's native session totals, a limitation the documentation states.
- Repeated reads through the result alias never charge again.

### 17.14 Watchdog (L7', L11')
- On expiry: **abort, and wait for the stream's abort to be acknowledged**.
- **Park only if** the run holds owner edges *and* its history is recoverable (no dangling tool calls after repair). Otherwise the run fails as `stalled`.
- A stale stream is fenced by run identity.
- The fixed 600 s default and its env override are a declared simplification of the original's recovery-budget-derived timeout.

### 17.15 Listing commit bridge (A2')
- When available types change, the engine creates a pending listing (id, adds, removes) and schedules a persistent `agent-listing` entry:
  - **When idle:** `pi.sendMessage(..., {triggerTurn:false})`. It is appended immediately and starts no inference. `nextTurn` is not used, because it is an in-memory queue that runs started by a notification never drain.
  - **When streaming:** the entry is written at the next boundary.
- Until that entry appears in session history, the `context` event projects the pending listing into each request, deduplicated by id.
- The baseline advances only when the persisted entry is observed. A rendered projection never advances it.

### 17.16 Stop hook exit-code precedence (A6')
In priority order:
1. Prevention (`continue:false`) wins.
2. The recognized missing-script exception is diagnostic only. It is checked **before** the generic exit-2 rule.
3. Exit 2 blocks with stderr, even when its stdout JSON is malformed.
4. Malformed output with any other exit status is diagnostic.

A combined fixture covers every pair.

## 18. Workflow (added 2026-10-21; dossier `workflow*.md`)

This replaces the earlier non-goal. It implements the current classic local Workflow profile of 2.1.303. The retained reactive/v2 runtime and remote execution are not offered: `remote` input and `agent(..., {isolation:"remote"})` are rejected.

- **Tool:** `Workflow`, with alias `RunWorkflow`. Its strict input mirrors `WorkflowInput`: `script`, `name`, `scriptPath`, `args`, `resumeFromRunId`; `description` and `title` are ignored.
  - **Source precedence:** `scriptPath` > `name` > `script`. When `scriptPath` and an already-reviewed `script` snapshot are both present, the snapshot is used.
  - **Result:** a launch receipt `{status:"async_launched", taskId, taskType:"local_workflow", workflowName, runId, summary?, transcriptDir, scriptPath}`.
  - **Syntax failure:** returns the same receipt shape with `error`, and is **not** registered.
  - **Background:** the tool always runs in the background and completes through the engine outbox as a run-aware notice. `TaskStop` accepts a workflow `taskId`.
- **Model guidance:** stricter than Agent. Launch a workflow only on explicit multi-agent/workflow opt-in, a named workflow request, or a skill/command instruction. Parallelism alone is not a reason. Autonomy mode does not relax this.
- **Script authority:**
  - **Inline and path scripts:** ask the user through `ctx.ui.confirm`, showing the exact script, unless `PI_WORKFLOW_APPROVE=1`. Without a UI, they are refused by default.
  - **Named workflows:** allowed per source. Bundled, user and trusted-project workflows run; untrusted projects are skipped.
  - **Execution** uses the approved snapshot bytes and their digest, never a re-read.
  - **Path admission:** resolve and canonicalize, require a regular file of at most 524,288 bytes, read once, then approve the snapshot.
- **Named discovery:** immediate `.js` files under `<agentDir>/workflows`, `.pi/workflows`, `.claude/workflows` and ancestor project dirs (nearest wins, trusted only), plus bundled workflows. The workflow's name comes from `meta.name`, not the filename.
- **Meta:** the first statement must be `export const meta = {...}`. It is parsed structurally with acorn and is never evaluated. Literals, nested objects, arrays, no-interpolation templates and negative numbers are allowed. Computed values, spreads, methods, getters and unsafe keys are rejected. `name` and `description` are required.
- **VM:** a fresh `node:vm` context per script and per child workflow, with string and wasm code generation disabled.
  - **Rejected syntax:** dynamic `import()`, `with`, `await using` and reserved internal identifiers.
  - **Execution:** the body is wrapped in a strict async function. Synchronous execution is bounded to 30 s; this is not a wall-clock limit on the whole workflow.
  - **Globals:** only `agent`, `parallel`, `pipeline`, `phase`, `workflow`, `log`, `console`, `budget`, timers and JSON-copied `args`.
  - **Determinism:** `Date.now()`, argumentless `Date()` and `new Date()`, and `Math.random()` throw. Explicit dates still work.
  - **Results:** copied out of the context; a function-valued return is rejected.
  - **Not a sandbox:** this is a capability-limited same-process VM, and the documentation says so.
- **API semantics** follow the dossier §7 and the rebuild guide §6:
  - **`parallel`** takes callbacks only, waits for all of them, keeps order, and turns failures into `null` plus a failures-ledger entry.
  - **`pipeline`** starts every item and runs its stages sequentially. Only `null` short-circuits; `undefined` does not.
  - **`phase`** groups progress and is not a barrier.
  - **`workflow(name|path, args)`** runs one nested level with a fresh realm, sharing permits, budget and counters.
  - **Input arrays** are capped at 4,096 elements; oversize input throws.
  - **`log`** returns the first 1,000 messages.
- **`agent(prompt, opts)`:**
  - **Options:** `label`, `phase`, `schema`, `model`, `effort`, `isolation` (`"worktree"` only), `agentType`, `disallowedTools`, `bashCommandClamp`.
  - **Returns** text, schema-validated data, or `null`.
  - **Limits:**
    - A shared logical call cap of 1,000, which counts replay hits.
    - A FIFO permit pool of `min(16, max(2, availableParallelism() - 2))`; `PI_WORKFLOW_CONCURRENCY` (1–256) overrides it.
    - The permit covers setup, retries and cleanup.
    - A separate one-at-a-time permit for worktree creation.
  - **Default denies:** `Agent`, `Workflow`, `SendUserMessage`.
  - **Structured output:** `schema` comes back through a `StructuredOutput` tool installed on that child. It is validated, invalid attempts are capped at 5, and a missing handback gets a nudge.
  - **Stall retries:** up to 5, under the same logical index.
  - **Budget:** `budget.total` is null, `spent()` is the session output-token ledger, and `remaining()` is Infinity.
- **Execution through the engine:** `agent()` runs as a normal engine child through a `WorkflowHost` interface, with current authorization, definitions and hooks. Each child appears as its own agent run owned by the workflow task. Children are foreground to the script, and their notices are passive.
- **Persistence:**
  - **Journal:** `<agentDir>/subagents/<rootSessionId>/workflows/<runId>/journal.jsonl`, with events `launched{scriptSha256}`, `started{key, agentId, label?, phase?}`, `failed{key, agentId}` and `result{key, agentId, result}`. It tolerates a torn tail.
  - **Terminal snapshot:** `.../workflows/<runId>.json`.
  - **Persisted script:** `.../workflows/scripts/<runId>.js`, returned as `scriptPath`.
- **Replay:**
  - **Key:** `'v2:' + sha256(prev + '\0' + prompt + '\0' + canonical(opts))`. Only the whitelisted options listed above count, with keys sorted recursively.
  - **Prefix fence:** replay is sticky once a live call happens. The exception is a started-only interrupted attempt, which runs live without fencing the rest.
  - **Results** are cloned. An empty or `null` cached value still counts as a hit (checked by `Map.has`).
  - **Resume:** the same session only. The prior task must be stopped *and* fully settled, with no active agent associations. The run id is kept and a new task id is issued. Collisions are rechecked just before registration.
- **Lifecycle:**
  - **Task states:** `starting`, `running`, `completed`, `failed`, `killed`.
  - **Result:** the task result holds the script result, the agent count, logs, failures and duration. A handled failure still completes.
  - **Cancellation:** cancellation aborts active agent controllers. Waiters still queued acquire the permit, see the abort, and release it.
  - **No implicit join:** detached promises are not drained.
### 18.1 Corrections from the finalized Workflow dossier (2026-10-21 15:33)

Sources: `workflow-audit.md`, `workflow-audit-rebuild.md` (H1, M1, M2, L1, L2) and `workflow-receivers.md`. These supersede §18 where they conflict.

- **Permit scope (M1, compatible):**
  - The permit covers the attempt lifetime and the worktree cleanup in its `finally`.
  - The permit is released or transferred FIFO when the executor settles.
  - The awaited, warning-only result/failure journal append runs **after** release, in the outer logical-call wrapper.
- **Empty helpers (M2, compatible):**
  - Check order for `parallel` and `pipeline`: abort → yield → snapshot and 4,096 cap (items *and* stages) → return `[]` if empty → only then call/budget checks and stage-function validation.
  - `pipeline([], 123)` returns `[]`.
  - An already-aborted helper returns a promise that never settles; it does not reject.
- **Child workflow signature (L1):** `workflow(name: string | {scriptPath: string}, args?)`. A path-looking string is a *name* lookup. Only `{scriptPath}` reaches the authorized loader.
- **Deny/clamp intake (L2):** reject entries that are non-strings, empty, or whitespace-padded before the key is allocated. Valid entries are deduplicated and sorted. The forced-model suppression applies before hashing. Effort is hashed as given (not normalized to the model).
- **Replay precision:**
  - A loaded result takes precedence over a failed marker for the same key.
  - A started-only respawn that fails now still allows a later loaded hit.
  - Current appends never mutate the originally loaded maps.
  - A cache hit is returned *before* the unsupported-remote refusal.
  - A cached empty string, `false` or `0` is a hit; checks use presence, not truthiness.
- **Golden vectors:** the engine's replay-key implementation must reproduce all 14 vectors in the dossier's `workflow-replay-vectors.json` (the data is copied into the test fixtures). It must also pass the replay-fence assertions of `workflow-replay-fixtures.mjs`.
- **Settlement boundary (H1, strengthened profile, labelled):**
  - The original only waits for query-attempt associations, which can leave a late worktree cleanup or journal append after "settled".
  - We add a per-invocation **outstanding-obligation counter**. Each logical call registers before it queues, and the obligation is released after its outer journal append. Resume admission requires: task terminal, chain settled, attempt associations empty **and** outstanding obligations zero.
  - Resume waits for that, bounded to 30 s, else refuses with "previous run still finishing".
  - This is a documented strengthening, not observed behavior.
- **Server-delivered receivers** (`__remote-workflow`, `workflow_launch` events, bundle framing, one-shot handoff): these are cloud-only and out of scope. Herdr's `machine` option is our remote path.

- **Deviations:**
  - No hidden or withheld bundled-script identity checks beyond the digest.
  - No storage-v5 adapter.
  - No remote mirroring.
  - Prompt-cache warm-up coordination is omitted.
  - The 45 s throttle fallback is omitted, but stall retries apply.

## Phases

Every phase has deterministic tests. They use a stubbed Pi `streamFunction` plus real `AgentSession`s for SDK-sensitive paths (retries, reload, `/new`, abort during a tool). Each phase ends with a sidecar diff review.

1. Foundations (§0), definitions (§1), context without fork (§2.1, 2.3–2.5), registry and admission (§3), the conversation transaction (§16.1), live authorization (§16.4), the in-process lifecycle without parking (§4.1, 4.2, 4.4), transcripts (§5), results and the usage fixture (§6, §16.6), outbox with notice identity and root wake (§7, §16.3, §16.10), the `Agent` tool and `TaskStop`. Nested spawning and admission ship together here.
2. Messaging and continuation (§8), parking with owner edges (§4.3, §16.2), the restore matrix (§16.5), the aliases.
3. Fork (§2.2) and worktree (§12).
4. Hooks (§9), including TaskCreated and TaskCompleted.
5. Task list (§10, §16.8) and agent memory (§11).
6. Herdr backend (§13).
7. Autonomy, policy renderer and listing (§14, §16.7), the extension spawn API and forked skills (§16.9), Grok integration (§15), docs.

## Key tests (in addition to the dossier §10 matrix)

**Messaging and continuation**
- A send during finalization.
- Concurrent sends during a cold resume.
- A send racing a stop.
- A literal `/command` message.
- Nested child → `main`.
- Root → `main`, refused.

**Parking**
- Parking: A→B completing in both orders.
- Owner cancelled during delivery.

**Admission and auto-background**
- Admission at 19/20 with simultaneous calls.
- A cancel during setup.
- Auto-background with a queued sequential tool.
- Completion on the timer tick.

**Results and watchdog**
- Result matrix rows (tool-only, `max_turns`, API error after text, empty).
- Watchdog with a fake clock: long streaming, retry backoff, compaction.

**Notices**
- Notice reload before persistence.
- Notice reload before receipt.

**Fork and worktree**
- Fork → dispose → reload → continue, over compacted, edited and branched parents.
- Worktree with committed-only work.
- Worktree cleanup while parked.

**Hooks**
- A table of hook outcomes, including block together with `continue:false` across hooks.
- Steering arriving during a stop hook.
- Abort during a hook.
- The interrupted SubagentStop fallback.

**Task tools**
- A TaskCompleted veto on a multi-field update.
- TaskCreated rollback keeps the watermark.
- TaskList blocker filtering.
- Metadata null delete.

**Retention**
- Retrieve run N after run N+1, and after a registry rebuild.
