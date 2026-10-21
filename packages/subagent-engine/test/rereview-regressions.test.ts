// External re-review regressions. Real extension-loaded AgentSessions, offline providers and a structural pane port.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Engine, ROOT_CALLER } from "../src/engine.ts";
import type { HerdrCapturedSummary, HerdrRuns, HerdrRunsPort, PaneNotice, PanePhase } from "../src/backends/herdr-runs.ts";
import { listMetas, writeMeta } from "../src/store/meta.ts";
import { agentFiles } from "../src/store/paths.ts";
import { Outbox } from "../src/store/outbox.ts";
import type { AgentMeta, NoticeState } from "../src/types.ts";
import { createHarness, toolResultText, until } from "./fixtures/harness.ts";

const foregroundParent = ({ index }: { index: number }) => index === 0
	? { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Start", run_in_background: false } }] }
	: { text: "root done" };
const customParent = ({ index }: { index: number }) => index === 0
	? { tools: [{ name: "Agent", args: { description: "Custom", prompt: "Start", subagent_type: "custom", run_in_background: false } }] }
	: { text: "root done" };
const definition = (tools: string, extra = "") => `---\nname: custom\ndescription: test\ntools: ${tools}\n${extra}---\nWork.`;
function barrier() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { promise, release };
}
function offline(t: { mock: { method: (target: object, name: string, impl: () => unknown) => unknown } }) {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
}
// Reload fixtures retain the actual extension API/context rather than substituting a fake root.
function binding(engine: Engine) {
	return (engine as unknown as { root: { pi: ExtensionAPI; ctx: ExtensionContext } }).root;
}

class PanePort implements HerdrRunsPort {
	resumes = 0;
	cancels = 0;
	failCancel = false;
	phase: PanePhase = "completed";
	private sequence = 0;
	private listeners = new Set<(notice: PaneNotice) => void>();
	proxy(meta: AgentMeta, ref: { agentId: string; runId: string }): AgentMeta {
		return { ...structuredClone(meta), backend: "herdr", herdr: ref };
	}
	async spawn(_request: unknown, _ctx: ExtensionContext, meta: AgentMeta) {
		const runId = `pane-run-${++this.sequence}`;
		return { agentId: "pane", runId, text: "launched", meta: this.proxy(meta, { agentId: "pane", runId }) };
	}
	async resume(meta: AgentMeta) {
		this.resumes++;
		const runId = `pane-run-${++this.sequence}`;
		return { runId, text: "resumed", meta: this.proxy(meta, { agentId: "pane", runId }) };
	}
	async read(meta: AgentMeta) {
		return { phase: this.phase, status: this.phase, resultText: "pane result", text: "pane result", runId: meta.herdr!.runId };
	}
	async cancel(meta: AgentMeta) {
		this.cancels++;
		if (this.failCancel) throw new Error("temporary cancellation failure");
		this.phase = "stopped";
		const runId = meta.herdr?.runId;
		assert.ok(runId);
		queueMicrotask(() => {
			for (const listener of this.listeners) listener({ noticeId: `stop-${this.cancels}`, agentId: meta.agentId,
				herdrAgentId: "pane", runId, phase: "stopped", text: "stopped" });
		});
		return { acknowledged: false, message: "requested" };
	}
	async deliver() { return { ok: true as const, state: "submitted" as const }; }
	onNotice(listener: (notice: PaneNotice) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	replay(notice: PaneNotice) { for (const listener of this.listeners) listener(notice); }
	async acknowledge() {}
}

const paneParent = (background: boolean) => ({ index }: { index: number }) => index === 0
	? { tools: [{ name: "Agent", args: { backend: "pane", description: "Pane", prompt: "Start", run_in_background: background } }] }
	: { text: "root done" };

test("RR01: stopping a detached-root pane continuation fences transport resume before rebind", { timeout: 20_000 }, async t => {
	offline(t);
	const h = await createHarness({ panes: true, parent: paneParent(false), child: () => () => ({ text: "unused" }) });
	const port = new PanePort();
	const detach = h.engine.attachHerdr(port);
	t.after(async () => { await h.close(); detach(); });
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.engine.control.conversations.keys()][0];
	await until(() => !h.engine.control.get(id)?.exiting);
	const root = binding(h.engine);
	h.engine.detachRoot();
	await h.engine.sendMessage({ to: id, message: "must not resume" }, ROOT_CALLER, "detached-pane");
	assert.equal(h.engine.control.get(id)!.active?.phase, "reserved");
	assert.equal(port.resumes, 0);
	await h.engine.userStop(id);
	await h.engine.bindRoot(root.pi, root.ctx);
	await until(() => !h.engine.control.get(id)?.active);
	assert.equal(port.resumes, 0);
	assert.equal(port.cancels, 0, "no remote execution was admitted to cancel");
	assert.equal(h.engine.control.get(id)!.meta.runs.at(-1)!.status, "killed");
	assert.equal(h.engine.control.get(id)!.meta.runs.at(-1)!.killedBy, "user");
});

test("RR02: Agent -> Agent(Explore) revokes general-purpose in live and retained sessions", { timeout: 20_000 }, async t => {
	offline(t);
	for (const mode of ["live", "retained"] as const) await t.test(mode, async t => {
		let now = 10_000;
		const entered = barrier(), output = barrier();
		let owner = "";
		const nested = { tools: [{ name: "Agent", args: { description: "Forbidden nested", prompt: "work", subagent_type: "general-purpose", run_in_background: false } }] };
		const h = await createHarness({ now: () => now, parent: customParent, agentFiles: { "custom.md": definition("[Agent]") },
			child: id => {
				owner ||= id;
				return ({ index }) => {
					if (id !== owner) return { text: "forbidden nested ran" };
					if (mode === "live" && index === 0) { entered.release(); return { wait: output.promise, then: nested }; }
					return mode === "retained" && index === 1 ? nested : { text: "owner done" };
				};
			},
		});
		t.after(async () => { output.release(); await h.close(); });
		const prompt = h.parent.prompt("go", { source: "extension" });
		if (mode === "live") await entered.promise;
		else { await prompt; await until(() => !h.engine.control.get(owner)?.exiting); }
		const retained = h.children.get(owner)!;
		writeFileSync(join(h.root, "agent", "agents", "custom.md"), definition("[Agent(Explore)]"));
		now += 2_001; // Do not prewarm discovery: the real admission boundary must refresh it.
		if (mode === "live") { output.release(); await prompt; }
		else {
			await h.engine.sendMessage({ to: owner, message: "try nested launch" }, ROOT_CALLER, "narrowed-type");
			await until(() => (h.requests.children.get(owner) ?? 0) >= 3 && !h.engine.control.get(owner)?.active);
			assert.equal(h.children.get(owner), retained, "exercise the retained installer closure");
		}
		const result = retained.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
		assert.ok(result && result.role === "toolResult");
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /only launch: Explore/);
		assert.equal(h.children.size, 1);
		assert.equal(h.engine.agentSnapshots().filter(agent => agent.depth === 2).length, 0);
	});
});

test("RR03: stripped continuation is explicitly refused and never automatically retried", { timeout: 20_000 }, async t => {
	offline(t);
	let sawContinuation = false;
	const marker = "UNSEEN_CONTINUATION_RR03";
	const h = await createHarness({ parent: foregroundParent, child: () => ({ index, messages }) => {
		if (index > 0) sawContinuation ||= JSON.stringify(messages).includes(marker);
		return { text: "child report" };
	} });
	t.after(() => h.close());
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.children.keys()][0], child = h.children.get(id)!;
	await until(() => !h.engine.control.get(id)?.exiting);
	const transform = child.agent.transformContext;
	child.agent.transformContext = async (messages, signal) => {
		const projected = transform ? await transform(messages, signal) : messages;
		return projected.filter(message => !JSON.stringify(message).includes(marker));
	};
	await h.engine.sendMessage({ to: id, message: marker }, ROOT_CALLER, "stripped");
	await until(() => h.requests.children.get(id) === 2 && !h.engine.control.get(id)?.active && !h.engine.control.get(id)?.exiting);
	const [envelope] = h.engine.inbox(id).all();
	assert.equal(sawContinuation, false);
	assert.equal(envelope.state, "refused");
	assert.match(envelope.refusedReason!, /context transform/i);
	assert.equal(h.engine.inbox(id).undelivered().length, 0);
	await tick();
	assert.equal(h.requests.children.get(id), 2);
	assert.equal(h.engine.control.get(id)!.meta.runs.length, 2, "settlement did not reserve a retry");
});

test("RR03: an earlier equal message does not prove a newly stripped instance was included", { timeout: 20_000 }, async t => {
	offline(t);
	const marker = "REPEATED_CONTINUATION_RR03";
	const h = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => h.close());
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.children.keys()][0], child = h.children.get(id)!;
	const idle = () => !h.engine.control.get(id)?.active && !h.engine.control.get(id)?.exiting;
	await until(idle);
	await h.engine.sendMessage({ to: id, message: marker }, ROOT_CALLER, "first-instance");
	await until(() => h.requests.children.get(id) === 2 && idle());
	// Strip only the newest copy: the earlier, already delivered one stays in the request.
	const transform = child.agent.transformContext;
	child.agent.transformContext = async (messages, signal) => {
		const projected = transform ? await transform(messages, signal) : messages;
		const last = projected.findLastIndex(message => JSON.stringify(message).includes(marker));
		return projected.filter((_, index) => index !== last);
	};
	await h.engine.sendMessage({ to: id, message: marker }, ROOT_CALLER, "second-instance");
	await until(() => h.requests.children.get(id) === 3 && idle());
	const [first, second] = h.engine.inbox(id).all();
	assert.equal(first.state, "included");
	assert.equal(second.state, "refused");
	assert.match(second.refusedReason!, /context transform/i);
});

test("RR03: a transform that clones and re-times every message does not refuse visible input", { timeout: 20_000 }, async t => {
	offline(t);
	const marker = "RETIMED_CONTINUATION_RR03";
	const h = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => h.close());
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.children.keys()][0], child = h.children.get(id)!;
	const idle = () => !h.engine.control.get(id)?.active && !h.engine.control.get(id)?.exiting;
	await until(idle);
	const transform = child.agent.transformContext;
	child.agent.transformContext = async (messages, signal) => {
		const projected = transform ? await transform(messages, signal) : messages;
		return projected.map(message => ({ ...message, timestamp: 0 }) as typeof message);
	};
	await h.engine.sendMessage({ to: id, message: marker }, ROOT_CALLER, "retimed");
	await until(() => h.requests.children.get(id) === 2 && idle());
	assert.equal(h.engine.inbox(id).all()[0].state, "included");
});

test("RR03: pruning an older equal message does not refuse the surviving new instance", { timeout: 20_000 }, async t => {
	offline(t);
	const marker = "PRUNED_HISTORY_RR03";
	const h = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => h.close());
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.children.keys()][0], child = h.children.get(id)!;
	const idle = () => !h.engine.control.get(id)?.active && !h.engine.control.get(id)?.exiting;
	await until(idle);
	await h.engine.sendMessage({ to: id, message: marker }, ROOT_CALLER, "old-instance");
	await until(() => h.requests.children.get(id) === 2 && idle());
	// History pruning drops the oldest copy and keeps the newest.
	const transform = child.agent.transformContext;
	child.agent.transformContext = async (messages, signal) => {
		const projected = transform ? await transform(messages, signal) : messages;
		const first = projected.findIndex(message => JSON.stringify(message).includes(marker));
		return projected.filter((_, index) => index !== first);
	};
	await h.engine.sendMessage({ to: id, message: marker }, ROOT_CALLER, "new-instance");
	await until(() => h.requests.children.get(id) === 3 && idle());
	assert.deepEqual(h.engine.inbox(id).all().map(envelope => envelope.state), ["included", "included"]);
});

test("RR03: input split across tagged parts is included and provenance never reaches the provider", { timeout: 20_000 }, async t => {
	offline(t);
	const marker = "SPLIT_FIRST_LINE\nSPLIT_SECOND_LINE";
	let leaked = false;
	const h = await createHarness({ parent: foregroundParent, child: () => ({ messages }) => {
		leaked ||= JSON.stringify(messages).includes("subagentInputRun");
		return { text: "child report" };
	} });
	t.after(() => h.close());
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.children.keys()][0], child = h.children.get(id)!;
	const idle = () => !h.engine.control.get(id)?.active && !h.engine.control.get(id)?.exiting;
	await until(idle);
	const transform = child.agent.transformContext;
	child.agent.transformContext = async (messages, signal) => {
		const projected = transform ? await transform(messages, signal) : messages;
		return projected.map(message => !Array.isArray((message as { content?: unknown }).content) ? message : ({
			...message,
			content: ((message as { content: { type: string; text?: string }[] }).content).flatMap(part =>
				part.type === "text" && part.text?.includes("\n") ? part.text.split("\n").map(text => ({ ...part, text })) : [part]),
		}) as typeof message);
	};
	await h.engine.sendMessage({ to: id, message: marker }, ROOT_CALLER, "split");
	await until(() => h.requests.children.get(id) === 2 && idle());
	assert.equal(h.engine.inbox(id).all()[0].state, "included");
	assert.equal(leaked, false, "the provenance field is stripped from every provider request");
});

test("RR07: both public stop paths retry failed pane cancellation and emit stop-failed", { timeout: 20_000 }, async t => {
	offline(t);
	for (const retry of ["userStop", "stop"] as const) await t.test(retry, async t => {
		const h = await createHarness({ panes: true, parent: paneParent(true), child: () => () => ({ text: "unused" }) });
		const port = new PanePort(); port.phase = "running"; port.failCancel = true;
		const detach = h.engine.attachHerdr(port);
		t.after(async () => { await h.close(); detach(); });
		await h.parent.prompt("go", { source: "extension" });
		const id = [...h.engine.control.conversations.keys()][0];
		let failure: { agentId: string; runId: string } | undefined;
		h.engine.subscribe(event => { if (event.type === "stop-failed") failure = event; });
		await h.engine.userStop(id);
		await until(() => failure !== undefined);
		assert.equal(port.cancels, 1);
		assert.equal(failure!.agentId, id);
		assert.equal(failure!.runId, h.engine.control.get(id)!.active!.runId);
		assert.equal(h.engine.control.activeRuns(), 1, "failed send does not free the active slot");
		assert.equal(h.engine.control.get(id)!.meta.stoppedByUser, true);
		port.failCancel = false;
		if (retry === "userStop") await h.engine.userStop(id);
		else assert.match((await h.engine.stop(id, ROOT_CALLER, "user")).text, /Stopping/);
		await until(() => !h.engine.control.get(id)?.active);
		assert.equal(port.cancels, 2);
		assert.equal(h.engine.control.get(id)!.meta.runs.at(-1)!.status, "killed");
	});
});

test("RR08: memory-only grants allow owned MEMORY.md but refuse outside writes", { timeout: 20_000 }, async t => {
	offline(t);
	let memory = "", outside = "";
	const h = await createHarness({ parent: customParent, agentFiles: { "custom.md": definition("[]", "memory: user\n") },
		child: () => ({ index }) => index === 0 ? { tools: [
			{ name: "write", args: { path: memory, content: "owned memory" } },
			{ name: "write", args: { path: outside, content: "must not write" } },
		] } : { text: "done" },
	});
	memory = join(h.root, "agent", "agent-memory", "custom", "MEMORY.md");
	outside = join(h.root, "OUTSIDE.txt");
	t.after(() => h.close());
	await h.parent.prompt("go", { source: "extension" });
	const child = [...h.children.values()][0];
	const results = child.messages.filter(message => message.role === "toolResult" && message.toolName === "write");
	assert.equal(results.length, 2);
	assert.equal((results[0] as { isError?: boolean }).isError, false);
	assert.equal(readFileSync(memory, "utf8"), "owned memory");
	assert.equal((results[1] as { isError?: boolean }).isError, true);
	assert.equal(existsSync(outside), false);
	assert.match(toolResultText(child, "write")[1], /memory|allowed|scope/i);
});

test("RR09: branched root ignores inherited main receipts and includes later owned receipts", { timeout: 20_000 }, async t => {
	offline(t);
	const h = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	let next: Engine | undefined;
	t.after(async () => { await next?.shutdownRoot("quit"); await h.close(); });
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.children.keys()][0];
	await until(() => !h.engine.control.get(id)?.exiting);
	const caller = { agentId: id, depth: 1, background: true, isFork: false };
	const inherited = await h.engine.sendMessage({ to: "main", message: "ancestor message" }, caller, "ancestor");
	await until(() => h.parent.messages.some(message => (message as { customType?: string }).customType === "subagent-message") && !h.parent.isStreaming);
	const root = binding(h.engine), oldId = h.parent.sessionManager.getSessionId();
	h.engine.detachRoot();
	h.parent.sessionManager.createBranchedSession(h.parent.sessionManager.getLeafId()!);
	assert.notEqual(h.parent.sessionManager.getSessionId(), oldId);
	const deps = (h.engine as unknown as { deps: ConstructorParameters<typeof Engine>[0] }).deps;
	next = new Engine(deps);
	await next.bindRoot(root.pi, root.ctx);
	const owned = await next.sendMessage({ to: "main", message: "owned message after fork" }, caller, "owned");
	assert.equal(owned.success, true);
	assert.notEqual(owned.envelopeId, inherited.envelopeId);
	await until(() => h.parent.sessionManager.getEntries().some(entry => entry.type === "custom_message" && (entry.details as { envelopeId?: string })?.envelopeId === owned.envelopeId) && !h.parent.isStreaming);
	// Rebinding is the public reload receipt scan; the inherited entry precedes the owned entry.
	await next.bindRoot(root.pi, root.ctx);
	const inbox = (next as unknown as { mainInbox(): { all(): { id: string; state: string }[] } }).mainInbox();
	assert.deepEqual(inbox.all().map(envelope => ({ id: envelope.id, state: envelope.state })), [{ id: owned.envelopeId, state: "included" }]);
});

test("RR10: acknowledged running-stop and parked-stop sessions evict after grace without losing stopped disposition", { timeout: 20_000 }, async t => {
	offline(t);
	for (const mode of ["running", "parked"] as const) await t.test(mode, async t => {
		let now = 1_000, count = 0;
		const hold = barrier();
		const h = await createHarness({ now: () => now,
			parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Owner", prompt: "work", run_in_background: true } }] } : { text: "root done" },
			child: () => ++count === 1 && mode === "parked"
				? ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Nested", prompt: "wait", run_in_background: true } }] } : { text: "owner parked" }
				: () => ({ wait: hold.promise, then: { text: "done" } }),
		});
		t.after(async () => { hold.release(); await h.close(); });
		await h.parent.prompt("go", { source: "extension" });
		const owner = [...h.engine.control.conversations.values()].find(conversation => conversation.meta.spawnDepth === 1)!;
		if (mode === "parked") await until(() => owner.disposition === "parked" && !owner.exiting);
		else await until(() => h.requests.children.get(owner.meta.agentId) === 1);
		h.engine.notePrompt(true); // Hold destination receipts while cancellation settles.
		await h.engine.userStop(owner.meta.agentId);
		await until(() => h.engine.control.activeRuns() === 0);
		assert.equal(owner.disposition, "stopped");
		if (mode === "parked") {
			// Stopping a parked owner cancels its withheld report: nothing is left to acknowledge.
			assert.equal(owner.notified, true);
			assert.ok(!h.engine.control.evictable().includes(owner), "a stopped parked owner still waits for grace");
			now += 60_000;
		} else {
			assert.equal(owner.notified, false);
			owner.notified = true;
			assert.ok(!h.engine.control.evictable().includes(owner), "even an acknowledged stop must wait for grace");
			owner.notified = false;
			now += 60_000;
			assert.ok(!h.engine.control.evictable().includes(owner), "unacknowledged stop must retain its resources");
			// The stopped run's report receipt (granted explicitly here) makes it eligible.
			owner.notified = true;
		}
		assert.ok(h.engine.control.evictable().includes(owner), "stopped owner is eligible after grace");
		// Exercise maintenance resource release as well as its eligibility predicate.
		await (h.engine as unknown as { sweep(): Promise<void> }).sweep();
		assert.equal(owner.evictAt, undefined);
		assert.equal(owner.disposition, "stopped");
		assert.equal(owner.meta.stoppedByUser, true);
	});
});

test("RR06 follow-up: acknowledged outbox recovers source receipt after destination metadata write failure", { timeout: 20_000 }, async t => {
	offline(t);
	const h = await createHarness({ panes: true, parent: paneParent(true), child: () => () => ({ text: "unused" }) });
	const port = new PanePort(); port.phase = "running";
	let earlyAcks = 0;
	t.mock.method(port, "acknowledge", async () => { earlyAcks++; throw new Error("source transport unavailable"); });
	const detach = h.engine.attachHerdr(port);
	let restored: Engine | undefined;
	t.after(async () => { detach(); await restored?.shutdownRoot("quit"); await h.close(); });
	await h.parent.prompt("go", { source: "extension" });
	const id = [...h.engine.control.conversations.keys()][0];
	const meta = h.engine.control.get(id)!.meta;
	const runId = meta.runs[0].runId;
	const paneRunId = meta.herdr?.runId;
	assert.ok(paneRunId);
	const original = h.engine as unknown as { persistMeta(meta: AgentMeta): void; deps: ConstructorParameters<typeof Engine>[0] };
	const persist = original.persistMeta.bind(h.engine);
	let failedWrites = 0;
	t.mock.method(original, "persistMeta", (value: AgentMeta) => {
		if (value.runs.some(summary => (summary as HerdrCapturedSummary).herdr?.destinationCommitted)) {
			failedWrites++;
			throw new Error("injected destination commitment metadata write failure");
		}
		persist(value);
	});
	const notice: PaneNotice = { noticeId: "receipt-crash", agentId: id, herdrAgentId: "pane", runId: paneRunId, phase: "completed", text: "pane result" };
	port.phase = "completed";
	port.replay(notice);
	await until(() => !h.engine.control.get(id)?.active && !h.engine.control.get(id)?.exiting);
	await until(() => h.parent.sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === "subagent-notification"));
	h.engine.observeReceipts();
	await until(() => failedWrites > 0);
	const dir = join(h.root, "agent", "subagents", h.parent.sessionId);
	const durable = listMetas(dir).find(item => item.agentId === id)!;
	assert.equal(durable.runs[0].status, "completed");
	assert.equal((durable.runs[0] as HerdrCapturedSummary).herdr?.destinationCommitted, undefined);
	assert.equal(new Outbox(join(dir, "outbox.jsonl")).acknowledgedRun(id, runId), true, "destination receipt is durable independently of the failed metadata write");
	assert.equal(earlyAcks, 0, "failed commitment persistence cannot acknowledge the source");
	const root = binding(h.engine);
	detach();
	await h.engine.shutdownRoot("reload"); // Stop the old retry machinery; do not let it assist recovery.
	const healthy = new PanePort(); healthy.phase = "completed";
	const acknowledgements: string[] = [];
	t.mock.method(healthy, "acknowledge", async (noticeId: string) => { acknowledgements.push(noticeId); });
	restored = new Engine(original.deps);
	await restored.bindRoot(root.pi, root.ctx);
	restored.attachHerdr(healthy);
	healthy.replay(notice);
	const recoveredRuns = (restored as unknown as { paneRuns: HerdrRuns }).paneRuns;
	await until(() => acknowledgements.length > 0);
	await recoveredRuns.retryPending();
	assert.deepEqual(acknowledgements, [notice.noticeId]);
	assert.equal(recoveredRuns.pendingAcknowledgements(), 0);
	healthy.replay(notice);
	await recoveredRuns.retryPending();
	assert.deepEqual(acknowledgements, [notice.noticeId], "duplicate replay must not acknowledge twice");
	assert.equal(healthy.resumes, 0, "terminal receipt recovery does not reopen execution");
	assert.equal(restored.control.activeRuns(), 0);
	assert.equal((listMetas(dir).find(item => item.agentId === id)!.runs[0] as HerdrCapturedSummary).herdr?.destinationCommitted, true);
});

test("RR05 follow-up: a blocking SubagentStop hook cannot restart an exhausted schema agent", { timeout: 20_000 }, async t => {
	offline(t);
	const script = "export const meta = {name:'schema-hook-cap',description:'Invalid handback stop-hook regression',phases:[]}; return await agent('Return a number',{schema:{type:'number'}});";
	const h = await createHarness({ env: { PI_WORKFLOW_APPROVE: "1", PI_STOP_HOOK_BLOCK_CAP: "1" },
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Workflow", args: { script } }] } : { text: "root done" },
		child: () => () => ({ tools: [
			{ name: "StructuredOutput", args: { result: "invalid" } },
			{ name: "read", args: { path: join(h.root, "schema-input.txt") } },
		] }),
	});
	t.after(() => h.close());
	writeFileSync(join(h.root, "schema-input.txt"), "harmless sibling read");
	const hook = join(h.root, "blocking-stop-hook.mjs"), marker = join(h.root, "stop-hook-ran.txt");
	writeFileSync(hook, `import { appendFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => { appendFileSync(${JSON.stringify(marker)}, 'blocked\\n'); console.log(JSON.stringify({decision:'block',reason:'Do another pass.'})); });\n`);
	writeFileSync(join(h.root, "agent", "hooks.json"), JSON.stringify({ hooks: { SubagentStop: [{ matcher: "general-purpose", hooks: [{ type: "command", command: process.execPath, args: [hook] }] }] } }));
	await h.parent.prompt("Run the schema agent with a blocking stop hook", { source: "extension" });
	const receipt = h.parent.messages.find(message => message.role === "toolResult" && message.toolName === "Workflow");
	assert.ok(receipt && receipt.role === "toolResult");
	assert.equal(receipt.isError, false);
	const { runId } = receipt.details as { runId: string };
	assert.ok(runId);
	const file = join(h.root, "agent", "subagents", h.parent.sessionId, "workflows", `${runId}.json`);
	await until(() => existsSync(file), 15_000);
	const snapshot = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(snapshot.status, "failed");
	assert.match(snapshot.error ?? "", /5 invalid attempts/);
	assert.equal(h.children.size, 1);
	assert.equal([...h.requests.children.values()][0], 5);
	const child = [...h.children.values()][0];
	assert.equal(toolResultText(child, "StructuredOutput").length, 5);
	assert.match(toolResultText(child, "StructuredOutput")[4], /Too many invalid attempts/);
	assert.equal(toolResultText(child, "read").length, 5);
	assert.ok(existsSync(marker), "the real project SubagentStop hook ran and returned blocking feedback");
	assert.ok(readFileSync(marker, "utf8").includes("blocked"));
});

// Re-review 3, receipt recovery: only durable destination evidence can finish a transfer.
type ReceiptEngine = {
	deps: ConstructorParameters<typeof Engine>[0];
	outbox: Outbox;
	paneRuns: HerdrRuns;
	reconcileReceipts(): void;
	ackNotices(keys: string[]): void;
};

for (const destination of ["root", "owner"] as const) {
	test(`RR06: restart finishes an interrupted ${destination} acknowledgement`, { timeout: 20_000 }, async t => {
		offline(t);
		// The disabled arm is a mutation control: the same recovery assertion must fail
		// when startup reconciliation is stubbed, without changing production sources.
		for (const reconcile of [true, false]) await t.test(reconcile ? "reconciles" : "detects missing reconciliation", async t => {
			const h = await createHarness({ parent: () => ({ text: "unused" }), child: () => () => ({ text: "unused" }) });
			const root = binding(h.engine), internals = h.engine as unknown as ReceiptEngine;
			const sessionId = h.parent.sessionId;
			const files = agentFiles(join(h.root, "agent"), sessionId, "receipt-agent");
			const summary: HerdrCapturedSummary = { runId: "receipt-run", invocation: "spawn", startedAt: 0, endedAt: 1,
				status: "completed", resultText: "pane result", herdr: { agentId: "pane", runId: "receipt-pane-run" } };
			writeMeta(files.metaFile, { agentId: "receipt-agent", agentType: "Explore", description: "Receipt recovery",
				rootSessionId: sessionId, spawnDepth: 1, cwd: h.root, sessionFile: files.sessionFile, taskListId: sessionId,
				backend: "herdr", herdr: { agentId: "pane", runId: "receipt-pane-run" }, stopGeneration: 0,
				definition: { agentType: "Explore", description: "Locate", prompt: "Locate", source: "built-in", skills: [], disallowedTools: [], diagnostics: [] },
				runs: [summary] });
			let restored: Engine | undefined;
			t.after(async () => { await restored?.shutdownRoot("quit"); await h.close(); });
			const notice = internals.outbox.create({ rootSessionId: sessionId, agentId: "receipt-agent", runId: summary.runId,
				kind: "terminal_result", destination, passive: false, payload: { agentId: "receipt-agent", description: "Receipt recovery",
					status: "completed", resultText: "pane result", resultTruncated: false, transcriptPath: files.sessionFile, resumable: true } });
			// Fault the acknowledged journal append, not the persisted/accepted write.
			const journal = (internals.outbox as unknown as { journal: { append(records: { state: string }[]): void } }).journal;
			const append = journal.append.bind(journal);
			t.mock.method(journal, "append", (records: { state: string }[]) => {
				if (records.some(record => record.state === "acknowledged")) throw new Error("injected acknowledged append failure");
				append(records);
			});
			if (destination === "root") {
				h.parent.sessionManager.appendCustomMessageEntry("subagent-notification", "pane result", false, { noticeKeys: [notice.key] });
				assert.throws(() => h.engine.observeReceipts(), /injected acknowledged append failure/);
				assert.equal(internals.outbox.get(notice.key)!.state, "persisted");
			} else {
				const accepted = h.engine.inbox(destination).accept({ acceptanceKey: `notice:${notice.key}`, from: notice.agentId,
					to: destination, text: "pane result", noticeKey: notice.key });
				assert.ok(!("conflict" in accepted));
				assert.throws(() => internals.ackNotices([notice.key]), /injected acknowledged append failure/);
				assert.equal(internals.outbox.get(notice.key)!.state, "pending");
			}
			await h.engine.shutdownRoot("reload"); // No old retry machinery may assist the fresh engine.
			restored = new Engine(internals.deps);
			const recovered = restored as unknown as ReceiptEngine;
			if (!reconcile) t.mock.method(recovered, "reconcileReceipts", () => {});
			// Public restart entry point, using the real extension binding and durable agent directory.
			await restored.bindRoot(root.pi, root.ctx);
			const port = new PanePort(), acknowledgements: string[] = [];
			let executionCalls = 0;
			for (const method of ["spawn", "resume", "read", "deliver", "cancel"] as const) {
				t.mock.method(port, method, async () => { executionCalls++; throw new Error("Recovery must not execute"); });
			}
			t.mock.method(port, "acknowledge", async (id: string) => { acknowledgements.push(id); });
			restored.attachHerdr(port);
			const source: PaneNotice = { noticeId: "receipt-source", agentId: notice.agentId, herdrAgentId: "pane",
				runId: "receipt-pane-run", phase: "completed", text: "pane result" };
			port.replay(source);
			await tick();
			await recovered.paneRuns.retryPending();
			const assertRecovered = () => assert.equal(recovered.outbox.get(notice.key)!.state, "acknowledged");
			if (reconcile) {
				assertRecovered();
				assert.deepEqual(acknowledgements, [source.noticeId]);
				assert.equal(recovered.paneRuns.pendingAcknowledgements(), 0);
				port.replay(source);
				await tick();
				await recovered.paneRuns.retryPending();
				assert.deepEqual(acknowledgements, [source.noticeId], "duplicate replay cannot acknowledge twice");
				assert.equal((listMetas(join(h.root, "agent", "subagents", sessionId))[0].runs[0] as HerdrCapturedSummary).herdr?.destinationCommitted, true);
			} else {
				assert.throws(assertRecovered, { code: "ERR_ASSERTION" });
				assert.deepEqual(acknowledgements, []);
				assert.equal(recovered.paneRuns.pendingAcknowledgements(), 1);
			}
			assert.equal(restored.control.activeRuns(), 0);
			assert.equal(executionCalls, 0);
			assert.equal(h.requests.parent, 0);
			assert.equal(h.children.size, 0);
			if (destination === "owner") assert.equal(restored.inbox(destination).all().length, 1, "acceptance survives restart without duplication");
		});
	});
}

test("RR06: restart does not acknowledge unconfirmed root notices", { timeout: 20_000 }, async t => {
	offline(t);
	for (const reconcile of [true, false]) await t.test(reconcile ? "reconciles only persisted" : "detects missing reconciliation", async t => {
		const h = await createHarness({ parent: () => ({ text: "unused" }), child: () => () => ({ text: "unused" }) });
		const root = binding(h.engine), internals = h.engine as unknown as ReceiptEngine;
		let restored: Engine | undefined;
		t.after(async () => { await restored?.shutdownRoot("quit"); await h.close(); });
		const records = (["pending", "submitted", "persisted"] as const).map(state => {
			const notice = internals.outbox.create({ rootSessionId: h.parent.sessionId, agentId: "unconfirmed", runId: state,
				kind: "terminal_result", destination: "root", passive: false, payload: { agentId: "unconfirmed", description: "Unconfirmed receipt",
					status: "completed", resultText: state, resultTruncated: false, transcriptPath: "unused", resumable: true } });
			internals.outbox.mark([notice.key], state);
			assert.equal(internals.outbox.get(notice.key)!.state, state);
			return { key: notice.key, state };
		});
		await h.engine.shutdownRoot("reload");
		restored = new Engine(internals.deps);
		const recovered = restored as unknown as ReceiptEngine;
		if (!reconcile) t.mock.method(recovered, "reconcileReceipts", () => {});
		// Isolate receipt recovery from ordinary resubmission of pending root notices.
		// bindRoot still runs its actual restore, reconcile and history-observation paths.
		t.mock.method(restored as unknown as { deliverRoot(): Promise<void> }, "deliverRoot", async () => {});
		await restored.bindRoot(root.pi, root.ctx);
		const states = () => records.map(record => recovered.outbox.get(record.key)!.state);
		const assertReceipts = () => assert.deepEqual(states(), ["pending", "pending", "acknowledged"] satisfies NoticeState[]);
		if (reconcile) assertReceipts();
		else {
			// The persisted positive control makes this negative test mutation-sensitive.
			assert.throws(assertReceipts, { code: "ERR_ASSERTION" });
			assert.deepEqual(states(), ["pending", "pending", "persisted"]);
		}
		assert.equal(restored.control.activeRuns(), 0);
		assert.equal(h.requests.parent, 0);
		assert.equal(h.children.size, 0);
	});
});

// Re-review 3, RR05: host exhaustion fences every later provider request and refuses input it can no longer use.
for (const entrance of ["engine message", "follow-up"] as const) {
	test(`RR05: input queued at the fifth invalid handback (${entrance}) runs no further request`, { timeout: 30_000 }, async t => {
		offline(t);
		const source = "export const meta={name:'exhaust',description:'review',phases:[]};return await agent('number',{schema:{type:'number'}});";
		let receipt: { success: boolean; envelopeId?: string } | undefined;
		const h = await createHarness({ env: { PI_WORKFLOW_APPROVE: "1" }, parent: () => ({ text: "done" }), child: (childId, session) => async ({ index }) => {
			if (index === 4) {
				if (entrance === "engine message") receipt = await h.engine.sendMessage({ to: childId, message: "queued at exhaustion" }, ROOT_CALLER, "rr05-fifth-turn") as never;
				else await session.followUp("queued at exhaustion", undefined, { source: "extension" });
			}
			return index < 5
				? { tools: [{ name: "StructuredOutput", args: { result: "invalid" } }, { name: "read", args: { path: join(h.root, "input.txt") } }] }
				: { tools: [{ name: "read", args: { path: join(h.root, "input.txt") } }] };
		} });
		t.after(() => h.close());
		writeFileSync(join(h.root, "input.txt"), "owned");
		const launch = await h.engine.workflows().launch({ script: source }, h.parent.extensionRunner.createContext());
		assert.notEqual(launch.isError, true);
		const file = join(h.root, "agent/subagents", h.parent.sessionId, "workflows", `${(launch.details as { runId: string }).runId}.json`);
		await until(() => existsSync(file));
		assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "failed");
		const [id] = [...h.children.keys()];
		const child = h.children.get(id)!;
		assert.equal(h.requests.children.get(id), 5, "no provider request after exhaustion");
		assert.equal(child.messages.filter(message => message.role === "toolResult" && message.toolName === "read").length, 5);
		if (receipt?.envelopeId) {
			const envelope = h.engine.inbox(id).all().find(candidate => candidate.id === receipt!.envelopeId)!;
			assert.equal(envelope.state, "refused", "queued input the exhausted run cannot use is refused, not silently kept");
		}
	});
}

// Co-op review of the third re-review fixes.
test("co-op: a message to an exhausted workflow agent after it settles is refused up front, durably", { timeout: 30_000 }, async t => {
	offline(t);
	const source = "export const meta={name:'exhaust',description:'review',phases:[]};return await agent('number',{schema:{type:'number'}});";
	const h = await createHarness({ env: { PI_WORKFLOW_APPROVE: "1" }, parent: () => ({ text: "done" }), child: () => async ({ index }) =>
		index < 5 ? { tools: [{ name: "StructuredOutput", args: { result: "invalid" } }] } : { text: "continued answer" } });
	t.after(() => h.close());
	const launch = await h.engine.workflows().launch({ script: source }, h.parent.extensionRunner.createContext());
	const file = join(h.root, "agent/subagents", h.parent.sessionId, "workflows", `${(launch.details as { runId: string }).runId}.json`);
	await until(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).status === "failed");
	const [id] = [...h.children.keys()];
	const conversation = h.engine.control.get(id)!;
	await until(() => !conversation.active && !conversation.exiting);
	assert.equal(conversation.meta.hostEnded, true, "exhaustion is recorded on the conversation, not only on the live session");
	const parentRequests = h.requests.parent;
	const receipt = await h.engine.sendMessage({ to: id, message: "please continue" }, ROOT_CALLER, "after-exhaust");
	assert.equal(receipt.success, false);
	assert.match(receipt.message, /ended its work/);
	await tick();
	assert.equal(conversation.meta.runs.length, 1, "no continuation run is started");
	assert.equal(h.requests.children.get(id), 5);
	assert.equal(h.requests.parent, parentRequests, "the root is not woken by a failed continuation");
	assert.equal(h.engine.inbox(id).all().at(-1)!.state, "refused");
});

test("co-op: an unreadable owner inbox does not fail the first bind during receipt reconciliation", { timeout: 20_000 }, async t => {
	const h = await createHarness({ parent: () => ({ text: "unused" }), child: () => () => ({ text: "unused" }) });
	const internals = h.engine as unknown as { root: { pi: ExtensionAPI; ctx: ExtensionContext }; deps: ConstructorParameters<typeof Engine>[0]; outbox: Outbox };
	const { pi, ctx } = internals.root;
	const sessionId = h.parent.sessionId;
	internals.outbox.create({ rootSessionId: sessionId, agentId: "child", runId: "r1", kind: "terminal_result", destination: "owner1", passive: false,
		payload: { agentId: "child", description: "d", status: "completed", resultText: "x", resultTruncated: false, transcriptPath: "t", resumable: true } as never });
	await h.engine.shutdownRoot("reload");
	writeFileSync(agentFiles(join(h.root, "agent"), sessionId, "owner1").inboxFile, "{not json\n");
	const restored = new Engine(internals.deps);
	t.after(async () => { await restored.shutdownRoot("quit"); await h.close(); });
	await restored.bindRoot(pi, ctx);
	const bound = await Promise.race([(restored as unknown as { bound: Promise<void> }).bound.then(() => "bound"), new Promise(resolve => setTimeout(() => resolve("unbound"), 2000))]);
	assert.equal(bound, "bound");
	const record = (restored as unknown as { outbox: Outbox }).outbox.unfinished().find(candidate => candidate.destination === "owner1");
	assert.ok(record, "the unconfirmed owner receipt stays unfinished, not acknowledged");
});
