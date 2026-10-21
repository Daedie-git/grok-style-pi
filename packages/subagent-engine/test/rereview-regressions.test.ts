// External re-review regressions. Real extension-loaded AgentSessions, offline providers and a structural pane port.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Engine, ROOT_CALLER } from "../src/engine.ts";
import type { HerdrCapturedSummary, HerdrRuns, HerdrRunsPort, PaneNotice, PanePhase } from "../src/backends/herdr-runs.ts";
import { listMetas } from "../src/store/meta.ts";
import { Outbox } from "../src/store/outbox.ts";
import type { AgentMeta } from "../src/types.ts";
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
