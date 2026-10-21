# Subagent engine, Phase 1: module contracts

Package: `packages/subagent-engine` (branch `subagent-engine`).

- **Plan:** `docs/plans/subagent-engine.md`. Section numbers below refer to it.
- **Shared types:** `packages/subagent-engine/src/types.ts`. Don't change them without telling the coordinator. Put any extra types in your own module.
- **Style:**
  - Tabs, `.ts` import specifiers, strict TypeScript, Node 22.18+/24 type stripping.
  - No runtime dependencies beyond the Pi peer packages.
  - Tests use `node:test` + `node:assert/strict` in `packages/subagent-engine/test/<module>.test.ts`.
  - Run `npm test --workspace subagent-engine` from the repo root.
- **Clean room:** write original code and original prose. Never copy recovered Claude Code JS or prompt text. You may *read* the dossier (`C:/git/claude-sidecar/analysis/claude-code-2.1.303/`) and recovered sources only to confirm behavior.
- **Public Pi APIs only:** no private-field casts.

## A. Definitions — `src/definitions/` (plan §1, §17.8)

`parse.ts`

```ts
export function parseDefinitionFile(text: string, origin: { source: DefinitionSource; path?: string; namespace?: string }): { definition?: AgentDefinition; error?: string };
```

- Parse YAML-like frontmatter: scalars, inline lists `[a, b]`, comma lists, and `- item` lists.
- The body (trimmed, BOM stripped) becomes `prompt`.
- Validation:
  - `name` and `description` are required strings.
  - Reject a name that starts with `-`, contains `:` (outside a package namespace), or is over 64 characters.
- `model`: `inherit`, matched case-insensitively, is normalized to `"inherit"`.
- `tools` and `disallowedTools`:
  - `tools` omitted means `undefined`; an explicit empty list means `[]`.
  - `Agent(a, b)` is kept as one entry.
- `isolation`: only `worktree` is accepted; anything else is a diagnostic.
- `memory` must be `user`, `project` or `local`.
- `hooks`: parse a JSON or YAML mapping where feasible. Otherwise record a diagnostic.
- `mcpServers`: names or inline objects.
- `omitClaudeMd` and `background` are booleans. `maxTurns` is a positive integer.
- `permissionMode` is kept, with a diagnostic saying it is unsupported.
- Package source (`source:"package"`): `hooks`, `mcpServers` and `permissionMode` are ignored with a diagnostic, and the name becomes `namespace:name`.

`builtins.ts`

```ts
export function builtInDefinitions(options: { forkEnabled: boolean }): AgentDefinition[];
```

Each built-in gets *original* prose implementing the behavioral contracts in §1:
- `general-purpose`: inherits tools.
- `Explore`: `disallowedTools` = edit, write, Agent; `omitClaudeMd`; tells the model to locate code, not to review; breadth hint (quick/medium/very thorough); findings returned inline, never as files.
- `Plan`: read-only like Explore; returns an implementation sequence plus 3–5 critical files; `omitClaudeMd`.
- `fork`: only when `forkEnabled`; `maxTurns` 200; model `inherit`. Its fork directive text is exported separately as `FORK_DIRECTIVE(task: string): string`.

`discovery.ts`

```ts
export interface DiscoveryOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	additionalDirs?: string[];
	flagJson?: string;
	policyDir?: string;
	packageDirs?: { dir: string; namespace: string }[];
	forkEnabled: boolean;
	homeDir?: string;
}
export interface DefinitionSet {
	active: Map<string, AgentDefinition>;
	list: AgentDefinition[];
	diagnostics: string[];
	revision: string;
}
export function discoverDefinitions(options: DiscoveryOptions): Promise<DefinitionSet>;
export function selectDefinition(set: DefinitionSet, name: string): { definition?: AgentDefinition; error?: string };
```

- **Priority:** built-in < package < user (`<agentDir>/agents/*.md`) < project < flag < policy. The last assignment by exact `agentType` wins.
- **Project directories:** `.pi/agents`, `.claude/agents` and `.agents/agents`.
  - Additional dirs come first.
  - Then ancestors of `cwd`, ordered shallow to deep (so deeper wins), stopping at `homeDir` or the filesystem root.
  - Skipped entirely when `projectTrusted` is false.
- Deduplicate by realpath. Record duplicates as diagnostics.
- `list` is sorted by name.
- `revision` is a stable hash of the active definitions.
- **`selectDefinition`:**
  1. Exact match first.
  2. Otherwise a normalized match: lowercase, with `_` and space mapped to `-`. More than one normalized match is an error listing the candidates.
  3. A user or project definition named `fork` gets no built-in semantics (`builtIn` unset). When one exists, the built-in fork is removed from `active`, with a diagnostic.

## B. Capabilities, model and effort — `src/context/` (plan §2.3, §2.4, §17.8, §17.9)

`capabilities.ts`

```ts
export interface ToolLite { name: string; mcpServer?: string; source?: string }
export interface SurfaceInput {
	definition: AgentDefinition;
	available: ToolLite[];
	depth: number;
	maxDepth: number;
	background: boolean;
	isFork: boolean;
	parentTools?: string[];
	memoryTools?: string[];
}
export interface ToolSurface {
	active: string[];
	excluded: string[];
	allowedAgentTypes?: string[];
	invalid: string[];
	unavailable: string[];
	memoryScoped: string[];
}
export const CLAUDE_TOOL_ALIASES: Record<string, string>; // Read→read, Bash→bash, Edit→edit, Write→write, Grep→grep, Glob→find, LS→ls, PowerShell→powershell, NotebookEdit→(none)
export const BACKGROUND_ALLOWED: ReadonlySet<string>; // §17.9: read grep find ls bash powershell edit write SendMessage TaskList TaskStop (+ Agent by depth, + MCP)
export const MAIN_THREAD_ONLY: ReadonlySet<string>;
export function compileToolSurface(input: SurfaceInput): ToolSurface;
```

**Fork:** `active` = `parentTools` exactly, minus none. Unknown parent tools are reported through `unavailable`.

**Otherwise**, apply these steps in order:
1. **Availability filter.** For each tool:
   - `Agent` is kept iff `depth < maxDepth`. This check comes *before* the background rule.
   - MCP tools pass.
   - Main-thread-only tools are dropped.
   - When `background` is set, tools outside `BACKGROUND_ALLOWED` are dropped.
2. **Definition denies.** Apply them with alias and MCP expansion: `mcp__server` drops every tool of that server, and `Agent(x)` in a deny drops Agent.
3. **Allow selection.**
   - Undefined or `*` keeps the filtered pool.
   - Otherwise map aliases. `mcp__server` expands. `Agent(a,b)` grants Agent and sets `allowedAgentTypes`.
   - Names unknown to the alias table and not in `available` go to `invalid`. Known names that aren't currently available go to `unavailable`.
4. **Memory tools.** Add them after selection when they aren't already present, list them in `memoryScoped`, and drop any that a deny covers.

`model.ts`

```ts
export interface ModelLite { provider: string; id: string; name?: string }
export function resolveModel(input: { invocation?: string; definition?: string; env: Record<string, string | undefined>; parent: ModelLite; available: ModelLite[]; isFork: boolean }): { model: ModelLite; requested?: string; source: string; note?: string };
export function resolveEffort(input: { invocation?: string; definition?: string; roleDefault?: string; parent?: string; env: Record<string, string | undefined>; isFork: boolean }): { requested?: string; effort?: string; source: string; note?: string };
export function roleDefaultEffort(agentType: string): string | undefined; // review words → high; explore/implement words → medium (match herdr-subagents agent-file.ts defaultThinking)
```

**Model**
- Precedence:
  1. Fork → the parent's model.
  2. `PI_SUBAGENT_MODEL_FORCE`.
  3. Invocation.
  4. Definition. Definition `inherit` → the parent's model, skipping the env default.
  5. `PI_SUBAGENT_MODEL`.
  6. Parent.
- **Matching** a requested string:
  1. Exact `provider/id`.
  2. Exact id across providers.
  3. Claude aliases `sonnet`/`opus`/`haiku`/`fable` → the newest available model whose id contains that word.
  4. Fuzzy: a substring of the id or name.
- **When the request is unavailable:**
  1. Family resolution: the same provider and the same family token (the alphabetic stem of the id, e.g. `gpt`, `claude-sonnet`).
  2. `PI_SUBAGENT_MODEL`.
  3. Parent, with a `note`.

**Effort**
- Precedence:
  1. Fork → the parent's effort.
  2. The `PI_SUBAGENT_EFFORT` env value, when valid.
  3. Invocation.
  4. Definition.
  5. Role default.
  6. Parent.
- Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- Numeric effort or env `unset`/`auto` are ignored, with a `note`.
- Clamping to model support happens later, outside this module.

## C. Results and usage — `src/results.ts` (plan §6, §16.6, v3 matrix)

```ts
export const MAX_RESULT_CHARS = 100_000;
export class UsageTracker {
	onAssistantMessage(message: { usage?: {input:number;output:number;cacheRead:number;cacheWrite:number;totalTokens?:number;cost?:{total:number}}; model?: string; stopReason?: string }, options?: { metered?: boolean }): void;
	onStreamEstimate(outstandingTokens: number): void;
	snapshot(): UsageAccounting;
	notificationTokens(): number; // max(liveMetric, latestFootprint)
}
export interface ExtractInput {
	messages: unknown[];
	maxTurnsReached: boolean;
	aborted?: { killedBy: KilledBy };
	background: boolean;
	error?: { message: string; retryable: boolean };
	durationMs: number;
	usage: UsageAccounting;
}
export function extractOutcome(input: ExtractInput): RunOutcome & { foregroundRecovered?: boolean };
export function truncateResult(text: string, max?: number): { text: string; truncated: boolean };
export function retryableApiError(errorMessage: string | undefined): boolean; // rate_limit / overloaded / server_error
```

- **Message shapes:** Pi `AgentMessage`s with role `assistant`, content blocks `text` / `toolCall` / `thinking`, `stopReason` and `usage`.
- **Result text:** walk backwards for the last assistant message that has text, skipping `stopReason` `error` or `aborted`.
- **Outcome matrix** (§6, as amended in v3):

  | Case | Outcome |
  |---|---|
  | No assistant message | `failed` / `empty-result` |
  | Assistant messages but no text | `completed`, empty text, note |
  | `maxTurnsReached` | `completed` / `partial-max-turns`, note |
  | Aborted | `killed` + `killedBy` |
  | API error, background | `failed` / `failed-api`, partial text kept |
  | API error, foreground, retryable, with prior text | `failed` / `partial-api`, `foregroundRecovered: true`, text kept |
  | API error, foreground, otherwise | `failed` / `failed-api` |
- **Tool stats:** count `toolCall` blocks per name.
- **Usage fixture** (must be a test): two responses (10,2,3,1) and (20,4,5,2), with no stream estimate. Expected:
  - `latestFootprint` 31
  - billable `totalTokens` sum 47
  - latest input footprint 29
  - accumulated output 3
  - `liveMetric` 32
  - `notificationTokens` 32
- **Model transitions:** A→B→A keeps all three, and only adjacent duplicates collapse. Unmetered messages (`metered:false`) don't update the footprint.

## D. Agent store and outbox — `src/store/` (plan §5, §7, §16.3, §17.3)

`paths.ts`

```ts
export function engineRoot(agentDir: string): string; // <agentDir>/subagents
export function sessionDir(agentDir: string, rootSessionId: string): string;
export function agentFiles(agentDir: string, rootSessionId: string, agentId: AgentId): { sessionFile: string; metaFile: string; inboxFile: string };
export function newAgentId(): AgentId; // "a" + 16 hex
export function newRunId(): RunId;     // "r" + 16 hex
```

`meta.ts`

```ts
export function writeMeta(file: string, meta: AgentMeta): void;  // atomic: write temp + rename; omit undefined optional fields
export function readMeta(file: string): AgentMeta | undefined;   // undefined if missing; throws a typed error if corrupt
export function listMetas(dir: string): AgentMeta[];
```

`outbox.ts`

```ts
export class Outbox {
	constructor(file: string);
	/** Assigns sequence on creation; idempotent per (agentId, runId, kind, sequence). */
	create(input: Omit<NoticeRecord, "key" | "sequence" | "state" | "createdAt">): NoticeRecord;
	pending(destination?: string): NoticeRecord[];
	mark(keys: string[], state: NoticeState): void;
	/** Receipt from persisted session entries whose details.noticeKeys contain the key. */
	observePersisted(entries: { type: string; customType?: string; details?: unknown }[]): string[];
	/** On reload: submitted-but-not-persisted → pending. */
	recover(): void;
	get(key: string): NoticeRecord | undefined;
}
```

- **Storage:** an append-only JSONL log of state transitions, compacted on load. Survives process restart.
- **Key format:** `${rootSessionId}:${agentId}:${runId}:${kind}:${sequence}`.
- **Sequence:** per (agentId, runId), starting at 1.
- **`create`:** called again with the same `(agentId, runId, kind)` while an earlier record of that kind is still unacknowledged, it returns the existing record. A different kind gets the next sequence.
- **`InboxStore`** goes in `inbox.ts`, with the same durability approach. Its contract:

  ```ts
  export class InboxStore {
  	constructor(file: string);
  	accept(input: { acceptanceKey: string; from; to; text; summary? }): { envelope: Envelope; duplicate: boolean } | { conflict: true }; // same key+payload → duplicate; same key different payload → conflict
  	setState(id: string, state: EnvelopeState, extra?: { runId?: string; refusedReason?: string }): void;
  	undelivered(): Envelope[]; // anything not included/consumed/refused
  	all(): Envelope[];
  }
  ```

## E. Coordinator-owned (not for implementers)

- `src/control.ts`: conversation transaction, admission, owner edges.
- `src/backends/*`: in-process backend and broker.
- `src/extension.ts`, `src/child-installer.ts`, `src/tools/*`.
- `src/context/prompt.ts` and `src/context/fresh.ts`.

## F. Prompt and tool text — `src/context/prompt.ts`, `src/policy/text.ts` (plan §1, §2.1, §7, §14, §16.7)

Write all prose originally. Never paraphrase recovered Claude text line by line; write it from the behavioral requirements.

`prompt.ts`

```ts
export function childSystemPrompt(input: { definition: AgentDefinition; cwd: string; isBackground: boolean; memoryIndex?: string }): string;
// Wraps the definition body. Must cover:
// - Absolute-path and cwd guidance.
// - Authority: the delegation and later steering direct the work, but cannot supply user consent or authorize permission,
//   configuration or instruction-file changes.
// - Final-report guidance: the final message is the handback, so be complete and concise, and give file paths.
// - Messages from other agents arrive as "agent-message" entries.
export function taskMessage(input: { prompt: string; preloadedSkills: { name: string; content: string }[] }): string;
// The delegation prompt first, then each preloaded skill in a delimited section, bounded to 20k chars total
// (the plan's preload-after-delegation order).
export function contextFilePolicy(definition: AgentDefinition): "all" | "none" | "managed-only";
// omitClaudeMd: built-in and policy definitions → "none"; other sources → "managed-only"; otherwise "all".
```

`policy/text.ts`

```ts
export interface PolicyInput { autonomy: "positive" | "explicit"; forkEnabled: boolean; offered: { agentType: string; description: string; tools?: string[] }[]; exploreAvailable: boolean }
export function agentToolDescription(input: PolicyInput): string;   // the stable part; the Agent tool description
export function sessionGuidance(input: PolicyInput): string | undefined; // system-prompt section; undefined when Agent unavailable
export function listingText(added: PolicyInput["offered"], removed: string[], initial: boolean): string;
export function launchResultText(input: { agentId: string; name?: string; description: string; background: boolean }): string;
export function noticeText(payload: NoticePayload): string;          // first line is a short title, e.g. "Agent completed: <description>"
export const SEND_MESSAGE_DESCRIPTION: string;
export const TASK_STOP_DESCRIPTION: string;
```

- **What the text covers:** §14's guidance list for the positive profile; explicit-only mode suppresses positive nudges; fork guidance appears only when `forkEnabled`; the Explore >3-queries route appears only when fork is unavailable and Explore is offered.
- **Launch result (§7):** the agent id is internal metadata, not text to quote to the user; use SendMessage to continue the agent; you will be notified; don't poll, sleep, read the live transcript or predict findings; keep working.
- **Notices (§7):** cover partial, interim, resume-pending, cancellation-source and resumability cases, plus a reminder to verify actual code changes.
- **Tests:** per-channel golden assertions, both required and forbidden substrings, across the positive, explicit, fork-enabled and no-offered-types profiles.

## G. Worktree isolation — `src/worktree.ts` (plan §12, v3)

```ts
export interface WorktreeHandle { path: string; branch: string; baseCommit: string; repoRoot: string }
export function createWorktree(input: { cwd: string; stateRoot: string; agentId: string; exec?: Exec }): Promise<WorktreeHandle>; // git worktree add -b agent-<id> <stateRoot>/worktrees/<id> HEAD
export function inspectWorktree(handle: WorktreeHandle, exec?: Exec): Promise<{ changed: boolean; dirty: boolean; commitsAhead: number; error?: string }>;
export function cleanupWorktree(handle: WorktreeHandle, exec?: Exec): Promise<{ removed: boolean; kept: boolean; reason: string; commits: string[] }>; // keep when changed or on any error; remove worktree + delete branch only when verified unchanged; never commit
export function restoreWorktree(meta: { worktree?: WorktreeHandle; worktreeCleanlyRemoved?: boolean }, exec?: Exec): Promise<{ path: string } | { error: string }>; // re-add from branch if missing, else error
export function translationNote(inheritedRoot: string, childRoot: string): string | undefined;
type Exec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
```

- **Tests** use real temporary git repos: unchanged → removed; dirty → kept; untracked → kept; committed-only → kept; failed inspection → kept; restore after removal.
- **Windows-safe:** no shell strings; paths are passed as args.

## H. Shared task list store — `src/tasks/` (plan §10, §16.8, §17.5)

`store.ts`

```ts
export interface SharedTask { id: string; subject: string; description: string; activeForm?: string; owner?: string; status: "pending" | "in_progress" | "completed"; blocks: string[]; blockedBy: string[]; metadata?: Record<string, unknown> }
export interface TaskHooks {
	created?(task: SharedTask): Promise<{ block?: string }>;
	completed?(before: SharedTask): Promise<{ block?: string }>;
}
export class TaskStore {
	constructor(input: { root: string; listId: string; hooks?: TaskHooks; now?: () => number });
	create(input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): Promise<{ task?: SharedTask; error?: string }>;
	get(taskId: string): Promise<SharedTask | null>;
	list(): Promise<{ id: string; subject: string; status: string; owner?: string; blockedBy: string[] }[]>;
	update(taskId: string, patch: { subject?; description?; activeForm?; status?: SharedTask["status"] | "deleted"; addBlocks?: string[]; addBlockedBy?: string[]; owner?: string; metadata?: Record<string, unknown> }): Promise<{ task?: SharedTask | null; error?: string; updatedFields: string[] }>;
	claim(taskId: string, owner: string, options?: { busyCheck?: boolean }): Promise<{ ok: boolean; reason?: string }>;
}
export function sanitizeListId(id: string): string;
export function resolveTaskListId(env: Record<string, string | undefined>, rootSessionId: string): string; // PI_TASK_LIST_ID else session id
```

- **Storage:**
  - Records live at `<root>/<sanitized listId>/<sanitized id>.json`, with `.highwatermark`.
  - The list lock (`<list>/.lock`) is an mkdir lock: stale after 10 s, heartbeat every 5 s, up to 30 retries with 5–100 ms backoff.
  - Per-task locks use `<id>.json.lock`. When both are needed, take the list lock **first**, then task locks in ascending numeric id order.
  - Every read-modify-write happens inside the lock, with an atomic write (temp file + rename).
- **Create:**
  - Id = max(existing numeric ids, highwatermark) + 1.
  - The task starts pending, ownerless, with empty edges.
  - The `created` hook runs *outside* the lock. On block, delete the task (raising the watermark first) and return an error.
- **Get:** a narrow projection or `null`.
- **List:**
  - Numeric sort (ids 2 before 10).
  - Omit tasks where `metadata._internal` is truthy.
  - Return summary fields only.
  - `blockedBy` hides completed tasks in the output only; storage is unchanged.
- **Update:**
  - Metadata merges per key; `null` deletes a key.
  - `owner` is plain assignment.
  - `addBlocks`/`addBlockedBy` are reciprocal and deduplicated, written as two separate updates. A missing endpoint is never created, and there is no cycle check.
  - Completing a task keeps its edges.
  - `deleted` raises the watermark, removes the record, and strips reciprocal references.
  - The `completed` hook runs only on a transition into `completed`, using the stored subject and description from before the update. On block, nothing in that call is committed; it fails with the feedback.
- **Claim** (internal):
  - Under the task lock, reject if the task is missing, owned by someone else, completed, or has open blockers. A missing blocker doesn't count as open, and a same-owner claim is allowed.
  - `busyCheck` additionally takes the list lock and rejects when this owner already has another non-completed task.
- **Tests** cover two concurrent processes claiming (one wins), claim vs update, delete vs edge-add, watermark after delete and after hook rollback, the completion veto on a multi-field update, list filtering and order, and metadata null-delete.

## I. Hooks — `src/hooks/` (plan §9, §17.16, §17.5 task payloads)

`config.ts`

```ts
export interface HookSources { agentDir: string; cwd: string; projectTrusted: boolean; definition?: AgentDefinition }
export function loadHooks(sources: HookSources): { config: HookConfig; diagnostics: string[] };
export function matching(config: HookConfig, event: HookEventName, matchValue?: string): HookCommand[];
```

- **Hook files:**
  - `<agentDir>/hooks.json`
  - `<cwd>/.pi/hooks.json`, only when the project is trusted
  - `definition.hooks` (package definitions already have none)
- **Format:** the Claude format `{ "hooks": { "SubagentStop": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "...", "args"?: [...], "timeout"?: seconds }] }] } }`. A bare event map without the `hooks` wrapper is also accepted. Non-command hook types produce a diagnostic and are ignored.
- **Matching:**
  - SubagentStart and SubagentStop match `agent_type` against the matcher: regex or exact; `*` or empty matches everything.
  - Task events ignore matchers.

`runner.ts`

```ts
export interface HookRunResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; missingScript: boolean; json?: Record<string, unknown>; jsonError?: string }
export function runHook(command: HookCommand, input: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal; env?: Record<string, string> }): Promise<HookRunResult>;
```

- Exec form when `args` is present (no shell); shell form otherwise.
- JSON input goes to stdin. The default timeout is 60 s.
- `missingScript` is set for exit 127, or for exit 2 whose stderr says not found / no such file / cannot find for the hook's script.

`decide.ts` (pure)

```ts
export type StopDecision = { kind: "allow" } | { kind: "prevent"; reason?: string } | { kind: "feedback"; messages: string[] };
export function decideStop(results: HookRunResult[]): { decision: StopDecision; diagnostics: string[] };
export function decideStart(results: HookRunResult[]): { contextMessages: string[]; diagnostics: string[] };
export function decideTask(results: HookRunResult[]): { block?: string; diagnostics: string[] };
export class StopLoopState {
	constructor(cap?: number);
	get stopHookActive(): boolean;
	onFeedbackRetry(): { allowed: boolean; warning?: string };
	onToolTurn(): void;
}
export function stopInput(common: Record<string, unknown>, extra: { agentId: string; agentType: string; transcriptPath: string; lastAssistantMessage: string; stopHookActive: boolean; backgroundWork?: string[] }): Record<string, unknown>;
export function startInput(common: Record<string, unknown>, extra: { agentId: string; agentType: string }): Record<string, unknown>;
export function taskInput(common: Record<string, unknown>, task: { id: string; subject: string; description: string }): Record<string, unknown>;
```

- **`decideStop` precedence across all hooks**, highest first:
  1. Any `continue:false` → prevent. It beats every block.
  2. Missing-script exception → diagnostic only.
  3. Exit 2 → feedback from stderr, even when stdout JSON is malformed.
  4. `decision:"block"` → feedback from `reason`, or "Blocked by hook".
  5. `hookSpecificOutput.additionalContext` → feedback.
  6. Exit 0 with no JSON, `continue:true` alone, or plain stdout → nothing.
  7. Invalid JSON, a timeout, or another nonzero exit → diagnostic.
- **`decideStart`:** blocking errors and `additionalContext` become child-context messages. It never vetoes the launch.
- **`decideTask`:** exit 2 or `decision:"block"` blocks, with feedback.
- **`StopLoopState`:**
  - The cap comes from `PI_STOP_HOOK_BLOCK_CAP` and defaults to 8. A nonpositive cap disables it.
  - With the default cap, 8 feedback retries are allowed and the 9th is overridden with a warning.
  - `onToolTurn` resets the consecutive count, but `stopHookActive` stays true.
- **`taskInput`** includes `task_id`, `task_subject` and `task_description`, and no team fields.
- **Tests:**
  - A precedence table covering every pair of rules.
  - A real child-process hook in exec form, through `process.execPath` and an `.mjs` script.
  - Timeout and missing-script cases.
  - The cap sequence, and the reset after a tool turn.

## J. Fork history repair — `src/context/fork.ts` (plan §2.2 with the v3 order correction)

```ts
export interface ForkSnapshotInput {
	branch: SessionEntry[];       // root→leaf of the parent's current branch (ctx.sessionManager.getBranch())
	spawningToolCallId: string;   // the Agent tool call creating the fork
	directive: string;            // FORK_DIRECTIVE(task)
	childSessionId: string;
	cwd: string;
	parentSessionFile?: string;
	now: () => string;
}
export function buildForkEntries(input: ForkSnapshotInput): { header: SessionHeader; entries: SessionEntry[]; removed: string[] };
export function writeForkSession(file: string, built: ReturnType<typeof buildForkEntries>): void;
```

1. **Partition** out the assistant entry that contains `spawningToolCallId`, together with every `toolResult` entry for *any* of its calls.
2. **Drop dangling groups:** for every other assistant entry, if any of its tool calls has no matching `toolResult` in the branch, remove that assistant entry and all of its result entries.
3. **Compaction:** keep a compaction entry only if its `firstKeptEntryId` survives. Otherwise choose one documented way to handle it and test it.
4. **Context edits:** apply each `context_edit` (omit or replace) to a copy of its target, then drop the edit entries.
5. **Append the fork turn:**
   - A copy of the spawning assistant message, with a new id.
   - A placeholder `toolResult` for **every** call in it, including siblings that already finished.
   - The directive as a user message.
6. **Rechain** `parentId` over the final list, as the last step. The new header gets `id = childSessionId`, `parentSession` for lineage only, and `version: 3`.

**Tests:**
- A finished sibling Read whose real result must be absent and replaced by a placeholder.
- A sequential batch.
- An older dangling assistant entry.
- Compaction, both surviving and not surviving.
- A context edit.
- The written file loaded through `SessionManager.open` and `buildSessionContext`, checked for valid ordering and no orphan tool results.

## K. Agent memory and skills — `src/memory.ts`, `src/skills.ts` (plan §11, §17.8, §16.9 v3)

```ts
export function memoryDir(scope: MemoryScope, input: { agentDir: string; cwd: string; agentType: string }): string;
export function memoryIndex(dir: string, limit?: number): string | undefined;
export function memoryPathGuard(dir: string): (toolName: string, args: Record<string, unknown>) => string | undefined;

export interface SkillInfo { name: string; path: string; description: string; content: string; context?: "fork"; agent?: string; model?: string; effort?: string; allowedTools?: string[]; disableModelInvocation: boolean }
export function loadSkills(input: { agentDir: string; cwd: string; projectTrusted: boolean }): SkillInfo[];
export function preloadSkills(names: string[], skills: SkillInfo[]): { name: string; content: string }[];
export function forkContextSkills(skills: SkillInfo[], origin: "user" | "model"): SkillInfo[];
export function skillAgentType(name: string): string;
```

- **`memoryIndex`:** returns `MEMORY.md`, bounded to 8k by default.
- **`memoryPathGuard`:** applies to memory-only grants. It returns a block reason when a tool's path argument leaves the memory directory.
- **`loadSkills`:**
  - Mirror Pi's real skill locations in `dist/core/skills.js`.
  - Project skills load only when the project is trusted.
  - Parse frontmatter including `context`, `agent`, `model`, `effort`, `allowed-tools` and `disable-model-invocation`.
- **`forkContextSkills`:** returns only `context: fork` skills. For model-originated calls it also excludes `disableModelInvocation` skills.
- **`skillAgentType`:** returns `skill:<name>`.

## L. Task tools — `src/tasks/tools.ts` (plan §10, §17.5, §17.9)

```ts
export function registerTaskTools(pi: ExtensionAPI, input: { store: () => TaskStore; caller: { agentId?: string }; tools?: ("TaskCreate" | "TaskGet" | "TaskList" | "TaskUpdate")[] }): void;
```

- **Input schemas** match the installed Claude Code `sdk-tools.d.ts` exactly:
  - TaskCreate `{subject, description, activeForm?, metadata?}`
  - TaskGet `{taskId}`
  - TaskUpdate `{taskId, subject?, description?, activeForm?, status?: pending|in_progress|completed|deleted, addBlocks?, addBlockedBy?, owner?, metadata?}`
  - TaskList `{}`
- **Output** is a compact projection the model can read.
- **Descriptions** are original text. They explain the shared task list, that `owner` is plain assignment, and that completed blockers are hidden.
- **`tools`** limits which tools are registered.
- **Tests** use a real `TaskStore` in a temp dir and a fake `pi` that captures `registerTool`.

## M. Grok integration (plan §14, §15) — root package: `integrations/`, `src/subagents/`, `src/activity/`, `src/tools/sections/`, `src/extension/features.ts`, README, root tests

The engine (`packages/subagent-engine`) replaces `@tintinweb/pi-subagents`. Respect the repo `AGENTS.md`: tabs, `.ts` imports, documented Pi APIs, and diamond rules (route mouse handling through `src/tools/interaction.ts`).

### Integration entry

`integrations/subagents.ts` always loads `createSubagentEngine({ autonomy, onEngine })` from `packages/subagent-engine/src/extension.ts` (in-process). Inside Herdr (`HERDR_ENV=1`), it additionally keeps the Herdr child-side runner working. **Until Herdr backend mode lands (module N), keep today's Herdr behavior unchanged when `HERDR_ENV=1`**, and leave a clearly marked TODO hook for N. Remove the `@tintinweb/pi-subagents` dynamic import path and dev dependency, and the `test:subagents` script with its test, once nothing uses them.

### Autonomy

- Add `autonomy` (default `on`) to `/grok-style` feature settings (`src/extension/features.ts`).
- `on` → `autonomy: "positive"`; `off` → `"explicit"`.
- Stop applying `withoutSubagentInitiative` / `EXPLICIT_SUBAGENT_REQUEST` to engine tools. The engine's own policy text handles both modes.
- Keep the Herdr runner's policy text untouched while Herdr is still the separate path.

### Activity panel

- Feed the panel from engine events through `engine.subscribe`:
  - `spawned` → a new entry `agent:<agentId>`, title `<agentType>: <description>`, status `running`, model from `meta.model.effective` and `meta.effort.effective`.
  - `run-event` text deltas and tool start/end → the live transcript (bounded as today).
  - `settled` → status `completed` / `failed` / `stopped`.
- **Stop** calls `engine.userStop(agentId)`, a user-source stop.
- Replace `src/subagents/adapter.ts` (Pi Subagents coupling) with an engine adapter that keeps the panel's `Activity` contract. Delete the old adapter and its tests once unused.

### Rendering

Collapsed diamonds, with Ctrl+O to expand, for these tools:

| Tool | Collapsed row |
|---|---|
| `Agent` | `◆ <type>: <description>` |
| `SendMessage` | `◆ Message <to>` |
| `TaskStop` | `◆ Stop agent <id>` |
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | e.g. `◆ Task #3 · in_progress` |
| `get_subagent_result` | Same styling as today |
| `steer_subagent` | Same styling as today |

Message renderers for these custom types:

| Custom type | First line is the title |
|---|---|
| `subagent-notification` | Yes, as with the Herdr notice renderer |
| `subagent-message` | Yes |
| `agent-message` | Yes |
| `subagent-stop-feedback` | Yes |

### Child sessions

The Grok chrome must stay inert inside engine children. Import `inChildContext` from the engine and return early in the Grok extension factory when it is true. Child sessions load user extensions, Grok included.

### README

Rewrite the Grok README's subagent sections for the engine: tools, autonomy setting, activity, rendering. Point to `packages/subagent-engine/README.md` for engine behavior; that file may not exist yet, so link it anyway.

### Tests

Update or replace the root tests touching subagents: `subagent-contract`, `herdr-integration`, `activity`, `subagent-result-style`, `section-registration`. `npm test` at the repo root must pass, apart from the engine package's own suite, which may be mid-change.

## N. Herdr backend mode (plan §13, §17.5, §17.6) — `packages/herdr-subagents/src/herdr/*` plus the new file `packages/subagent-engine/src/backends/herdr.ts`

**Goal:** the engine uses Herdr panes as a second backend, but only when asked. That means the `machine` option, `runtime: "claude-code"`, or an explicit `backend: "pane"`. In-process stays the default. Herdr stays authoritative for its runs, ids, blocked state, cancellation acknowledgement and outbox.

### Herdr package

Add a headless backend mode without breaking any existing protocol, database, marker, entry type, customType or test:

```ts
createHerdrSubagents({ ...overrides, mode: "backend", onBackend(handle: HerdrBackendHandle) {} })
```

- **Backend mode installs:**
  - The child-side lifecycle (`createChildSession`, input authorization, tool filtering), so Pi panes that load this package keep working.
  - The parent poll loop for maintenance and notices.
- **Backend mode does not:**
  - Register `Agent` / `get_subagent_result` / `steer_subagent`.
  - Call `pi.sendMessage` for notices.
- **Notice delivery:** notices go to `handle.onNotice` listeners. A notice is acknowledged only after the engine calls `handle.acknowledge(noticeId)`, once it has committed the notice to a destination.

```ts
interface HerdrBackendHandle {
	spawn(request: Omit<SpawnRequest, "paneId" | "tabId" | "workspaceId" | "sessionFile" | "agentDir"> & { machine?: string; machineCwd?: string }, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ agentId: string; runId: string; text: string }>;
	read(agentId: string, options: { runId?: string; wait?: boolean; signal?: AbortSignal }): Promise<{ status: string; text: string; runId?: string }>;
	steer(agentId: string, message: string): Promise<{ ok: boolean; message: string }>;   // unsupported for Claude Code → ok:false
	resume(agentId: string, prompt: string, ctx: ExtensionContext): Promise<{ runId: string; text: string }>;
	cancel(agentId: string): Promise<{ acknowledged: boolean; message: string }>;
	capabilities(agentId: string): { liveDelivery: boolean; maxTurns: boolean; fork: false; sharedTasks: boolean };
	onNotice(listener: (notice: { noticeId: string; agentId: string; runId: string; content: string; machine?: string }) => void): () => void;
	acknowledge(noticeId: string): Promise<void>;
}
```

### Engine side

`src/backends/herdr.ts` exports `HerdrBackendAdapter`. It wraps the handle and maps it onto engine concepts. It is new code only; the coordinator does the wiring into `engine.ts`:

- A proxy `AgentMeta` with `backend: "herdr"` and `herdr: { agentId, runId, machine }`.
- Capability-aware delivery: unsupported delivery returns an explicit unsupported result.
- A `notice → (agentId, runId, text)` stream.

### Tests

- The existing Herdr tests must all pass unchanged: `npm test --workspace herdr-subagents`.
- Add backend-mode tests: no tool registration, notices routed to the listener and acknowledged only on `acknowledge`, and child-side lifecycle still active.

## O. Workflow core — `src/workflow/` (plan §18; dossier `workflow*.md`, especially `workflow-reconstruction.md`)

Standalone and engine-agnostic. Agent execution goes through an injected `WorkflowHost`, so everything is testable with a fake host. Add `acorn` (MIT) as the package's only runtime dependency, in `packages/subagent-engine/package.json`.

```ts
// host.ts — implemented by the coordinator in engine.ts
export interface WorkflowAgentRequest {
	prompt: string;
	label?: string;
	phase?: string;
	schema?: Record<string, unknown>;
	model?: string;
	effort?: string;
	isolation?: "worktree";
	agentType?: string;
	disallowedTools?: string[];
	bashCommandClamp?: string[];
	runId: string;
	taskId: string;
	logicalIndex: number;
	attempt: number;
	signal: AbortSignal;
}
export interface WorkflowAgentResult {
	status: "completed" | "failed" | "killed";
	agentId: string;
	text: string;
	structured?: { ok: true; value: unknown } | { ok: false; error: string };
	outputTokens: number;
	stalled?: boolean;
	error?: string;
}
export interface WorkflowHost {
	runAgent(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>;
	sessionOutputTokens(): number;
	loadNamed(name: string): Promise<{ source: string; path: string } | undefined>;
	readScriptPath(path: string): Promise<{ source: string; canonicalPath: string }>;
	progress(event: WorkflowProgress): void;
}
export type WorkflowProgress =
	| { type: "agent"; logicalIndex: number; label?: string; phase?: string; state: "queued" | "start" | "done" | "failed" | "cached"; agentId?: string }
	| { type: "phase"; index: number; title: string }
	| { type: "log"; message: string };
```

| File | Exports | Notes |
|---|---|---|
| `meta.ts` | `parseWorkflowSource(source) → { meta: {name, description, title?, whenToUse?, phases[]}, body, error? }` | The first statement must be `export const meta = {...}`, parsed with acorn and evaluated structurally (dossier §5 rules). |
| `compile.ts` | `compileBody(body) → { ok, error? }` | Syntax check of the strict async wrapper. Rejects dynamic import, `with`, `await using` and the reserved identifiers. |
| `vm.ts` | `runInRealm({ body, globals, timeoutMs = 30_000, signal }) → Promise<unknown>` | Fresh `node:vm` context, `codeGeneration: { strings: false, wasm: false }`, Date and random shims, owned timers disposed on exit, results copied out with `structuredClone`, function returns rejected. |
| `replay.ts` | `canonicalOptions(opts)`, `chainKey(prev, prompt, opts)`, `ReplayState`, `chooseReplay(...)` | Exactly as `workflow-reconstruction.md` §8. |
| `journal.ts` | `WorkflowJournal` | JSONL `launched` / `started` / `failed` / `result` events. Torn-tail tolerant. `load()` returns `results` / `started` / `failed` / `scriptSha256`. Appends are awaited for result and failed events. |
| `permits.ts` | `FifoPermits(n)` | Queued waiters acquire after an abort and then release. Also `defaultConcurrency(env)`. |
| `runtime.ts` | `runWorkflow(input) → Promise<WorkflowRunResult>` | See below. |
| `discovery.ts` | `discoverWorkflows({ agentDir, cwd, projectTrusted, homeDir, bundled }) → Map<name, { path, source, origin }>` | Plan §18 discovery. |

`runtime.ts` input and output:

```ts
// input
{ source, args, host, runId, taskId, journal, replay, signal, maxCalls = 1000 }
// output
WorkflowRunResult = { status: "completed" | "failed" | "killed"; result?: unknown; error?: string; agentCount: number; logs: string[]; failures: { index: number; error: string }[]; durationMs: number }
```

`runtime.ts` implements `agent`, `parallel`, `pipeline`, `phase`, the child `workflow` (one nesting level, fresh realm, shared permits, budget and counters), `log`, and `budget` with `total: null`. It also handles the stall retries (up to 5, same logical index), the structured-output invalid-attempt cap (5) and the 4,096-element array caps. Remote isolation is rejected.

**Tests** cover the dossier's deterministic fixture matrix (`workflow-reconstruction.md` §11), excluding the rows about permission UI and path authority, which the coordinator wires. Use a fake host, a fake clock and barriers; no model calls.
