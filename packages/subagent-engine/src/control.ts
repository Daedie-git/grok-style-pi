// Conversation control: the single place that changes run ownership, admission, owner edges, wakes and stops.
// Every mutating method is synchronous. JavaScript runs it to completion, so each call is one transaction
// and nothing is ever awaited while state is inconsistent (plan §16.1, invariant 7).
import type { AgentId, AgentMeta, Envelope, InvocationKind, KilledBy, RunHandle, RunId, RunOutcome, RunSummary } from "./types.ts";

export interface ControlLimits {
	maxConcurrent: number;
	maxDepth: number;
}

export function limitsFromEnv(env: Record<string, string | undefined>): ControlLimits {
	return {
		maxConcurrent: positiveInteger(env.PI_MAX_CONCURRENT_SUBAGENTS) ?? 20,
		maxDepth: positiveInteger(env.PI_MAX_SUBAGENT_SPAWN_DEPTH) ?? 3,
	};
}

function positiveInteger(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return parsed > 0 ? parsed : undefined;
}

export type RunPhase = "reserved" | "running" | "finalizing";
export type Disposition = "active" | "parked" | "evictable" | "stopped";

export interface ActiveRun {
	runId: RunId;
	phase: RunPhase;
	invocation: InvocationKind;
	startedAt: number;
	background: boolean;
	handle?: RunHandle;
	cancelRequested?: KilledBy;
	/** Ids of inbox envelopes this run was started to deliver. */
	envelopeIds: string[];
}

export interface OwnerEdge {
	key: string;
	ownerAgentId: AgentId;
	childAgentId: AgentId;
	childRunId: RunId;
	ownerEpoch: number;
	state: "held" | "routing" | "released";
}

export interface Conversation {
	meta: AgentMeta;
	revision: number;
	/** Bumped on every run reservation; owner edges and stale callbacks compare against it. */
	epoch: number;
	active?: ActiveRun;
	disposition: Disposition;
	/** The previous execution has settled in control but its process-level teardown is still running. */
	exiting?: Promise<void>;
	/** Edges where this conversation is the owner. */
	edges: Map<string, OwnerEdge>;
	wakePending?: string;
	evictAt?: number;
	notified: boolean;
}

export interface InboxView {
	undelivered(): Envelope[];
}

export interface ControlDeps {
	persist: (meta: AgentMeta) => void;
	inboxOf: (agentId: AgentId) => InboxView;
	newRunId: () => RunId;
	now?: () => number;
}

export type ReserveResult =
	| { kind: "reserved"; runId: RunId }
	| { kind: "live"; runId: RunId }
	| { kind: "deferred"; reason: string }
	| { kind: "refused"; reason: string };

export interface FinalizeResult {
	disposition: Disposition;
	/** Terminal notice for the owner/root. Undefined while parked (its report is withheld). */
	report?: "terminal_result" | "terminal_failure" | "stopped";
	/** A continuation reserved for undelivered inbox messages. */
	continuation?: RunId;
	/** Wake reservations made runnable by the slot this run released. */
	wakes: AgentId[];
	summary: RunSummary;
}

export class Control {
	readonly conversations = new Map<AgentId, Conversation>();
	private readonly names = new Map<string, AgentId>();
	private readonly pins = new Map<string, AgentId>();
	private readonly waiting: AgentId[] = [];
	private running = 0;

	private readonly persist: (meta: AgentMeta) => void;
	private readonly inboxOf: (agentId: AgentId) => InboxView;
	private readonly now: () => number;
	private readonly newRunId: () => RunId;

	readonly limits: ControlLimits;

	constructor(limits: ControlLimits, deps: ControlDeps) {
		this.limits = limits;
		this.persist = deps.persist;
		this.inboxOf = deps.inboxOf;
		this.now = deps.now ?? Date.now;
		this.newRunId = deps.newRunId;
	}

	activeRuns(): number {
		return this.running;
	}

	get(agentId: AgentId): Conversation | undefined {
		return this.conversations.get(agentId);
	}

	/** Re-register a persisted conversation (registry rebuild after reload). It holds no slot. */
	restore(meta: AgentMeta): Conversation {
		const existing = this.conversations.get(meta.agentId);
		if (existing) return existing;
		const conversation: Conversation = {
			meta, revision: 0, epoch: meta.runs.length, disposition: meta.stoppedByUser ? "stopped" : "evictable",
			edges: new Map(), notified: true,
		};
		this.conversations.set(meta.agentId, conversation);
		if (meta.name) this.names.set(meta.name, meta.agentId);
		return conversation;
	}

	/** Early, side-effect-free admission check; reserveSpawn rechecks. */
	admissionError(input: { spawnDepth: number; ownerAgentId?: AgentId; uncapped?: boolean }): string | undefined {
		if (input.spawnDepth > this.limits.maxDepth) return `Subagent depth limit reached (${this.limits.maxDepth}).`;
		if (input.ownerAgentId) {
			const owner = this.conversations.get(input.ownerAgentId);
			if (owner?.meta.stoppedByUser || owner?.active?.cancelRequested) return "The spawning agent is being stopped.";
		}
		if (!input.uncapped && this.running >= this.limits.maxConcurrent) return `Too many subagents are running (${this.limits.maxConcurrent}). Wait for one to finish.`;
		return undefined;
	}

	/** `uncapped`: Workflow agents are bounded by the workflow's own permit pool, a separate scheduling layer (plan §18). */
	reserveSpawn(input: { meta: AgentMeta; background: boolean; uncapped?: boolean }): { conversation: Conversation; runId: RunId } | { error: string } {
		const error = this.admissionError({ spawnDepth: input.meta.spawnDepth, ownerAgentId: input.meta.ownerAgentId, uncapped: input.uncapped });
		if (error) return { error };
		if (this.conversations.has(input.meta.agentId)) return { error: `Agent ${input.meta.agentId} already exists.` };
		const runId = this.newRunId();
		const conversation: Conversation = {
			meta: input.meta, revision: 1, epoch: 1, disposition: "active", edges: new Map(), notified: false,
			active: { runId, phase: "reserved", invocation: "spawn", startedAt: this.now(), background: input.background, envelopeIds: [] },
		};
		input.meta.runs.push({ runId, invocation: "spawn", startedAt: conversation.active!.startedAt, status: "running" });
		this.conversations.set(input.meta.agentId, conversation);
		this.running++;
		if (input.meta.name) this.names.set(input.meta.name, input.meta.agentId);
		if (input.meta.ownerAgentId) this.acquireEdge(input.meta.ownerAgentId, input.meta.agentId, runId);
		try {
			this.persist(input.meta);
		} catch (persistError) {
			this.rollbackSpawn(input.meta.agentId, runId);
			return { error: `Could not record the agent: ${(persistError as Error).message}` };
		}
		return { conversation, runId };
	}

	/** Undo a reservation whose startup failed before the run became visible. */
	rollbackSpawn(agentId: AgentId, runId: RunId): void {
		const conversation = this.conversations.get(agentId);
		if (!conversation || conversation.active?.runId !== runId) return;
		this.releaseSlot(conversation);
		conversation.active = undefined;
		this.conversations.delete(agentId);
		if (conversation.meta.name && this.names.get(conversation.meta.name) === agentId) this.names.delete(conversation.meta.name);
		const owner = conversation.meta.ownerAgentId ? this.conversations.get(conversation.meta.ownerAgentId) : undefined;
		owner?.edges.delete(edgeKey(owner.meta.agentId, agentId, runId));
	}

	markRunning(agentId: AgentId, runId: RunId, handle: RunHandle): boolean {
		const active = this.conversations.get(agentId)?.active;
		if (!active || active.runId !== runId) return false;
		active.phase = "running";
		active.handle = handle;
		return true;
	}

	setBackground(agentId: AgentId, runId: RunId): boolean {
		const active = this.conversations.get(agentId)?.active;
		if (!active || active.runId !== runId) return false;
		active.background = true;
		return true;
	}

	/**
	 * Settle a run. Stale finalizers (from a run that is no longer active) are ignored.
	 * Re-reads the inbox in the same transaction, so a message accepted before this call is never stranded.
	 */
	finalize(agentId: AgentId, runId: RunId, outcome: RunOutcome, result: { text: string; truncated: boolean }): FinalizeResult | undefined {
		const conversation = this.conversations.get(agentId);
		if (!conversation || conversation.active?.runId !== runId) return undefined;
		conversation.active.phase = "finalizing";
		const ownEnvelopes = new Set(conversation.active.envelopeIds);
		const summary = conversation.meta.runs.find((run) => run.runId === runId)!;
		Object.assign(summary, {
			endedAt: this.now(), status: outcome.status, classification: outcome.classification, resultText: result.text,
			resultTruncated: result.truncated, usage: outcome.usage,
		});
		if (outcome.killedBy) summary.killedBy = outcome.killedBy;
		this.releaseSlot(conversation);
		conversation.active = undefined;
		conversation.revision++;
		const wakes = this.drainWaiting();
		const finish = (disposition: Disposition, report?: FinalizeResult["report"], continuation?: RunId): FinalizeResult => {
			conversation.disposition = disposition;
			if (disposition === "evictable" || disposition === "stopped") conversation.meta.finished = true;
			this.persist(conversation.meta);
			return { disposition, report, continuation, wakes, summary };
		};
		if (conversation.meta.stoppedByUser) return finish("stopped", "stopped");
		const report = outcome.status === "killed" ? "stopped" : outcome.status === "failed" ? "terminal_failure" : "terminal_result";
		// A run that failed without delivering the messages it was started for must not relaunch for them at once (that would
		// repeat a permanent failure forever); they stay pending until a new message or wake arrives. Newer arrivals still continue.
		const undelivered = this.inboxOf(agentId).undelivered().filter((envelope) => outcome.status !== "failed" || !ownEnvelopes.has(envelope.id));
		if (undelivered.length > 0 && outcome.status !== "killed") {
			// The report still goes out; its notice says another run follows (plan §7, §8).
			const reserved = this.reserveRun(conversation, "continue", undelivered.map((envelope) => envelope.id));
			if (reserved.kind === "reserved") return finish("active", report, reserved.runId);
			conversation.wakePending = "undelivered inbox";
			return finish("parked", report);
		}
		// An owner still waiting on its own children parks and withholds its report (plan §4.3).
		if (this.heldEdges(conversation).length > 0 && outcome.status === "completed") return finish("parked");
		conversation.evictAt = this.now() + EVICTION_GRACE_MS;
		return finish("evictable", report);
	}

	/**
	 * Reserve a continuation for a conversation that is not running: a message arrived, or a child reported to a parked owner.
	 * Returns `live` when a run is already active; the caller delivers into it.
	 */
	reserveContinuation(agentId: AgentId, cause: InvocationKind, envelopeIds: string[]): ReserveResult {
		const conversation = this.conversations.get(agentId);
		if (!conversation) return { kind: "refused", reason: "Unknown agent." };
		if (conversation.active) return { kind: "live", runId: conversation.active.runId };
		if (conversation.meta.stoppedByUser) return { kind: "refused", reason: "This agent was stopped by the user. Treat its work as cancelled." };
		if (conversation.exiting) {
			conversation.wakePending = "previous run still exiting";
			return { kind: "deferred", reason: "The previous run is still shutting down; the message will be delivered when it finishes." };
		}
		return this.reserveRun(conversation, cause, envelopeIds);
	}

	/** Called when a previous execution's teardown completes; returns whether a wake should now be attempted. */
	exited(agentId: AgentId): boolean {
		const conversation = this.conversations.get(agentId);
		if (!conversation) return false;
		conversation.exiting = undefined;
		return Boolean(conversation.wakePending);
	}

	/**
	 * Request a stop. A user-source stop fences the target and every descendant it cancels so nothing revives them automatically.
	 * Returns the agents whose active runs must be cancelled, deepest first.
	 */
	requestStop(agentId: AgentId, source: KilledBy): AgentId[] {
		const target = this.conversations.get(agentId);
		if (!target) return [];
		const affected = [...this.descendants(agentId).reverse(), agentId];
		const toCancel: AgentId[] = [];
		for (const id of affected) {
			const conversation = this.conversations.get(id)!;
			const cascade = id !== agentId;
			if (source === "user") {
				conversation.meta.stoppedByUser = true;
				conversation.meta.stopGeneration++;
				conversation.wakePending = undefined;
				if (!conversation.active) conversation.disposition = "stopped";
				this.persist(conversation.meta);
			}
			if (conversation.active && !conversation.active.cancelRequested) {
				conversation.active.cancelRequested = cascade && source !== "user" ? "parent" : source;
				toCancel.push(id);
			}
		}
		return toCancel;
	}

	/**
	 * Every agent whose ancestry leads to `agentId`, at any depth. The walk does not stop at finished intermediates: a failed
	 * child can still have a running grandchild.
	 */
	descendants(agentId: AgentId): AgentId[] {
		const result: AgentId[] = [];
		const seen = new Set<AgentId>([agentId]);
		const visit = (owner: AgentId) => {
			for (const conversation of this.conversations.values()) {
				const id = conversation.meta.agentId;
				if (conversation.meta.parentAgentId !== owner || seen.has(id)) continue;
				seen.add(id);
				result.push(id);
				visit(id);
			}
		};
		visit(agentId);
		return result;
	}

	// ---- Owner edges (plan §16.2) ----

	private acquireEdge(ownerAgentId: AgentId, childAgentId: AgentId, childRunId: RunId): void {
		const owner = this.conversations.get(ownerAgentId);
		if (!owner) return;
		const key = edgeKey(ownerAgentId, childAgentId, childRunId);
		owner.edges.set(key, { key, ownerAgentId, childAgentId, childRunId, ownerEpoch: owner.epoch, state: "held" });
	}

	/** Mark the edge for a child's run as routing; returns the owner if one is still eligible to receive the report. */
	beginRouting(childAgentId: AgentId, childRunId: RunId): { owner?: Conversation; edge?: OwnerEdge } {
		const child = this.conversations.get(childAgentId);
		const ownerId = child?.meta.ownerAgentId;
		const owner = ownerId ? this.conversations.get(ownerId) : undefined;
		if (!owner) return {};
		const edge = owner.edges.get(edgeKey(owner.meta.agentId, childAgentId, childRunId)) ?? this.anyEdge(owner, childAgentId);
		if (edge?.state === "held") edge.state = "routing";
		const eligible = !owner.meta.stoppedByUser && (owner.active || owner.disposition === "parked");
		return { owner: eligible ? owner : undefined, edge };
	}

	/** Release an edge once its report is committed to a destination. Idempotent and epoch-checked. */
	releaseEdge(edge: OwnerEdge): void {
		const owner = this.conversations.get(edge.ownerAgentId);
		const current = owner?.edges.get(edge.key);
		if (!owner || !current || current.ownerEpoch !== edge.ownerEpoch) return;
		owner.edges.delete(edge.key);
	}

	/** A child moving to a new run (continuation) re-points its owner's edge without changing ancestry. */
	reattachEdge(childAgentId: AgentId, newRunId: RunId): void {
		const child = this.conversations.get(childAgentId);
		if (!child?.meta.ownerAgentId) return;
		this.acquireEdge(child.meta.ownerAgentId, childAgentId, newRunId);
	}

	heldEdges(conversation: Conversation): OwnerEdge[] {
		return [...conversation.edges.values()].filter((edge) => edge.state !== "released");
	}

	private anyEdge(owner: Conversation, childAgentId: AgentId): OwnerEdge | undefined {
		for (const edge of owner.edges.values()) if (edge.childAgentId === childAgentId) return edge;
		return undefined;
	}

	// ---- Names (plan §8) ----

	/**
	 * Resolve a SendMessage/TaskStop target. Agent ids always resolve. Names use the newest binding, but a name this caller
	 * already confirmed for one agent never silently retargets another.
	 */
	resolveTarget(callerKey: string, to: string): { agentId: AgentId } | { error: string } {
		if (this.conversations.has(to)) return { agentId: to };
		const bound = this.names.get(to);
		if (!bound) return { error: `No agent named "${to}". Use the agent id from its launch result.` };
		const pinKey = `${callerKey}\u0000${to}`;
		const pinned = this.pins.get(pinKey);
		if (pinned && pinned !== bound) {
			return { error: `The name "${to}" now refers to a different agent (${bound}) than before (${pinned}). Use the agent id to confirm which one you mean.` };
		}
		this.pins.set(pinKey, bound);
		return { agentId: bound };
	}

	nameTaken(name: string): boolean {
		return name === "main" || this.names.has(name);
	}

	// ---- Eviction (plan §3.3) ----

	/** Conversations whose live resources can be released now. Metadata and run summaries stay on disk. */
	evictable(): Conversation[] {
		const now = this.now();
		return [...this.conversations.values()].filter((conversation) =>
			conversation.disposition === "evictable" && conversation.notified && !conversation.meta.retain && !conversation.meta.pinned
			&& conversation.evictAt !== undefined && conversation.evictAt <= now && this.heldEdges(conversation).length === 0);
	}

	// ---- Internals ----

	private reserveRun(conversation: Conversation, invocation: InvocationKind, envelopeIds: string[]): ReserveResult {
		if (this.running >= this.limits.maxConcurrent) {
			conversation.wakePending = "admission limit";
			if (!this.waiting.includes(conversation.meta.agentId)) this.waiting.push(conversation.meta.agentId);
			return { kind: "deferred", reason: "Too many subagents are running; the agent will resume when a slot frees." };
		}
		const runId = this.newRunId();
		conversation.epoch++;
		conversation.revision++;
		conversation.disposition = "active";
		conversation.wakePending = undefined;
		conversation.evictAt = undefined;
		conversation.notified = false;
		conversation.meta.finished = false;
		conversation.active = { runId, phase: "reserved", invocation, startedAt: this.now(), background: true, envelopeIds };
		conversation.meta.runs.push({ runId, invocation, startedAt: conversation.active.startedAt, status: "running" });
		this.running++;
		this.reattachEdge(conversation.meta.agentId, runId);
		try {
			this.persist(conversation.meta);
		} catch (persistError) {
			conversation.meta.runs.pop();
			this.releaseSlot(conversation);
			conversation.active = undefined;
			conversation.disposition = "evictable";
			conversation.wakePending = "metadata write failed";
			return { kind: "deferred", reason: `Could not record the continuation: ${(persistError as Error).message}` };
		}
		return { kind: "reserved", runId };
	}

	private releaseSlot(conversation: Conversation): void {
		const active = conversation.active as (ActiveRun & { slotReleased?: boolean }) | undefined;
		if (!active || active.slotReleased) return;
		active.slotReleased = true;
		this.running = Math.max(0, this.running - 1);
	}

	private drainWaiting(): AgentId[] {
		const ready: AgentId[] = [];
		while (this.waiting.length > 0 && this.running + ready.length < this.limits.maxConcurrent) ready.push(this.waiting.shift()!);
		return ready;
	}
}

export const EVICTION_GRACE_MS = 30_000;

export function edgeKey(ownerAgentId: AgentId, childAgentId: AgentId, childRunId: RunId): string {
	return `${ownerAgentId}>${childAgentId}#${childRunId}`;
}
