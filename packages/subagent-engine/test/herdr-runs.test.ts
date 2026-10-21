import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readMeta, writeMeta } from "../src/store/meta.ts";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getModel, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdrBackendHandle, HerdrBackendNotice, HerdrBackendRequest } from "../../herdr-subagents/src/herdr/backend.ts";
import { HerdrBackendAdapter } from "../src/backends/herdr.ts";
import { HerdrRuns, type HerdrRunsHost, type HerdrRunHandle, type HerdrCapturedSummary } from "../src/backends/herdr-runs.ts";
import { Control } from "../src/control.ts";
import type { AgentMeta, Envelope, RunOutcome } from "../src/types.ts";

interface Data { sequence: number; current: string; full: Map<string, { text: string; phase: "running" | "blocked" | "completed" | "failed" | "stopped" }> }
class Transport implements HerdrBackendHandle {
	readonly listeners = new Set<(notice: HerdrBackendNotice) => void>();
	readonly reads: string[] = [];
	readonly cancels: (string | undefined)[] = [];
	readonly steers: (string | undefined)[] = [];
	readonly acks: string[] = [];
	retired = false; cancelError = false; ackFailures = 0; early = false; subscriptionError = false;
	replay?: HerdrBackendNotice;
	spawnGate?: Promise<void>; readGate?: Promise<void>; steerGate?: Promise<void>;
	foreground: "completed" | "blocked" = "completed";
	readonly data: Data;
	constructor(data: Data = { sequence: 0, current: "", full: new Map() }) { this.data = data; }
	private active() { if (this.retired) throw new Error("retired transport"); }
	async spawn(_request: HerdrBackendRequest) {
		this.active(); const runId = this.begin();
		if (this.early) this.complete(runId, "Early full result");
		await this.spawnGate;
		return { agentId: "pane", runId, text: "Use get_subagent_result with pane (not an engine id)" };
	}
	async resume() { this.active(); return { runId: this.begin(), text: "Resumed pane" }; }
	async read(_id: string, options: { runId?: string; wait?: boolean }) {
		this.active(); const runId = options.runId ?? this.data.current; this.reads.push(runId);
		const value = this.data.full.get(runId)!;
		if (options.wait && value.phase === "running") { await this.readGate; value.phase = this.foreground; value.text = "Full foreground report"; }
		return { phase: value.phase, status: value.phase, resultText: value.text, text: "Presentation with raw pane id", runId };
	}
	async steer(_id: string, _text: string, options?: { runId?: string }) { this.active(); this.steers.push(options?.runId); await this.steerGate; return { ok: true, message: "Queued" }; }
	async cancel(_id: string, options?: { runId?: string }) {
		this.active(); this.cancels.push(options?.runId); if (this.cancelError) throw new Error("cancel transport failure");
		return { acknowledged: false, message: "Pending stop" };
	}
	capabilities() { return { liveDelivery: true, maxTurns: true, fork: false as const, sharedTasks: true }; }
	onNotice(listener: (notice: HerdrBackendNotice) => void) { if (this.subscriptionError) throw new Error("Cannot subscribe"); this.listeners.add(listener); if (this.replay) listener(this.replay); return () => { this.listeners.delete(listener); }; }
	async acknowledge(id: string) { this.active(); this.acks.push(id); if (this.ackFailures-- > 0) throw new Error("temporary receipt failure"); }
	complete(runId: string, text: string, phase: "completed" | "failed" | "stopped" = "completed", description = "Investigate failed and stopped tests") {
		this.data.full.set(runId, { phase, text });
		for (const listener of this.listeners) listener({ noticeId: `notice-${runId}`, agentId: "pane", runId, phase, content: `Background agent ${phase}: ${description}\n${text.slice(0, 500)}` });
	}
	private begin() { const id = `pane-run-${++this.data.sequence}`; this.data.current = id; this.data.full.set(id, { phase: "running", text: "" }); return id; }
}
function envelope(id = "e1"): Envelope { return { id, acceptanceKey: id, from: "main", to: "engine-agent", text: "Do the action exactly once", createdAt: 0, state: "pending" }; }
function fixture() {
	const meta: AgentMeta = { agentId: "engine-agent", agentType: "Explore", description: "Investigate failed tests", rootSessionId: "root", spawnDepth: 1, cwd: "/repo", sessionFile: "/state/proxy", taskListId: "root", backend: "herdr", stopGeneration: 0, runs: [],
		definition: { agentType: "Explore", description: "Locate", prompt: "Locate", source: "built-in", skills: [], disallowedTools: [], diagnostics: [] } };
	let clock = 0, sequence = 0;
	const inbox = new Map<string, Envelope>(), outcomes = new Map<string, RunOutcome>(), continuations: string[] = [], diagnostics: string[] = [], events: unknown[] = [];
	const control = new Control({ maxConcurrent: 3, maxDepth: 3 }, { persist() {}, inboxOf: () => ({ undelivered: () => [...inbox.values()].filter((entry) => !["included", "consumed", "refused"].includes(entry.state)) }), newRunId: () => `engine-run-${++sequence}`, now: () => clock });
	const reserved = control.reserveSpawn({ meta, background: true }); assert(!("error" in reserved));
	const host: HerdrRunsHost = {
		trackRun(agentId, runId, handle, background) { control.markRunning(agentId, runId, handle); if (background) control.setBackground(agentId, runId); void handle.execution.then((value) => host.settle(agentId, runId, value)); },
		settle(agentId, runId, value) { outcomes.set(runId, value); const result = control.finalize(agentId, runId, value, { text: value.resultText, truncated: false }); if (result?.continuation) continuations.push(result.continuation); },
		persist() {},
		backgroundRun(agentId, runId) { control.setBackground(agentId, runId); },
		async forwardPendingStop(agentId, runId, handle) { const active = control.get(agentId)?.active; if (active?.runId === runId && active.cancelRequested) await handle.cancel(active.cancelRequested); },
		includeEnvelopes(_agentId, _runId, ids) { for (const id of ids) { const entry = inbox.get(id); if (entry) entry.state = "included"; } },
		emit(event) { events.push(event); }, diagnostic(message) { diagnostics.push(message); },
	};
	const runs = new HerdrRuns(host, { now: () => clock, backoffMs: 10, maxBackoffMs: 20, maxAttempts: 3, schedule: () => ({ cancel() {} }) });
	const transport = new Transport(); runs.rebind(new HerdrBackendAdapter(transport));
	const ctx = {} as ExtensionContext;
	const request = { cwd: "/repo", prompt: "Locate code", description: "Investigate failed tests", subagentType: "Explore", runInBackground: true };
	return { meta, runId: reserved.runId, runs, transport, control, host, ctx, request, inbox, outcomes, continuations, diagnostics, events,
		advance(ms: number) { clock += ms; },
		spawn(background = true) { return runs.spawn(meta, reserved.runId, request, ctx, { background }); },
		async flush() { for (let i = 0; i < 4; i++) { await runs.retryPending(); await Promise.resolve(); } },
	};
}

for (const order of ["before", "after"] as const) test(`restore reconstructs a saved live pane ${order} rebind without spawning it again`, async (t) => {
	const original = fixture();
	await original.spawn();
	const saved: AgentMeta = JSON.parse(JSON.stringify(original.meta));
	saved.herdr!.machine = "saved-machine";
	(saved.runs[0] as HerdrCapturedSummary).herdr!.machine = "saved-machine";
	const captured = structuredClone(saved.herdr!);
	original.runs.dispose();
	original.transport.retired = true;
	const transport = new Transport(original.transport.data);
	class RecordingAdapter extends HerdrBackendAdapter {
		readonly registeredProxies: AgentMeta[] = [];
		override proxy(meta: AgentMeta, ref: Parameters<HerdrBackendAdapter["proxy"]>[1]): AgentMeta {
			const result = super.proxy(meta, ref); this.registeredProxies.push(result); return result;
		}
	}
	const adapter = new RecordingAdapter(transport);
	const tracked: { agentId: string; runId: string; handle: HerdrRunHandle; background: boolean }[] = [];
	const settled = new Map<string, RunOutcome>();
	const diagnostics: string[] = [];
	const host: HerdrRunsHost = {
		trackRun(agentId, runId, handle, background) {
			tracked.push({ agentId, runId, handle, background });
			void handle.execution.then((value) => host.settle(agentId, runId, value));
		},
		settle(_agentId, runId, value) { settled.set(runId, value); },
		persist() {}, forwardPendingStop() {}, backgroundRun() {}, includeEnvelopes() {}, emit() {},
		diagnostic(message) { diagnostics.push(message); },
	};
	const restored = new HerdrRuns(host, { schedule: () => ({ cancel() {} }) });
	t.after(() => restored.dispose());
	const flush = async () => { for (let i = 0; i < 4; i++) { await restored.retryPending(); await Promise.resolve(); } };
	if (order === "after") restored.rebind(adapter);
	const unchanged = structuredClone(saved);
	restored.restore(saved, original.runId);
	assert.deepEqual(saved, unchanged, "restoration must not mutate persisted metadata");
	assert.equal(tracked.length, 1);
	assert.equal(tracked[0].agentId, saved.agentId);
	assert.equal(tracked[0].runId, original.runId);
	assert.equal(tracked[0].background, true);
	assert.equal(transport.data.sequence, 1, "restoration must not create another Herdr run");
	assert.equal(restored.getHandle(original.runId), tracked[0].handle);
	if (order === "before") {
		assert.equal(adapter.registeredProxies.length, 0, "restoration without a port must not require transport access");
		restored.rebind(adapter);
	}
	assert.deepEqual(adapter.registeredProxies[0].herdr, captured, "agent, run and machine identities are restored together");
	restored.restore(saved, original.runId);
	assert.equal(tracked.length, 1, "repeated restoration of the same identity is idempotent");
	// A later caller mutation cannot change the restored handle's captured run.
	saved.herdr!.runId = "different-run";
	await tracked[0].handle.cancel("user");
	assert.deepEqual(transport.cancels, [captured.runId]);
	assert.deepEqual(original.transport.cancels, []);
	const full = "x".repeat(750) + "IMPORTANT_TAIL!";
	let mappedAgent = "";
	adapter.onNotice((notice) => { mappedAgent = notice.agentId; });
	transport.complete(captured.runId!, full);
	await flush();
	assert.equal(mappedAgent, unchanged.agentId);
	assert.deepEqual(transport.reads, [captured.runId]);
	assert.equal(settled.get(original.runId)?.status, "completed");
	assert.equal(settled.get(original.runId)?.resultText, full, "settlement must fetch the full captured run, not the preview");
	assert.deepEqual(transport.acks, []);
	assert.equal(restored.pendingAcknowledgements(), 1);
	restored.acknowledgeDestination(unchanged.agentId, original.runId);
	await flush();
	assert.deepEqual(transport.acks, [`notice-${captured.runId}`]);
	assert.equal(restored.pendingAcknowledgements(), 0);
	assert.deepEqual(diagnostics, []);
});

test("restore rejects invalid or conflicting saved identities without replacing a tracked handle", (t) => {
	const f = fixture(); t.after(() => f.runs.dispose());
	const saved = structuredClone(f.meta);
	saved.herdr = { agentId: "pane", runId: "pane-run-1" };
	assert.throws(() => f.runs.restore({ ...saved, backend: "in-process" }, f.runId), /saved Herdr/);
	assert.throws(() => f.runs.restore({ ...saved, herdr: { agentId: "pane" } }, f.runId), /saved Herdr/);
	assert.throws(() => f.runs.restore(saved, "missing-engine-run"), /running engine run/);
	assert.throws(() => f.runs.restore({ ...saved, runs: [{ ...saved.runs[0], status: "completed" }] }, f.runId), /running engine run/);
	assert.equal(f.runs.getHandle(f.runId), undefined);
	f.runs.restore(saved, f.runId);
	const handle = f.runs.getHandle(f.runId);
	assert.throws(() => f.runs.restore({ ...saved, herdr: { agentId: "other-pane", runId: "other-run" } }, f.runId), /Conflicting restored/);
	assert.equal(f.runs.getHandle(f.runId), handle);
	f.runs.dispose();
	assert.throws(() => f.runs.restore(saved, f.runId), /disposed/);
});

test("public pane lifecycle settles through real Control, retains full captured output and uses only engine follow-up ids", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose());
	const launched = await f.spawn();
	assert.match(launched.text, /engine-agent/); assert.doesNotMatch(launched.text, /with pane/);
	const report = "x".repeat(750) + "IMPORTANT_TAIL!";
	assert.equal(report.length, 765);
	f.transport.complete("pane-run-1", report);
	await f.flush();
	assert.equal(f.outcomes.get(f.runId)?.status, "completed", "words failed/stopped in a user-authored title are not a protocol");
	assert.equal(f.outcomes.get(f.runId)?.resultText, report);
	assert.deepEqual(f.transport.reads, ["pane-run-1"]);
	assert.equal(f.control.activeRuns(), 0);
	assert.deepEqual(f.transport.acks, [], "settlement is not a destination receipt");
	f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
	assert.deepEqual(f.transport.acks, ["notice-pane-run-1"]);
});

test("replacement transport receives delivery, cancellation and completion routing for a surviving handle", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	const handle = f.runs.getHandle(f.runId)!;
	const replacement = new Transport(f.transport.data), adapter = new HerdrBackendAdapter(replacement);
	f.transport.retired = true;
	f.runs.rebind(adapter);
	let mapped = ""; adapter.onNotice((notice) => { mapped = notice.agentId; });
	const e = envelope(); f.inbox.set(e.id, e);
	assert.equal((await handle.deliver(e)).ok, true);
	await handle.cancel("user");
	assert.deepEqual(f.transport.steers, []); assert.deepEqual(f.transport.cancels, []);
	assert.deepEqual(replacement.steers, ["pane-run-1"]); assert.deepEqual(replacement.cancels, ["pane-run-1"]);
	replacement.complete("pane-run-1", "Replacement full report"); await f.flush();
	assert.equal(mapped, "engine-agent");
	assert.equal(f.outcomes.get(f.runId)?.resultText, "Replacement full report");
	assert.equal(f.control.activeRuns(), 0);
});

test("failed rebind leaves the working transport intact and synchronous replay sees restored identities", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	const broken = new Transport(f.transport.data); broken.subscriptionError = true;
	assert.throws(() => f.runs.rebind(new HerdrBackendAdapter(broken)), /Cannot subscribe/);
	await f.runs.getHandle(f.runId)!.cancel("parent"); assert.equal(f.transport.cancels.length, 1);
	const replacement = new Transport(f.transport.data);
	replacement.data.full.set("pane-run-1", { phase: "completed", text: "Replay full result" });
	replacement.replay = { noticeId: "notice-pane-run-1", agentId: "pane", runId: "pane-run-1", phase: "completed", content: "Preview only" };
	f.runs.rebind(new HerdrBackendAdapter(replacement)); await f.flush();
	assert.equal(f.outcomes.get(f.runId)?.resultText, "Replay full result"); assert.equal(f.control.activeRuns(), 0);
});

test("transport cancellation failures propagate and do not fabricate stopped outcomes", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn(); f.transport.cancelError = true;
	await assert.rejects(f.runs.getHandle(f.runId)!.cancel("user"), /cancel transport failure/);
	assert.equal(f.control.activeRuns(), 1); assert.equal(f.outcomes.size, 0);
	assert.match(f.diagnostics[0], /cancellation failed/);
});

test("accepted pane steering transfers inbox responsibility and completion cannot replay it as a resume", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	const e = envelope(); f.inbox.set(e.id, e);
	await f.runs.getHandle(f.runId)!.deliver(e);
	// Simulate the old generic dispatch write: settlement re-applies the
	// authoritative transfer before Control decides whether to continue.
	e.state = "submitted";
	f.transport.complete("pane-run-1", "Already performed the steering instruction"); await f.flush();
	assert.equal(e.state, "included"); assert.deepEqual(f.continuations, []);
	assert.equal(f.meta.runs.length, 1); assert.equal(f.control.activeRuns(), 0);
});

test("completion waits for an already accepted steering reply before deciding whether to resume", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	let release!: () => void; f.transport.steerGate = new Promise<void>((done) => { release = done; });
	const e = envelope(); f.inbox.set(e.id, e);
	const delivery = f.runs.getHandle(f.runId)!.deliver(e);
	f.transport.complete("pane-run-1", "Action handled before its transport reply");
	await Promise.resolve(); assert.equal(f.outcomes.size, 0);
	release(); await delivery; await f.flush();
	assert.deepEqual(f.continuations, []); assert.equal(e.state, "included"); assert.equal(f.control.activeRuns(), 0);
});

test("settlement closes delivery admission before awaiting the accepted-delivery snapshot", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	let release!: () => void; f.transport.steerGate = new Promise<void>((done) => { release = done; });
	const accepted = envelope("accepted-before-settlement"); f.inbox.set(accepted.id, accepted);
	const handle = f.runs.getHandle(f.runId)!;
	const delivery = handle.deliver(accepted);
	assert.equal(f.transport.steers.length, 1);
	f.transport.complete("pane-run-1", "Terminal result while a transport reply is pending");
	await Promise.resolve(); await Promise.resolve();
	const late = envelope("arrived-after-settlement-start"); f.inbox.set(late.id, late);
	const refused = await handle.deliver(late);
	assert.deepEqual(refused, { ok: false, reason: "not-running", settling: true, message: "This captured pane run is settling; queue this message for continuation." });
	assert.equal(f.transport.steers.length, 1, "late input must never reach the finishing transport run");
	assert.equal(late.state, "pending"); assert.equal(f.outcomes.size, 0);
	release(); await delivery; await f.flush();
	assert.equal(accepted.state, "included"); assert.equal(late.state, "pending");
	assert.equal(f.meta.runs[0].status, "completed");
	assert.equal(f.continuations.length, 1, "only the late pending message should reserve a continuation");
	assert.equal(f.transport.data.sequence, 1, "no transport resume is manufactured by the finishing run");
	assert.equal((await handle.deliver(late)).ok, false); assert.equal(f.transport.steers.length, 1);
});

for (const order of ["before", "after"] as const) test(`terminal receipt recovery ${order} rebind survives disk round-trip without reopening earlier resumed runs`, async (t) => {
	const captures = resolve("captures"); mkdirSync(captures, { recursive: true });
	const root = mkdtempSync(join(captures, "herdr-terminal-receipts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "agent.meta.json");
	const f = fixture();
	f.host.persist = (meta) => writeMeta(file, meta);
	const settle = f.host.settle;
	f.host.settle = (agentId, runId, value) => { settle(agentId, runId, value); writeMeta(file, f.meta); };
	await f.spawn(); f.transport.ackFailures = 99;
	f.transport.complete("pane-run-1", "First terminal result"); await f.flush();
	f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
	assert.equal(f.runs.pendingAcknowledgements(), 1);
	const reservation = f.control.reserveContinuation(f.meta.agentId, "continue", []);
	assert.equal(reservation.kind, "reserved"); if (reservation.kind !== "reserved") return;
	await f.runs.resume(f.meta, reservation.runId, "Second assignment", f.ctx);
	f.transport.complete("pane-run-2", "Second terminal result"); await f.flush();
	const saved = readMeta(file)!;
	assert.deepEqual(saved.runs.map((run) => run.status), ["completed", "completed"]);
	assert.equal(saved.herdr?.runId, "pane-run-2");
	assert.equal((saved.runs[0] as HerdrCapturedSummary).herdr?.runId, "pane-run-1");
	assert.equal((saved.runs[0] as HerdrCapturedSummary).herdr?.destinationCommitted, true);
	assert.notEqual((saved.runs[1] as HerdrCapturedSummary).herdr?.destinationCommitted, true);
	f.runs.dispose(); f.transport.retired = true;
	const transport = new Transport(f.transport.data);
	const noExecution = () => assert.fail("terminal receipt recovery must not reserve, track, settle, or emit execution");
	const diagnostics: string[] = [];
	const host: HerdrRunsHost = { trackRun: noExecution, settle: noExecution, forwardPendingStop: noExecution,
		backgroundRun: noExecution, includeEnvelopes: noExecution, emit: noExecution,
		persist(meta) { writeMeta(file, meta); }, diagnostic(message) { diagnostics.push(message); } };
	const recovered = new HerdrRuns(host, { schedule: () => ({ cancel() {} }) });
	t.after(() => recovered.dispose());
	const flush = async () => { for (let i = 0; i < 4; i++) { await recovered.retryPending(); await Promise.resolve(); } };
	const port = new HerdrBackendAdapter(transport);
	if (order === "after") {
		recovered.rebind(port);
		transport.complete("pane-run-1", "Replayed first preview");
		await flush(); assert.deepEqual(transport.acks, [], "an unknown replay must not be acknowledged speculatively");
	}
	recovered.restoreTerminal(saved, f.runId);
	recovered.restoreTerminal(saved, reservation.runId);
	recovered.restoreTerminal(saved, f.runId);
	assert.equal(recovered.getHandle(f.runId), undefined); assert.equal(recovered.getHandle(reservation.runId), undefined);
	if (order === "before") recovered.rebind(port);
	transport.complete("pane-run-1", "Replayed first preview");
	transport.complete("pane-run-2", "Replayed second preview");
	await flush();
	assert.deepEqual(transport.acks, ["notice-pane-run-1"], "the earlier run uses its own durable receipt, not the latest agent pointer");
	assert.equal(recovered.pendingAcknowledgements(), 1);
	assert.deepEqual(transport.reads, [], "terminal recovery must not rerun settlement or replace its saved result");
	assert.deepEqual(transport.cancels, []); assert.equal(transport.data.sequence, 2);
	recovered.acknowledgeDestination(saved.agentId, reservation.runId); await flush();
	assert.deepEqual(transport.acks, ["notice-pane-run-1", "notice-pane-run-2"]);
	assert.equal(recovered.pendingAcknowledgements(), 0);
	const committed = readMeta(file)!;
	assert.equal(committed.herdr?.runId, "pane-run-2");
	assert(committed.runs.every((run) => (run as HerdrCapturedSummary).herdr?.destinationCommitted === true));
	assert.deepEqual(committed.runs.map((run) => run.resultText), ["First terminal result", "Second terminal result"]);
	transport.complete("unowned-source-run", "Unrelated terminal output");
	recovered.acknowledgeDestination(saved.agentId, "unknown-engine-run"); await flush();
	assert.equal(transport.acks.length, 2); assert.deepEqual(diagnostics, []);
});

test("source acknowledgement waits for a durable destination receipt write and retries failed writes", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	let failures = 1, durableWrites = 0;
	f.host.persist = (meta) => {
		if ((meta.runs[0] as HerdrCapturedSummary).herdr?.destinationCommitted) {
			if (failures-- > 0) throw new Error("Injected metadata write failure");
			durableWrites++;
		}
	};
	f.transport.complete("pane-run-1", "Finished"); await f.flush();
	f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
	assert.equal(durableWrites, 0); assert.deepEqual(f.transport.acks, []);
	assert.equal(f.runs.pendingAcknowledgements(), 1);
	f.advance(10); await f.flush();
	assert.equal(durableWrites, 1); assert.deepEqual(f.transport.acks, ["notice-pane-run-1"]);
	assert.match(f.diagnostics[0], /destination receipt.*metadata write failure/);
});

test("terminal recovery refuses historical identity guesses, live runs and conflicting associations", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose());
	const saved = structuredClone(f.meta);
	saved.herdr = { agentId: "pane", runId: "latest-pane-run" };
	saved.runs = [{ runId: "older", invocation: "spawn", startedAt: 0, status: "completed" }, { runId: "latest", invocation: "continue", startedAt: 1, status: "completed" }];
	assert.throws(() => f.runs.restoreTerminal(saved, "older"), /No captured Herdr identity/);
	assert.throws(() => f.runs.restoreTerminal(f.meta, f.runId), /terminal Herdr run/);
	f.runs.restoreTerminal(saved, "latest");
	assert.equal(f.runs.getHandle("latest"), undefined);
	assert.equal((saved.runs[1] as HerdrCapturedSummary).herdr?.runId, "latest-pane-run", "the latest unambiguous legacy pointer is migrated durably");
	const conflicting = structuredClone(saved); (conflicting.runs[1] as HerdrCapturedSummary).herdr!.runId = "another-pane-run";
	assert.throws(() => f.runs.restoreTerminal(conflicting, "latest"), /Conflicting restored pane receipt/);
});

test("ack references survive failures, honor bounded exponential backoff and disappear only on success", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	f.transport.ackFailures = 2;
	f.transport.complete("pane-run-1", "Done"); await f.flush();
	f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
	assert.equal(f.runs.pendingAcknowledgements(), 1); assert.equal(f.transport.acks.length, 1);
	await f.flush(); assert.equal(f.transport.acks.length, 1);
	f.advance(10); await f.flush(); assert.equal(f.transport.acks.length, 2);
	f.advance(19); await f.flush(); assert.equal(f.transport.acks.length, 2);
	f.advance(1); await f.flush(); assert.equal(f.transport.acks.length, 3);
	assert.equal(f.runs.pendingAcknowledgements(), 0); assert.equal(f.diagnostics.length, 2);
});

test("exhausted acknowledgement retries retain linkage and rebind enables recovery", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn(); f.transport.ackFailures = 99;
	f.transport.complete("pane-run-1", "Done"); await f.flush();
	f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
	for (const ms of [10, 20, 100]) { f.advance(ms); await f.flush(); }
	assert.equal(f.transport.acks.length, 3); assert.equal(f.runs.pendingAcknowledgements(), 1);
	assert.match(f.diagnostics.at(-1)!, /exhausted; reference retained/);
	const next = new Transport(f.transport.data); f.runs.rebind(new HerdrBackendAdapter(next)); await f.flush();
	assert.deepEqual(next.acks, ["notice-pane-run-1"]); assert.equal(f.runs.pendingAcknowledgements(), 0);
});

test("completed payloads become evictable only after source acknowledgement succeeds", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	assert.equal(f.runs.evict(f.meta.agentId), false);
	f.transport.complete("pane-run-1", "Finished payload"); await f.flush();
	assert.equal(f.runs.evict(f.meta.agentId), false);
	f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
	assert.equal(f.runs.evict(f.meta.agentId), true); assert.equal(f.runs.getHandle(f.runId), undefined);
});

test("early completion is buffered and acknowledged only after destination commit", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); f.transport.early = true;
	await f.spawn(); await f.flush();
	assert.equal(f.outcomes.get(f.runId)?.resultText, "Early full result"); assert.equal(f.control.activeRuns(), 0);
	assert.deepEqual(f.transport.acks, []);
	f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
	assert.equal(f.transport.acks.length, 1);
});

test("foreground read waits and blocked status returns without releasing the admission slot", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose());
	let release!: () => void; f.transport.readGate = new Promise<void>((done) => { release = done; });
	const foreground = f.spawn(false); await Promise.resolve(); await Promise.resolve();
	assert.equal(f.outcomes.size, 0); release();
	const result = await foreground; await f.flush();
	assert.match(result.text, /Full foreground report/); assert.match(result.text, /agentId: engine-agent/);
	assert.equal(f.control.activeRuns(), 0);
	const blocked = fixture(); t.after(() => blocked.runs.dispose()); blocked.transport.foreground = "blocked";
	const waiting = await blocked.spawn(false);
	assert.equal(waiting.details.status, "blocked"); assert.equal(blocked.control.activeRuns(), 1);
	assert.equal(blocked.control.get(blocked.meta.agentId)?.active?.background, true);
	blocked.transport.complete("pane-run-1", "Approved later"); await blocked.flush();
	assert.equal(blocked.control.activeRuns(), 0);
});

test("pending stop during spawn is forwarded after authoritative identity arrives", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose());
	let release!: () => void; f.transport.spawnGate = new Promise<void>((done) => { release = done; });
	const launch = f.spawn(); f.control.requestStop(f.meta.agentId, "user");
	release(); await launch;
	assert.deepEqual(f.transport.cancels, ["pane-run-1"]);
	f.transport.complete("pane-run-1", "Stopped", "stopped"); await f.flush();
	assert.equal(f.outcomes.get(f.runId)?.status, "killed"); assert.equal(f.outcomes.get(f.runId)?.killedBy, "user"); assert.equal(f.control.activeRuns(), 0);
});

test("real Pi Agent tool dispatch consumes HerdrRuns and acknowledges only its persisted root notice", { timeout: 15_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const f = fixture();
	const captures = resolve("captures"); mkdirSync(captures, { recursive: true });
	const root = mkdtempSync(join(captures, "herdr-runs-sdk-"));
	t.after(() => { f.runs.dispose(); rmSync(root, { recursive: true, force: true }); });
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const settle = f.host.settle;
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			pi.registerTool({ name: "Agent", label: "Agent", description: "Delegate one pane assignment", parameters: Type.Object({ prompt: Type.String() }),
				async execute(_id, args, _signal, _update, ctx) {
					const result = await f.runs.spawn(f.meta, f.runId, { ...f.request, prompt: args.prompt }, ctx, { background: true });
					return { content: [{ type: "text", text: result.text }], details: result.details };
				} });
			f.host.settle = (agentId, runId, value) => {
				settle(agentId, runId, value);
				pi.sendMessage({ customType: "subagent-notification", display: true, content: value.resultText, details: { agentId, runId } }, { triggerTurn: false });
			};
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: settings,
		model: getModel("anthropic", "claude-sonnet-4-5"), sessionManager: SessionManager.inMemory(root), resourceLoader: loader });
	try {
		let calls = 0;
		session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream(); const first = calls++ === 0;
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: first ? [{ type: "toolCall", id: "pane-call", name: "Agent", arguments: { prompt: "Inspect panes" } }] : [{ type: "text", text: "Parent continues" }],
				stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(() => { stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(); }); return stream;
		};
		await session.bindExtensions({ mode: "json" });
		await session.prompt("Use the pane agent", { source: "extension" });
		assert.equal(f.transport.data.current, "pane-run-1", JSON.stringify(session.messages));
		assert.equal(f.control.activeRuns(), 1);
		f.transport.complete("pane-run-1", "Full report from actual Pi dispatch"); await f.flush();
		let persisted = session.sessionManager.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === "subagent-notification");
		for (let i = 0; !persisted && i < 100; i++) {
			await new Promise((done) => setTimeout(done, 5));
			persisted = session.sessionManager.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === "subagent-notification");
		}
		assert(persisted, JSON.stringify({ outcomes: [...f.outcomes], messages: session.messages, entries: session.sessionManager.getEntries() })); assert.match(JSON.stringify(persisted), /Full report from actual Pi dispatch/);
		assert.deepEqual(f.transport.acks, []);
		f.runs.acknowledgeDestination(f.meta.agentId, f.runId); await f.flush();
		assert.deepEqual(f.transport.acks, ["notice-pane-run-1"]); assert.equal(f.control.activeRuns(), 0);
	} finally { session.dispose(); }
});

test("a continuation captures a new run identity without mutating a surviving old handle", async (t) => {
	const f = fixture(); t.after(() => f.runs.dispose()); await f.spawn();
	const first = f.runs.getHandle(f.runId)!;
	f.transport.complete("pane-run-1", "First report"); await f.flush();
	const e = envelope("resume-message"); f.inbox.set(e.id, e);
	const reservation = f.control.reserveContinuation(f.meta.agentId, "continue", [e.id]); assert.equal(reservation.kind, "reserved");
	if (reservation.kind !== "reserved") return;
	await f.runs.resume(f.meta, reservation.runId, e.text, f.ctx, [e.id]);
	const current = f.runs.getHandle(reservation.runId)!;
	assert.notEqual(first.runId, current.runId);
	await first.cancel("user"); assert.deepEqual(f.transport.cancels, [], "old finished handle cannot cancel the current run");
	await current.cancel("user"); assert.deepEqual(f.transport.cancels, ["pane-run-2"]);
	f.transport.complete("pane-run-2", "Second report"); await f.flush();
	assert.equal(f.meta.runs.length, 2); assert.equal(f.control.activeRuns(), 0); assert.equal(e.state, "included");
});
