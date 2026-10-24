import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMeta, BackendEvent, DeliveryResult, Envelope, KilledBy, RunHandle, RunOutcome } from "../types.ts";
import { launchResultText } from "../policy/text.ts";

export type PanePhase = "queued" | "starting" | "running" | "blocked" | "completed" | "failed" | "stopped";
export type PaneTerminalPhase = Extract<PanePhase, "completed" | "failed" | "stopped">;
export interface PaneRead { phase: PanePhase; resultText: string; text: string; status: string; runId?: string }
export interface PaneNotice { noticeId: string; agentId: string; herdrAgentId: string; runId: string; phase: PaneTerminalPhase; text: string; machine?: string }
export interface PaneRequest {
	prompt: string; description: string; subagentType: string; cwd: string; runInBackground: boolean;
	runtime?: "pi" | "claude-code"; name?: string; model?: string; thinking?: string; maxTurns?: number;
	projectTrusted?: boolean; definitionsCwd?: string; machine?: string; machineCwd?: string; keep?: boolean;
	/** Replaces the pane's own agent-file lookup. `allowedTools` undefined allows every tool. */
	resolved?: { instructions?: string; allowedTools?: string[] };
}
/** Structural engine-owned port; no dependency on Herdr's unpublished package layout. */
export interface HerdrRunsPort {
	proxy(meta: AgentMeta, ref: { agentId: string; runId: string; machine?: string }): AgentMeta;
	spawn(request: PaneRequest, ctx: ExtensionContext, meta: AgentMeta, signal?: AbortSignal): Promise<{ agentId: string; runId: string; text: string; meta: AgentMeta }>;
	resume(meta: AgentMeta, prompt: string, ctx: ExtensionContext): Promise<{ runId: string; text: string; meta: AgentMeta }>;
	read(meta: AgentMeta, options?: { runId?: string; wait?: boolean; signal?: AbortSignal }): Promise<PaneRead>;
	deliver(meta: AgentMeta, envelope: Envelope): Promise<DeliveryResult>;
	cancel(meta: AgentMeta): Promise<{ acknowledged: boolean; message: string }>;
	onNotice(listener: (notice: PaneNotice) => void): () => void;
	acknowledge(noticeId: string): Promise<void>;
	/** This Pi is itself a Herdr pane child. */
	paneChild?(): boolean;
}
export interface RunSettlingResult { ok: false; reason: "not-running"; settling: true; message: string }
export interface HerdrRunHandle extends Omit<RunHandle, "cancel" | "deliver"> {
	cancel(source: KilledBy): Promise<void>;
	deliver(envelope: Envelope): Promise<DeliveryResult | RunSettlingResult>;
}
/** Persisted on each engine run, not just the agent's latest Herdr pointer. */
export interface HerdrReceiptIdentity { agentId: string; runId: string; machine?: string; destinationCommitted?: boolean }
export type HerdrCapturedSummary = AgentMeta["runs"][number] & { herdr?: HerdrReceiptIdentity };
export interface PaneToolResult { text: string; isError?: boolean; details: Record<string, unknown> }
export interface HerdrRunsHost {
	/** Same execution.then(settle) registration as Engine.trackRun. */
	trackRun(agentId: string, runId: string, handle: HerdrRunHandle, background: boolean): void;
	/** Fail a reserved run whose launch/setup could not register a handle. */
	settle(agentId: string, runId: string, outcome: RunOutcome): void;
	persist(meta: AgentMeta): void;
	forwardPendingStop(agentId: string, runId: string, handle: HerdrRunHandle): void | Promise<void>;
	/** A blocked foreground wait has not delivered the final result; its eventual notice must wake the owner/root. */
	backgroundRun(agentId: string, runId: string): void;
	/** Durable responsibility transfer. Engine dispatch must not overwrite included with submitted for pane deliveries. */
	includeEnvelopes(agentId: string, runId: string, ids: string[]): void;
	emit(event: { type: "spawned"; agentId: string; runId: string; meta: AgentMeta } | { type: "run-event"; agentId: string; runId: string; event: BackendEvent }): void;
	diagnostic(message: string): void;
}
export interface HerdrRunsOptions {
	now?: () => number;
	maxAttempts?: number;
	backoffMs?: number;
	maxBackoffMs?: number;
	schedule?: (callback: () => void, delay: number) => { cancel(): void };
}
interface Identity { readonly agentId: string; readonly runId: string; readonly herdrAgentId: string; readonly herdrRunId: string }
interface ReceiptRun {
	identity: Identity; meta: AgentMeta; ownerMeta: AgentMeta; destinationPersisted: boolean; sourceAcknowledged?: boolean;
}
interface LiveRun extends ReceiptRun {
	handle: HerdrRunHandle; resolve: (outcome: RunOutcome) => void;
	outcome?: RunOutcome; settling?: boolean; processing?: Promise<void>; cancelSource?: KilledBy; accepted: Set<string>; deliveries: Set<Promise<unknown>>;
}
interface PendingCommit { run: ReceiptRun; attempts: number; next: number; processing?: Promise<void> }
interface PendingNotice { notice: PaneNotice; attempts: number; next: number; processing?: Promise<void> }
interface PendingAck { agentId: string; runId: string; committed: boolean; attempts: number; next: number; processing?: Promise<void> }
const terminal = (phase: PanePhase): phase is PaneTerminalPhase => phase === "completed" || phase === "failed" || phase === "stopped";
const key = (agentId: string, runId: string) => JSON.stringify([agentId, runId]);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const positive = (value: number | undefined, fallback: number): number => value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

function outcome(phase: PaneTerminalPhase, text: string): RunOutcome {
	return { status: phase === "stopped" ? "killed" : phase, classification: phase === "stopped" ? "killed" : phase,
		resultText: text, ...(phase === "stopped" ? { killedBy: "parent" as const } : {}),
		usage: { billable: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, latestFootprint: 0, liveMetric: 0, modelTransitions: [] },
		toolStats: { toolUses: 0, byTool: {} }, durationMs: 0 };
}

/** Owns pane execution, immutable run identities and receipt retries across transport generations. */
export class HerdrRuns {
	private port?: HerdrRunsPort;
	private unsubscribe?: () => void;
	private readonly runs = new Map<string, LiveRun>();
	private readonly byHerdr = new Map<string, LiveRun>();
	private readonly terminalRuns = new Map<string, ReceiptRun>();
	private readonly terminalByHerdr = new Map<string, ReceiptRun>();
	private readonly destinationWrites = new Map<string, PendingCommit>();
	private readonly notices = new Map<string, PendingNotice>();
	private readonly acks = new Map<string, PendingAck>();
	private readonly committed = new Set<string>();
	private readonly handled = new Set<string>();
	private readonly now: () => number;
	private readonly schedule: NonNullable<HerdrRunsOptions["schedule"]>;
	private readonly maxAttempts: number;
	private readonly backoff: number;
	private readonly maxBackoff: number;
	private timer?: { cancel(): void };
	private disposed = false;
	private generation = 0;

	constructor(privateHost: HerdrRunsHost, options: HerdrRunsOptions = {}) {
		this.host = privateHost;
		this.now = options.now ?? Date.now;
		this.maxAttempts = Math.min(100, positive(options.maxAttempts, 5));
		this.backoff = positive(options.backoffMs, 100);
		this.maxBackoff = Math.max(this.backoff, positive(options.maxBackoffMs, 5000));
		this.schedule = options.schedule ?? ((callback, delay) => {
			const timer = setTimeout(callback, delay); timer.unref(); return { cancel: () => clearTimeout(timer) };
		});
	}
	private readonly host: HerdrRunsHost;

	/** Seed every identity before subscribing. Old surviving handles dereference this port at call time. */
	rebind(port: HerdrRunsPort): () => void {
		if (this.disposed) throw new Error("HerdrRuns is disposed");
		for (const run of [...this.runs.values(), ...this.terminalRuns.values()]) port.proxy(run.meta, { agentId: run.identity.herdrAgentId, runId: run.identity.herdrRunId, machine: run.meta.herdr?.machine });
		// A subscription may synchronously replay notices or throw. Stage it
		// without disturbing the working transport, then publish one generation.
		const buffered: PaneNotice[] = [];
		let active = false;
		const generation = this.generation + 1;
		const unsubscribe = port.onNotice((notice) => {
			if (!active) buffered.push(notice);
			else if (this.generation === generation) this.receive(notice);
		});
		this.unsubscribe?.();
		this.port = port;
		this.generation = generation;
		this.unsubscribe = unsubscribe;
		active = true;
		for (const notice of buffered) this.receive(notice);
		for (const pending of [...this.notices.values(), ...this.acks.values(), ...this.destinationWrites.values()]) { pending.attempts = 0; pending.next = this.now(); }
		void this.retryPending();
		return () => { if (this.generation === generation) { this.generation++; this.unsubscribe?.(); this.unsubscribe = undefined; this.port = undefined; } };
	}
	available(): boolean { return Boolean(this.port) && !this.disposed; }
	/** A pane child's own launches are nested agents, which stay in-process unless a call asks for a pane. */
	defaultsHere(): boolean { return this.available() && !this.port!.paneChild?.(); }
	pendingAcknowledgements(): number { return this.acks.size; }
	getHandle(runId: string): HerdrRunHandle | undefined { return this.runs.get(runId)?.handle; }

	/** Reattach a saved, already-reserved engine run without launching or resuming its surviving pane. */
	restore(meta: AgentMeta, runId: string): void {
		if (this.disposed) throw new Error("HerdrRuns is disposed");
		if (meta.backend !== "herdr" || !meta.herdr?.agentId || !meta.herdr.runId) throw new Error("Restoring a pane requires saved Herdr agent and run identities");
		if (!meta.runs.some((run) => run.runId === runId && run.status === "running")) throw new Error("Restoring a pane requires a running engine run");
		const ref = this.capturedReference(meta, runId);
		const existing = this.runs.get(runId);
		if (existing) {
			if (existing.identity.agentId !== meta.agentId || existing.identity.herdrAgentId !== ref.agentId || existing.identity.herdrRunId !== ref.runId || existing.meta.herdr?.machine !== ref.machine) throw new Error(`Conflicting restored pane engine run ${runId}`);
			return;
		}
		this.register(meta, runId, true);
		void this.retryPending();
	}

	/** Restore receipt routing only: terminal metadata never creates a handle or reserves execution. */
	restoreTerminal(meta: AgentMeta, runId: string): void {
		if (this.disposed) throw new Error("HerdrRuns is disposed");
		const summary = meta.runs.find((run) => run.runId === runId);
		if (meta.backend !== "herdr" || !summary || !["completed", "failed", "killed"].includes(summary.status)) throw new Error("Restoring a pane receipt requires a terminal Herdr run");
		const ref = this.capturedReference(meta, runId);
		const active = this.runs.get(runId);
		const existing = active ?? this.terminalRuns.get(runId);
		if (existing) {
			if (existing.identity.agentId !== meta.agentId || existing.identity.herdrAgentId !== ref.agentId || existing.identity.herdrRunId !== ref.runId || existing.meta.herdr?.machine !== ref.machine) throw new Error(`Conflicting restored pane receipt ${runId}`);
			if (active && !active.outcome) throw new Error("Cannot restore a terminal receipt over a live pane run");
			return;
		}
		// The existing metadata writer preserves these per-run fields. Migrate
		// a latest-run legacy pointer before accepting responsibility for it.
		if (!(summary as HerdrCapturedSummary).herdr) this.saveAssociation(meta, runId, ref);
		const snapshot = structuredClone({ ...meta, runs: [], herdr: ref });
		this.port?.proxy(snapshot, ref);
		const run: ReceiptRun = {
			identity: Object.freeze({ agentId: meta.agentId, runId, herdrAgentId: ref.agentId, herdrRunId: ref.runId }),
			meta: snapshot, ownerMeta: meta, destinationPersisted: ref.destinationCommitted === true,
		};
		this.terminalRuns.set(runId, run);
		this.terminalByHerdr.set(key(ref.agentId, ref.runId), run);
		if (run.destinationPersisted) this.committed.add(key(meta.agentId, runId));
		else if (this.committed.has(key(meta.agentId, runId))) this.queueDestinationWrite(run);
		void this.retryPending();
	}

	private capturedReference(meta: AgentMeta, runId: string): HerdrReceiptIdentity {
		const summary = meta.runs.find((run) => run.runId === runId) as HerdrCapturedSummary | undefined;
		if (!summary) throw new Error(`Unknown pane engine run ${runId}`);
		let ref = summary.herdr;
		if (ref === undefined) {
			// Only the latest legacy run can use the agent-level pointer. Earlier
			// runs of a resumed pane must never borrow its newer source identity.
			if (summary !== meta.runs.at(-1) || !meta.herdr?.runId) throw new Error(`No captured Herdr identity for historical run ${runId}`);
			if (meta.runs.some((other) => other !== summary && (other as HerdrCapturedSummary).herdr?.agentId === meta.herdr!.agentId && (other as HerdrCapturedSummary).herdr?.runId === meta.herdr!.runId)) throw new Error(`Herdr pointer belongs to another engine run, not ${runId}`);
			ref = { agentId: meta.herdr.agentId, runId: meta.herdr.runId, ...(meta.herdr.machine ? { machine: meta.herdr.machine } : {}) };
		}
		if (!ref || typeof ref.agentId !== "string" || !ref.agentId || typeof ref.runId !== "string" || !ref.runId || (ref.machine !== undefined && typeof ref.machine !== "string") || (ref.destinationCommitted !== undefined && typeof ref.destinationCommitted !== "boolean")) throw new Error(`Invalid captured Herdr identity for ${runId}`);
		if (meta.runs.some((other) => other !== summary && (other as HerdrCapturedSummary).herdr?.agentId === ref!.agentId && (other as HerdrCapturedSummary).herdr?.runId === ref!.runId)) throw new Error(`Captured Herdr identity is shared by different engine runs: ${runId}`);
		return structuredClone(ref);
	}
	private saveAssociation(meta: AgentMeta, runId: string, ref: { agentId: string; runId?: string; machine?: string }, destinationCommitted = false): void {
		const summary = meta.runs.find((run) => run.runId === runId) as HerdrCapturedSummary | undefined;
		if (!summary || !ref.agentId || !ref.runId) throw new Error("Cannot persist a pane receipt without engine and source run identities");
		if (summary.herdr && (summary.herdr.agentId !== ref.agentId || summary.herdr.runId !== ref.runId || summary.herdr.machine !== ref.machine)) throw new Error(`Cannot change captured Herdr identity for ${runId}`);
		summary.herdr = { ...summary.herdr, agentId: ref.agentId, runId: ref.runId, ...(ref.machine ? { machine: ref.machine } : {}), ...(destinationCommitted ? { destinationCommitted: true } : {}) };
		this.host.persist(meta);
	}
	private queueDestinationWrite(run: ReceiptRun): void {
		const ref = key(run.identity.agentId, run.identity.runId);
		if (!run.destinationPersisted && !this.destinationWrites.has(ref)) this.destinationWrites.set(ref, { run, attempts: 0, next: this.now() });
	}
	private async processDestinationWrite(ref: string, pending: PendingCommit): Promise<void> {
		if (pending.processing) return pending.processing;
		if (pending.attempts >= this.maxAttempts || pending.next > this.now()) return;
		const work = (async () => {
			try {
				const run = pending.run;
				const summary = run.ownerMeta.runs.find((entry) => entry.runId === run.identity.runId) as HerdrCapturedSummary | undefined;
				if (!summary) throw new Error("Pane destination receipt has no saved engine run");
				// Persist the current owner metadata, not the run's old transport
				// snapshot: a later continuation may already have updated this agent.
				this.saveAssociation(run.ownerMeta, run.identity.runId, { agentId: run.identity.herdrAgentId, runId: run.identity.herdrRunId, machine: run.meta.herdr?.machine }, true);
				run.destinationPersisted = true;
				this.destinationWrites.delete(ref);
			} catch (error) { this.failed(pending, `Pane destination receipt (${ref})`, error); }
		})();
		pending.processing = work;
		try { await work; } finally { pending.processing = undefined; }
	}

	/** Release completed snapshot/result payloads only after all source receipts finish. */
	evict(agentId: string): boolean {
		const live = [...this.runs.values()].filter((run) => run.identity.agentId === agentId);
		const owned: ReceiptRun[] = [...live, ...[...this.terminalRuns.values()].filter((run) => run.identity.agentId === agentId)];
		if (live.some((run) => !run.outcome) || owned.some((run) => !run.sourceAcknowledged) || [...this.acks.values()].some((ack) => ack.agentId === agentId)) return false;
		if ([...this.notices.values()].some((pending) => (this.byHerdr.get(key(pending.notice.herdrAgentId, pending.notice.runId)) ?? this.terminalByHerdr.get(key(pending.notice.herdrAgentId, pending.notice.runId)))?.identity.agentId === agentId)) return false;
		for (const run of owned) {
			this.runs.delete(run.identity.runId);
			this.byHerdr.delete(key(run.identity.herdrAgentId, run.identity.herdrRunId));
			this.terminalRuns.delete(run.identity.runId);
			this.terminalByHerdr.delete(key(run.identity.herdrAgentId, run.identity.herdrRunId));
			this.committed.delete(key(agentId, run.identity.runId));
		}
		return true;
	}

	async spawn(meta: AgentMeta, runId: string, request: PaneRequest, ctx: ExtensionContext, options: { background: boolean; signal?: AbortSignal }): Promise<PaneToolResult> {
		let registered = false;
		try {
			const launched = await this.transport().spawn({ ...request, runInBackground: true }, ctx, meta, options.signal);
			meta.backend = "herdr"; meta.herdr = launched.meta.herdr;
			if (!meta.herdr) throw new Error("Herdr spawn did not return run identity");
			this.saveAssociation(meta, runId, meta.herdr);
			const run = this.register(meta, runId, options.background);
			registered = true;
			await this.host.forwardPendingStop(meta.agentId, runId, run.handle);
			this.host.emit({ type: "spawned", agentId: meta.agentId, runId, meta });
			void this.retryPending();
			if (options.background) return { text: launchResultText({ agentId: meta.agentId, name: meta.name, description: meta.description, background: true }), details: { agentId: meta.agentId, runId, status: "running", background: true, herdr: meta.herdr } };
			const read = await this.readCaptured(run, { wait: true, signal: options.signal });
			if (terminal(read.phase)) await this.finish(run, read.phase, read.resultText);
			else {
				this.host.backgroundRun(meta.agentId, runId);
				this.emit(run, { type: read.phase === "blocked" ? "blocked" : "started" });
			}
			return { text: this.render(meta.agentId, read), isError: read.phase === "failed" || undefined, details: { agentId: meta.agentId, runId, status: read.phase, resultText: read.resultText } };
		} catch (error) {
			if (registered) { this.host.diagnostic(`Pane operation failed: ${errorText(error)}`); throw error; }
			this.host.settle(meta.agentId, runId, outcome("failed", errorText(error)));
			return { text: `Could not start the pane agent: ${errorText(error)}`, isError: true, details: { agentId: meta.agentId, runId } };
		}
	}

	async resume(meta: AgentMeta, runId: string, prompt: string, ctx: ExtensionContext, envelopeIds: string[] = []): Promise<void> {
		let registered = false;
		try {
			// Migrate the latest legacy association before replacing its pointer.
			const previous = meta.runs.findLast((summary) => summary.runId !== runId) as HerdrCapturedSummary | undefined;
			if (previous && !previous.herdr && meta.herdr?.runId && !meta.runs.some((summary) => summary !== previous && (summary as HerdrCapturedSummary).herdr?.agentId === meta.herdr!.agentId && (summary as HerdrCapturedSummary).herdr?.runId === meta.herdr!.runId)) this.saveAssociation(meta, previous.runId, meta.herdr);
			const resumed = await this.transport().resume(meta, prompt, ctx);
			meta.herdr = resumed.meta.herdr;
			if (!meta.herdr) throw new Error("Herdr resume did not return run identity");
			this.saveAssociation(meta, runId, meta.herdr);
			const run = this.register(meta, runId, true);
			registered = true;
			await this.host.forwardPendingStop(meta.agentId, runId, run.handle);
			this.host.includeEnvelopes(meta.agentId, runId, envelopeIds);
			this.emit(run, { type: "started" });
			void this.retryPending();
		} catch (error) {
			if (registered) { this.host.diagnostic(`Pane continuation control failed: ${errorText(error)}`); throw error; }
			this.host.settle(meta.agentId, runId, outcome("failed", errorText(error)));
		}
	}

	/** Host calls this only after destination persistence (or a deliberate no-report parked handback). */
	acknowledgeDestination(agentId: string, runId: string): void {
		this.committed.add(key(agentId, runId));
		for (const pending of this.acks.values()) if (pending.agentId === agentId && pending.runId === runId) pending.committed = true;
		const run = this.runs.get(runId) ?? this.terminalRuns.get(runId);
		if (run?.identity.agentId === agentId) this.queueDestinationWrite(run);
		void this.retryPending();
	}

	async retryPending(): Promise<void> {
		if (!this.available()) return;
		await Promise.all([...this.notices.values()].map((pending) => this.processNotice(pending)));
		await Promise.all([...this.destinationWrites].map(([ref, pending]) => this.processDestinationWrite(ref, pending)));
		await Promise.all([...this.acks].map(([id, pending]) => this.processAck(id, pending)));
		this.arm();
	}
	dispose(): void { this.disposed = true; this.timer?.cancel(); this.unsubscribe?.(); this.port = undefined; }

	private register(meta: AgentMeta, runId: string, background: boolean): LiveRun {
		if (this.disposed) throw new Error("HerdrRuns is disposed");
		if (this.runs.has(runId)) throw new Error(`Duplicate pane engine run ${runId}`);
		const ref = this.capturedReference(meta, runId);
		const snapshot = structuredClone({ ...meta, herdr: ref });
		// Reconstruction may precede transport attachment. rebind() seeds all
		// captured identities before subscribing when no port exists yet.
		this.port?.proxy(snapshot, { ...ref, runId: ref.runId });
		let resolve!: (value: RunOutcome) => void;
		const execution = new Promise<RunOutcome>((done) => { resolve = done; });
		const identity = Object.freeze({ agentId: meta.agentId, runId, herdrAgentId: ref.agentId, herdrRunId: ref.runId });
		const run: LiveRun = { identity, meta: snapshot, ownerMeta: meta, destinationPersisted: ref.destinationCommitted === true, resolve, accepted: new Set(), deliveries: new Set(), handle: undefined! };
		run.handle = {
			runId, started: Promise.resolve(), execution,
			deliver: (envelope) => {
				if (run.outcome) return Promise.resolve({ ok: false as const, reason: "not-running" as const, message: "This captured pane run has finished." });
				if (run.settling) return Promise.resolve({ ok: false as const, reason: "not-running" as const, settling: true as const, message: "This captured pane run is settling; queue this message for continuation." });
				const delivery = (async () => {
					const result = await this.transport().deliver(run.meta, envelope);
					if (result.ok) {
						run.accepted.add(envelope.id);
						this.host.includeEnvelopes(identity.agentId, runId, [envelope.id]);
					}
					return result;
				})();
				run.deliveries.add(delivery);
				void delivery.then(() => run.deliveries.delete(delivery), () => run.deliveries.delete(delivery));
				return delivery;
			},
			cancel: async (source) => {
				if (run.outcome) return;
				run.cancelSource = source;
				try {
					const reply = await this.transport().cancel(run.meta);
					if (reply.acknowledged) this.emit(run, { type: "cancel-acknowledged" });
				} catch (error) { this.host.diagnostic(`Pane cancellation failed (${identity.agentId}/${runId}): ${errorText(error)}`); throw error; }
			},
			subscribe: () => () => undefined,
		};
		this.runs.set(runId, run);
		this.byHerdr.set(key(ref.agentId, ref.runId), run);
		this.host.trackRun(meta.agentId, runId, run.handle, background);
		return run;
	}
	private transport(): HerdrRunsPort {
		if (!this.available()) throw new Error("Herdr pane transport is unavailable");
		return this.port!;
	}
	private receive(notice: PaneNotice): void {
		if (this.handled.has(notice.noticeId)) return;
		const ack = this.acks.get(notice.noticeId);
		if (ack) {
			// A new backend can replay only after its notice routing is ready.
			// This is fresh recovery evidence, not a polling-based retry loop.
			if (ack.attempts >= this.maxAttempts) { ack.attempts = 0; ack.next = this.now(); }
			void this.retryPending();
			return;
		}
		if (this.notices.has(notice.noticeId)) return;
		this.notices.set(notice.noticeId, { notice, attempts: 0, next: this.now() });
		void this.retryPending();
	}
	private async processNotice(pending: PendingNotice): Promise<void> {
		if (pending.processing) return pending.processing;
		if (pending.attempts >= this.maxAttempts || pending.next > this.now()) return;
		const sourceKey = key(pending.notice.herdrAgentId, pending.notice.runId);
		const live = this.byHerdr.get(sourceKey);
		const run = live ?? this.terminalByHerdr.get(sourceKey);
		if (!run) return; // Early/unknown source identity: retain it, never acknowledge speculation.
		const work = (async () => {
			try {
				if (live && !live.outcome) {
					live.settling = true;
					const captured = await this.readCaptured(live);
					if (!terminal(captured.phase)) throw new Error(`Terminal pane notice has nonterminal captured result: ${captured.phase}`);
					await this.finish(live, captured.phase, captured.resultText);
				}
				const { agentId, runId } = run.identity;
				this.acks.set(pending.notice.noticeId, { agentId, runId, committed: this.committed.has(key(agentId, runId)), attempts: 0, next: this.now() });
				this.notices.delete(pending.notice.noticeId);
			} catch (error) { this.failed(pending, `Pane result read (${run.identity.agentId}/${run.identity.runId})`, error); }
		})();
		pending.processing = work;
		try { await work; } finally { pending.processing = undefined; }
	}
	private async readCaptured(run: LiveRun, options: { wait?: boolean; signal?: AbortSignal } = {}): Promise<PaneRead> {
		const port = this.transport();
		try {
			const value = await port.read(run.meta, { ...options, runId: run.identity.herdrRunId });
			if (value.runId !== undefined && value.runId !== run.identity.herdrRunId) throw new Error("Herdr returned another run's result");
			if (!["queued", "starting", "running", "blocked", "completed", "failed", "stopped"].includes(value.phase) || typeof value.resultText !== "string") throw new Error("Herdr must return a typed phase and a full resultText");
			return value;
		} catch (error) {
			if (this.port !== port && this.available() && !options.signal?.aborted) return this.readCaptured(run, options);
			throw error;
		}
	}
	private async finish(run: LiveRun, phase: PaneTerminalPhase, text: string): Promise<void> {
		if (run.outcome) return;
		run.settling = true; // Close admission before taking the delivery snapshot or yielding.
		if (run.processing) return run.processing;
		const work = (async () => {
			await Promise.allSettled([...run.deliveries]);
			this.host.includeEnvelopes(run.identity.agentId, run.identity.runId, [...run.accepted]);
			run.outcome = outcome(phase, text);
			if (phase === "stopped" && run.cancelSource) run.outcome.killedBy = run.cancelSource;
			run.resolve(run.outcome);
		})();
		run.processing = work;
		await work;
	}
	private async processAck(id: string, pending: PendingAck): Promise<void> {
		if (pending.processing) return pending.processing;
		if (!pending.committed || pending.attempts >= this.maxAttempts || pending.next > this.now()) return;
		const receipt = this.runs.get(pending.runId) ?? this.terminalRuns.get(pending.runId);
		if (!receipt?.destinationPersisted) return;
		const work = (async () => {
			try {
				await this.transport().acknowledge(id);
				this.acks.delete(id); this.handled.add(id);
				const run = this.runs.get(pending.runId) ?? this.terminalRuns.get(pending.runId);
				if (run?.identity.agentId === pending.agentId) run.sourceAcknowledged = true;
			}
			catch (error) { this.failed(pending, `Pane acknowledgement (${id})`, error); }
		})();
		pending.processing = work;
		try { await work; } finally { pending.processing = undefined; }
	}
	private failed(pending: { attempts: number; next: number }, label: string, error: unknown): void {
		pending.attempts++;
		pending.next = this.now() + Math.min(this.maxBackoff, this.backoff * 2 ** (pending.attempts - 1));
		this.host.diagnostic(`${label} failed: ${errorText(error)}; ${pending.attempts >= this.maxAttempts ? "automatic retries exhausted; reference retained until rebind" : `retry ${pending.attempts}/${this.maxAttempts} scheduled`}.`);
	}
	private arm(): void {
		this.timer?.cancel(); this.timer = undefined;
		if (!this.available()) return;
		const due = [...this.acks.values()].filter((pending) => pending.committed && !pending.processing && pending.attempts < this.maxAttempts && (this.runs.get(pending.runId) ?? this.terminalRuns.get(pending.runId))?.destinationPersisted).map((pending) => pending.next);
		for (const pending of this.notices.values()) if (!pending.processing && pending.attempts < this.maxAttempts && (this.byHerdr.has(key(pending.notice.herdrAgentId, pending.notice.runId)) || this.terminalByHerdr.has(key(pending.notice.herdrAgentId, pending.notice.runId)))) due.push(pending.next);
		for (const pending of this.destinationWrites.values()) if (!pending.processing && pending.attempts < this.maxAttempts) due.push(pending.next);
		if (due.length) this.timer = this.schedule(() => { this.timer = undefined; void this.retryPending(); }, Math.max(1, Math.min(...due) - this.now()));
	}
	private emit(run: LiveRun, event: BackendEvent): void { this.host.emit({ type: "run-event", agentId: run.identity.agentId, runId: run.identity.runId, event }); }
	private render(agentId: string, read: PaneRead): string {
		return `${read.resultText || (read.phase === "blocked" ? "The pane needs attention before it can continue." : "No report text.")}\n\nagentId: ${agentId}; use SendMessage to continue this agent. ${terminal(read.phase) ? "Verify actual changes before reporting completion." : "You will be notified when it finishes."}`;
	}
}
