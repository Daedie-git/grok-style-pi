// Shared contracts for the subagent engine. See docs/plans/subagent-engine.md for the behavior each type carries.

export type AgentId = string;
export type RunId = string;

// ---- Definitions (plan §1) ----

export type DefinitionSource = "built-in" | "package" | "user" | "project" | "flag" | "policy";
export type BuiltInKind = "general-purpose" | "Explore" | "Plan" | "fork";
export type MemoryScope = "user" | "project" | "local";

export interface HookCommand {
	type: "command";
	command: string;
	args?: string[];
	timeout?: number;
}

export interface HookMatcherGroup {
	matcher?: string;
	hooks: HookCommand[];
}

/** Claude-format hook configuration keyed by event name. */
export type HookConfig = Partial<Record<HookEventName, HookMatcherGroup[]>>;
export type HookEventName = "SubagentStart" | "SubagentStop" | "TaskCreated" | "TaskCompleted";

export type McpServerSpec = string | { name: string; config: Record<string, unknown> };

export interface AgentDefinition {
	agentType: string;
	/** When-to-use text shown to the model in listings. */
	description: string;
	/** Trimmed markdown body; the definition's system prompt. */
	prompt: string;
	source: DefinitionSource;
	path?: string;
	/** Raw Claude tool language. Undefined or containing "*" inherits; [] means no tools. */
	tools?: string[];
	disallowedTools: string[];
	/** "inherit" means the parent's model. */
	model?: string;
	effort?: string;
	skills: string[];
	maxTurns?: number;
	background?: boolean;
	isolation?: "worktree";
	memory?: MemoryScope;
	hooks?: HookConfig;
	mcpServers?: McpServerSpec[];
	omitClaudeMd?: boolean;
	color?: string;
	/** Parsed for diagnostics only; Pi has no permission modes. */
	permissionMode?: string;
	builtIn?: BuiltInKind;
	diagnostics: string[];
}

// ---- Usage (plan §6, §16.6) ----

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface UsageAccounting {
	/** Sum of every metered request in the run. Engine ledger only. */
	billable: UsageTotals;
	/** Latest metered assistant message: input + cacheWrite + cacheRead + output. Claude's result.totalTokens. */
	latestFootprint: number;
	/** Latest input footprint + accumulated output + outstanding stream estimate. */
	liveMetric: number;
	/** Model ids in order; only adjacent duplicates are collapsed. */
	modelTransitions: string[];
}

// ---- Runs and results (plan §3, §6) ----

export type RunStatus = "running" | "completed" | "failed" | "killed";
export type KilledBy = "user" | "parent" | "session-end" | "watchdog";
export type RunClassification =
	| "completed"
	| "partial-max-turns"
	| "partial-api"
	| "failed-api"
	| "empty-result"
	| "stalled"
	| "killed"
	| "prevented"
	| "hook-cap"
	| "failed";
export type InvocationKind = "spawn" | "continue" | "wake";

export interface ToolStats {
	toolUses: number;
	byTool: Record<string, number>;
}

export interface RunOutcome {
	status: Exclude<RunStatus, "running">;
	classification: RunClassification;
	resultText: string;
	note?: string;
	error?: string;
	killedBy?: KilledBy;
	usage: UsageAccounting;
	toolStats: ToolStats;
	durationMs: number;
}

export interface RunSummary {
	runId: RunId;
	invocation: InvocationKind;
	startedAt: number;
	endedAt?: number;
	status: RunStatus;
	classification?: RunClassification;
	killedBy?: KilledBy;
	resultText?: string;
	resultTruncated?: boolean;
	usage?: UsageAccounting;
	startEntryId?: string;
	endEntryId?: string;
}

// ---- Persisted agent metadata (plan §5) ----

export interface WorktreeInfo {
	path: string;
	branch: string;
	baseCommit: string;
}

export interface AgentMeta {
	agentId: AgentId;
	agentType: string;
	name?: string;
	description: string;
	rootSessionId: string;
	parentAgentId?: AgentId;
	ownerAgentId?: AgentId;
	spawnDepth: number;
	toolUseId?: string;
	cwd: string;
	sessionFile: string;
	taskListId: string;
	backend: "in-process" | "herdr";
	herdr?: { agentId: string; runId?: string; machine?: string };
	isFork?: boolean;
	isBuiltIn?: boolean;
	skill?: { name: string; path: string; scope: string[] };
	forkParent?: { sessionFile: string; leafId: string };
	worktree?: WorktreeInfo;
	worktreeCleanlyRemoved?: boolean;
	/** The caller's directory, before any worktree isolation. */
	originCwd?: string;
	/** A fork's inherited exact system prompt and tool names, kept so a continuation after eviction reproduces them. */
	forkSystemPrompt?: string;
	/** Set on agents started by a Workflow agent() call, so views can nest them under their workflow. */
	workflow?: { taskId: string; runId: string; logicalIndex: number; label?: string; phase?: string };
	forkParentTools?: string[];
	model?: { requested?: string; effective: string };
	effort?: { requested?: string; effective: string };
	definition: AgentDefinition;
	missingTools?: string[];
	stoppedByUser?: boolean;
	stopGeneration: number;
	finished?: boolean;
	retain?: boolean;
	pinned?: boolean;
	runs: RunSummary[];
}

// ---- Messaging (plan §8, §16.1, §17.3) ----

export type EnvelopeState = "pending" | "submitted" | "persisted" | "prepared" | "included" | "consumed" | "refused";

export interface Envelope {
	id: string;
	/** Derived from the caller's toolCallId; dedupes retries. */
	acceptanceKey: string;
	from: AgentId | "main";
	to: AgentId | "main";
	text: string;
	summary?: string;
	createdAt: number;
	state: EnvelopeState;
	runId?: RunId;
	refusedReason?: string;
	/** Set when the envelope carries a child's completion notice to an owner agent. */
	noticeKey?: string;
}

export interface SendReceipt {
	success: boolean;
	delivery?: "queued" | "resumed" | "pending-continuation" | "main";
	envelopeId?: string;
	agentId?: AgentId;
	message: string;
}

// ---- Notifications (plan §7, §16.3) ----

export type ReportKind = "interim_handback" | "terminal_result" | "terminal_failure" | "stopped" | "delivery_refusal";
export type NoticeState = "pending" | "submitted" | "persisted" | "acknowledged";

export interface NoticePayload {
	agentId: AgentId;
	name?: string;
	description: string;
	status: RunStatus;
	classification?: RunClassification;
	resultText: string;
	resultTruncated: boolean;
	transcriptPath: string;
	usage?: UsageAccounting;
	worktree?: WorktreeInfo & { kept: boolean };
	interim?: boolean;
	resumePending?: boolean;
	killedBy?: KilledBy;
	resumable: boolean;
	failure?: string;
	/** Present when the notice reports a Workflow run rather than an agent. */
	workflow?: { name: string; runId: string; taskId: string; agentCount: number; failures: number };
}

export interface NoticeRecord {
	/** `${rootSessionId}:${agentId}:${runId}:${kind}:${sequence}` */
	key: string;
	rootSessionId: string;
	agentId: AgentId;
	runId: RunId;
	kind: ReportKind;
	sequence: number;
	destination: AgentId | "root";
	state: NoticeState;
	/** Passive notices are recorded and displayed without triggering a model turn. */
	passive: boolean;
	payload: NoticePayload;
	createdAt: number;
}

// ---- Backends (plan §4.1) ----

export interface BackendCapabilities {
	liveDelivery: boolean;
	continuation: boolean;
	blockedState: boolean;
	maxTurns: boolean;
	worktree: boolean;
	fork: boolean;
	sharedTasks: boolean;
}

export type BackendEvent =
	| { type: "started" }
	/** The run dispatched its first provider request (its prompt reached the model). */
	| { type: "dispatched" }
	| { type: "progress"; at: number; kind: string }
	| { type: "blocked" }
	| { type: "unblocked" }
	| { type: "turn"; turns: number }
	| { type: "settled"; outcome: RunOutcome }
	| { type: "cancel-acknowledged" }
	| { type: "envelope"; envelopeId: string; state: "persisted" | "included" }
	| { type: "text"; delta: string }
	| { type: "tool"; phase: "start" | "end"; toolCallId: string; toolName: string; isError?: boolean };

export type DeliveryResult =
	| { ok: true; state: "submitted" | "persisted" }
	| { ok: false; reason: "unsupported" | "not-running" | "failed"; message: string };

export interface RunHandle {
	runId: RunId;
	/** Settles after initialization, not when the run ends. */
	started: Promise<void>;
	/** Settles when the run is terminal. */
	execution: Promise<RunOutcome>;
	deliver(envelope: Envelope): Promise<DeliveryResult>;
	/** Requests cancellation; acknowledgement arrives as a backend event. */
	cancel(source: KilledBy): void;
	subscribe(listener: (event: BackendEvent) => void): () => void;
}
