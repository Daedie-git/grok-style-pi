import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HerdrBackendHandle, HerdrBackendNotice, HerdrBackendRequest } from "../../herdr-subagents/src/herdr/backend.ts";
import { HerdrBackendAdapter } from "../src/backends/herdr.ts";
import { createHarness, toolResultText, until, type Harness, type Script } from "./fixtures/harness.ts";
import { ROOT_CALLER } from "../src/engine.ts";
import { SubagentAdapter } from "../../../src/subagents/adapter.ts";

type Status = "running" | "blocked" | "completed" | "failed" | "stopped";
interface PaneRun { agentId: string; runId: string; status: Status; text: string; runtime: "pi" | "claude-code" }
interface Ack { noticeId: string; rootHasNotice: boolean }

/** Fake transport only. Engine, adapter, tool dispatch, outbox and parent session are real. */
class FakeHerdr implements HerdrBackendHandle {
	readonly spawns: HerdrBackendRequest[] = [];
	readonly reads: { agentId: string; runId?: string; wait?: boolean }[] = [];
	readonly steering: { agentId: string; message: string }[] = [];
	readonly resumes: { agentId: string; prompt: string; runId: string }[] = [];
	readonly cancellations: string[] = [];
	readonly acknowledgements: Ack[] = [];
	readonly agents = new Map<string, PaneRun>();
	readonly runs = new Map<string, PaneRun>();
	private readonly listeners = new Set<(notice: HerdrBackendNotice) => void>();
	foreground: "completed" | "blocked" = "completed";
	readGate?: Promise<void>;
	spawnGate?: Promise<void>;
	autoCancel = true;
	completeBeforeSpawnReturns = false;
	child = false;
	rootHasNotice: () => boolean = () => false;
	private sequence = 0;

	async spawn(request: HerdrBackendRequest) {
		this.spawns.push(request);
		const agentId = `pane-${this.spawns.length}${request.machine ? `@${request.machine}` : ""}`;
		const run = this.begin(agentId, request.runtime ?? "pi");
		if (this.completeBeforeSpawnReturns) this.notice(agentId, "completed", "Early pane result");
		if (this.spawnGate) await this.spawnGate;
		return { agentId, runId: run.runId, text: "Herdr pane launched" };
	}
	async read(agentId: string, options: { runId?: string; wait?: boolean; signal?: AbortSignal }) {
		this.reads.push({ agentId, runId: options.runId, wait: options.wait });
		const run = options.runId ? this.runs.get(options.runId)! : this.agents.get(agentId)!;
		if (options.wait && run.status === "running") {
			await this.readGate;
			run.status = this.foreground;
			run.text = this.foreground === "blocked" ? "Approve this action in the Herdr pane" : "Pane report: inspected src/panes.ts";
		}
		return { status: run.status, phase: run.status, resultText: run.text, text: run.text, runId: run.runId };
	}
	async steer(agentId: string, message: string) {
		this.steering.push({ agentId, message });
		return { ok: true, message: "Queued by Herdr" };
	}
	async resume(agentId: string, prompt: string) {
		const run = this.begin(agentId, this.agents.get(agentId)!.runtime);
		this.resumes.push({ agentId, prompt, runId: run.runId });
		return { runId: run.runId, text: "Herdr pane resumed" };
	}
	async cancel(agentId: string) {
		this.cancellations.push(agentId);
		if (this.autoCancel) queueMicrotask(() => this.notice(agentId, "stopped", "Cancelled pane task"));
		return { acknowledged: false, message: "Cancellation requested" };
	}
	capabilities(agentId: string) {
		const pi = this.agents.get(agentId)?.runtime === "pi";
		return { liveDelivery: pi, maxTurns: pi, fork: false as const, sharedTasks: pi && !agentId.includes("@") };
	}
	onNotice(listener: (notice: HerdrBackendNotice) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	paneChild() { return this.child; }
	async acknowledge(noticeId: string) { this.acknowledgements.push({ noticeId, rootHasNotice: this.rootHasNotice() }); }
	notice(agentId: string, status: "completed" | "failed" | "stopped" = "completed", text = "Pane notice: found src/panes.ts") {
		const run = this.agents.get(agentId)!;
		run.status = status;
		run.text = text;
		const notice = { noticeId: `notice-${run.runId}`, agentId, runId: run.runId, phase: status, content: `Background agent ${status}: pane assignment\n\n${text}` };
		for (const listener of this.listeners) listener(notice);
		return notice;
	}
	private begin(agentId: string, runtime: PaneRun["runtime"]): PaneRun {
		const run: PaneRun = { agentId, runId: `herdr-run-${++this.sequence}`, status: "running", text: "Pane is running", runtime };
		this.agents.set(agentId, run);
		this.runs.set(run.runId, run);
		return run;
	}
}

function rootNotices(harness: Harness) {
	return harness.parent.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notification");
}
function firstProxy(harness: Harness) {
	const proxy = [...harness.engine.control.conversations.values()][0];
	assert(proxy, "Agent must create an engine proxy");
	return proxy;
}
async function setup(t: TestContext, parent: Script, options: { attach?: boolean; env?: Record<string, string>; paneDefault?: boolean; paneChild?: boolean; agentFiles?: Record<string, string> } = {}) {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const harness = await createHarness({ parent, panes: true, paneDefault: options.paneDefault, agentFiles: options.agentFiles, env: options.env, child: () => () => ({ text: "Unexpected in-process child" }) });
	const fake = new FakeHerdr();
	fake.child = options.paneChild === true;
	fake.rootHasNotice = () => rootNotices(harness).length > 0;
	const detach = options.attach === false ? () => {} : harness.engine.attachHerdr(new HerdrBackendAdapter(fake));
	t.after(async () => {
		fake.autoCancel = true;
		await harness.close();
		detach();
	});
	return { harness, fake };
}
const assignment = { backend: "pane", description: "Inspect pane code", prompt: "Inspect pane routing", name: "worker" };
const launchScript: Script = ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: assignment }] } : { text: "Parent useful work" };

test("background pane Agent settles from a Herdr notice, persists a root notice, then acknowledges Herdr", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, launchScript);
	await harness.parent.prompt("Use a pane agent", { source: "extension" });
	assert.equal(fake.spawns.length, 1);
	assert.equal(harness.children.size, 0);
	assert.equal(fake.spawns[0].runInBackground, true);
	assert.match(toolResultText(harness.parent, "Agent")[0], /Agent launched in the background/);
	const proxy = firstProxy(harness);
	assert.equal(proxy.meta.backend, "herdr");
	assert.equal(proxy.meta.herdr?.agentId, "pane-1");
	assert.equal(proxy.meta.herdr?.runId, "herdr-run-1");
	assert.deepEqual(fake.acknowledgements, []);
	const notice = fake.notice("pane-1");
	await until(() => !proxy.active && rootNotices(harness).length === 1 && fake.acknowledgements.length === 1);
	assert.equal(proxy.meta.runs[0].status, "completed");
	assert.match(proxy.meta.runs[0].resultText!, /found src\/panes.ts/);
	assert.match(JSON.stringify(rootNotices(harness)), /found src\/panes.ts/);
	assert.deepEqual(fake.acknowledgements, [{ noticeId: notice.noticeId, rootHasNotice: true }]);
	await until(() => harness.requests.parent >= 3);
});

test("foreground pane Agent waits on the captured Herdr run and returns its report", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { ...assignment, run_in_background: false } }] } : { text: "Parent consumed report" });
	let release!: () => void;
	fake.readGate = new Promise<void>((resolve) => { release = resolve; });
	const prompt = harness.parent.prompt("Use a foreground pane", { source: "extension" });
	await until(() => fake.reads.length === 1);
	assert.equal(toolResultText(harness.parent, "Agent").length, 0, "the tool result cannot precede the awaited pane report");
	assert.deepEqual(fake.reads[0], { agentId: "pane-1", runId: "herdr-run-1", wait: true });
	release();
	await prompt;
	assert.match(toolResultText(harness.parent, "Agent")[0], /inspected src\/panes.ts/);
	assert.equal(firstProxy(harness).meta.runs[0].status, "completed");
	assert.equal(harness.children.size, 0);
});

test("a blocked foreground pane returns promptly while retaining its active run", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { ...assignment, run_in_background: false } }] } : { text: "Parent continues while pane is blocked" });
	fake.foreground = "blocked";
	await harness.parent.prompt("Use a pane that requires approval", { source: "extension" });
	assert.match(toolResultText(harness.parent, "Agent")[0], /Approve this action in the Herdr pane/);
	assert(firstProxy(harness).active, "blocked is not a terminal outcome");
	assert.equal(firstProxy(harness).meta.runs[0].status, "running");
	assert.deepEqual(fake.cancellations, []);
});

test("SendMessage delivers work to a running Pi pane through the real adapter", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => {
		if (index === 0) return { tools: [{ name: "Agent", args: assignment }] };
		if (index === 1) return { tools: [{ name: "SendMessage", args: { to: "worker", message: "Also inspect pane tests" } }] };
		return { text: "Parent continues" };
	});
	await harness.parent.prompt("Launch and steer a Pi pane", { source: "extension" });
	assert.deepEqual(fake.steering, [{ agentId: "pane-1", message: "Also inspect pane tests" }]);
	assert.match(toolResultText(harness.parent, "SendMessage")[0], /Queued for the agent's next tool round/);
	assert.deepEqual(harness.engine.inbox(firstProxy(harness).meta.agentId).all().map((envelope) => envelope.state), ["included"]);
	assert.equal(fake.resumes.length, 0);
});

test("SendMessage refuses live delivery to a Claude Code pane without calling steer or resume", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => {
		if (index === 0) return { tools: [{ name: "Agent", args: { ...assignment, runtime: "claude-code" } }] };
		if (index === 1) return { tools: [{ name: "SendMessage", args: { to: "worker", message: "Change direction" } }] };
		return { text: "Live delivery is unavailable" };
	});
	await harness.parent.prompt("Launch and try to steer Claude Code", { source: "extension" });
	assert.equal(fake.spawns[0].runtime, "claude-code");
	assert.match(toolResultText(harness.parent, "SendMessage")[0], /does not support live delivery/);
	const result = harness.parent.messages.find((message) => message.role === "toolResult" && message.toolName === "SendMessage");
	assert(result?.role === "toolResult" && result.isError);
	assert.deepEqual(fake.steering, []);
	assert.deepEqual(fake.resumes, []);
	assert.deepEqual(harness.engine.inbox(firstProxy(harness).meta.agentId).all().map((envelope) => envelope.state), ["refused"]);
});

test("SendMessage resumes a finished pane with the same identity and a fresh Herdr/engine run", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => {
		if (index === 0) return { tools: [{ name: "Agent", args: { ...assignment, run_in_background: false } }] };
		if (index === 1) return { tools: [{ name: "SendMessage", args: { to: "worker", message: "Now inspect pane cleanup" } }] };
		return { text: "Parent waits for the resumed work" };
	});
	await harness.parent.prompt("Finish and continue the same pane", { source: "extension" });
	await until(() => fake.resumes.length === 1 && firstProxy(harness).meta.herdr?.runId === "herdr-run-2");
	assert.deepEqual(fake.resumes[0], { agentId: "pane-1", prompt: "Now inspect pane cleanup", runId: "herdr-run-2" });
	assert.equal(fake.spawns.length, 1);
	assert.equal(harness.engine.control.conversations.size, 1);
	const proxy = firstProxy(harness);
	assert.equal(proxy.meta.runs.length, 2);
	assert.notEqual(proxy.meta.runs[0].runId, proxy.meta.runs[1].runId);
	assert.equal(proxy.meta.runs[0].status, "completed");
	assert.equal(proxy.meta.runs[1].status, "running");
	fake.notice("pane-1", "completed", "Resumed pane report");
	await until(() => proxy.meta.runs[1].status === "completed");
	assert.match(proxy.meta.runs[1].resultText!, /Resumed pane report/);
});

test("TaskStop cancels the active pane, without pretending the cancellation request settled it", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => {
		if (index === 0) return { tools: [{ name: "Agent", args: assignment }] };
		if (index === 1) return { tools: [{ name: "TaskStop", args: { task_id: "worker" } }] };
		return { text: "Stop requested" };
	});
	fake.autoCancel = false;
	await harness.parent.prompt("Launch then stop the pane", { source: "extension" });
	assert.deepEqual(fake.cancellations, ["pane-1"]);
	assert.match(toolResultText(harness.parent, "TaskStop")[0], /Stopping/);
	const proxy = firstProxy(harness);
	assert(proxy.active?.cancelRequested);
	assert.equal(proxy.meta.runs[0].status, "running");
	fake.notice("pane-1", "stopped", "Pane acknowledged cancellation");
	await until(() => !proxy.active);
	assert.equal(proxy.meta.runs[0].status, "killed");
});

test("paneDefault runs a general-purpose Agent in a pane with the resolved model and effort", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { description: "Default pane", prompt: "Inspect pane routing" } }] } : { text: "Parent useful work" }, { paneDefault: true });
	await harness.parent.prompt("Delegate by default", { source: "extension" });
	assert.equal(fake.spawns.length, 1);
	assert.equal(harness.children.size, 0);
	const proxy = firstProxy(harness);
	assert.equal(proxy.meta.backend, "herdr");
	assert.equal(fake.spawns[0].model, proxy.meta.model?.effective);
	assert.equal(fake.spawns[0].thinking, proxy.meta.effort?.effective);
	assert.equal(fake.spawns[0].subagentType, "general-purpose");
	assert.match(fake.spawns[0].resolved?.instructions ?? "", /Complete the assigned scope yourself/);
	assert.equal(fake.spawns[0].resolved?.allowedTools, undefined, "an unrestricted definition keeps every pane tool");
});

test("paneDefault sends Explore's prompt and read-only tool surface to its pane", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { description: "Find code", prompt: "Locate pane routing", subagent_type: "Explore" } }] } : { text: "Parent useful work" }, { paneDefault: true });
	await harness.parent.prompt("Explore by default", { source: "extension" });
	assert.equal(fake.spawns.length, 1);
	const resolved = fake.spawns[0].resolved;
	assert.match(resolved?.instructions ?? "", /Locate code rather than reviewing/);
	assert.ok(resolved?.allowedTools?.includes("read"));
	for (const denied of ["edit", "write", "Agent"]) assert.ok(!resolved?.allowedTools?.includes(denied), `${denied} must stay denied in the pane`);
});

test("a pane keeps an isolated agent file's built-in restriction", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { ...assignment, subagent_type: "sealed" } }] } : { text: "Parent useful work" },
	{ agentFiles: { "sealed.md": "---\nname: sealed\ndescription: sealed\ntools: [read, Agent]\nisolated: true\n---\nStay sealed." } });
	await harness.parent.prompt("Pane for an isolated agent", { source: "extension" });
	assert.deepEqual(fake.spawns[0].resolved?.allowedTools, ["read"]);
});

test("a Claude Code pane falls back to the definition's native model and effort", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { ...assignment, backend: undefined, runtime: "claude-code", subagent_type: "native" } }] } : { text: "Parent useful work" },
	{ agentFiles: { "native.md": "---\nname: native\ndescription: native\nmodel: opus\neffort: high\n---\nReview." } });
	await harness.parent.prompt("Claude pane", { source: "extension" });
	assert.equal(fake.spawns[0].model, "opus");
	assert.equal(fake.spawns[0].thinking, "high");
});

test("a definition's turn limit reaches a Claude Code pane request, for the runner to refuse", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { ...assignment, backend: undefined, runtime: "claude-code", subagent_type: "bounded" } }] } : { text: "Parent useful work" },
	{ agentFiles: { "bounded.md": "---\nname: bounded\ndescription: bounded\nmax_turns: 2\n---\nReview." } });
	await harness.parent.prompt("Bounded Claude pane", { source: "extension" });
	assert.equal(fake.spawns[0].maxTurns, 2);
});

const keeper = { "keeper.md": "---\nname: keeper\ndescription: remembers\nmemory: project\n---\nKeep notes." };

test("an explicit pane is refused for a definition only an in-process child can apply", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { ...assignment, subagent_type: "keeper" } }] } : { text: "Refused" }, { agentFiles: keeper });
	await harness.parent.prompt("Pane with memory", { source: "extension" });
	assert.match(toolResultText(harness.parent, "Agent")[0], /cannot apply keeper's agent memory/);
	assert.equal(fake.spawns.length, 0);
	assert.equal(harness.engine.control.conversations.size, 0);
});

for (const [label, args, options] of [
	["agent memory", { subagent_type: "keeper" }, { agentFiles: keeper }],
	["backend: in-process", { backend: "in-process" }, {}],
	["no attached backend", {}, { attach: false }],
	["paneDefault off", {}, { paneDefault: false }],
	["a pane child's own launch", {}, { paneChild: true }],
] as const) test(`paneDefault keeps an Agent in-process for ${label}`, { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { description: "Stay in-process", prompt: "Look around", run_in_background: false, ...args } }] } : { text: "Parent done" },
	{ paneDefault: true, ...options });
	await harness.parent.prompt(`Delegate with ${label}`, { source: "extension" });
	assert.equal(fake.spawns.length, 0);
	assert.equal(harness.children.size, 1);
	assert.equal(firstProxy(harness).meta.backend, "in-process");
});

test("pane Agent is refused without an attached Herdr backend", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, launchScript, { attach: false });
	await harness.parent.prompt("Request an unavailable pane", { source: "extension" });
	assert.match(toolResultText(harness.parent, "Agent")[0], /Herdr panes are only available/);
	assert.equal(fake.spawns.length, 0);
	assert.equal(harness.engine.control.conversations.size, 0);
	assert.equal(harness.children.size, 0);
});

for (const [label, extra] of [
	["worktree isolation", { isolation: "worktree" }],
	["fork", { subagent_type: "fork" }],
] as const) test(`pane plus ${label} is refused before any launch or reservation`, { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, ({ index }) => index === 0
		? { tools: [{ name: "Agent", args: { ...assignment, ...extra } }] } : { text: "Combination refused" }, { env: { PI_SUBAGENT_FORK: "1" } });
	await harness.parent.prompt(`Request pane plus ${label}`, { source: "extension" });
	assert.match(toolResultText(harness.parent, "Agent")[0], /run in-process; omit backend\/machine\/runtime/);
	assert.equal(fake.spawns.length, 0);
	assert.equal(harness.engine.control.conversations.size, 0);
	assert.equal(harness.children.size, 0);
});

test("a completion arriving before spawn returns is retained until the engine proxy is associated", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, launchScript);
	fake.completeBeforeSpawnReturns = true;
	await harness.parent.prompt("Launch a fast pane", { source: "extension" });
	await until(() => fake.acknowledgements.length === 1);
	const proxy = firstProxy(harness);
	assert.equal(fake.agents.get("pane-1")?.status, "completed");
	assert.equal(proxy.meta.runs[0].status, "completed", "an early terminal notice must settle the engine run, not be acknowledged as an unrelated result");
	assert.equal(proxy.active, undefined);
	assert.match(proxy.meta.runs[0].resultText!, /Early pane result/);
});

test("Herdr notice remains unacknowledged while root delivery is paused by an open UI prompt", { timeout: 20_000 }, async (t) => {
	const { harness, fake } = await setup(t, launchScript);
	await harness.parent.prompt("Launch a pane before opening a dialog", { source: "extension" });
	harness.engine.notePrompt(true);
	fake.notice("pane-1");
	await until(() => !firstProxy(harness).active);
	// Let the async settlement/acknowledgement path finish before checking its
	// ordering; the root guard must keep both delivery and Herdr receipt pending.
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	assert.equal(rootNotices(harness).length, 0);
	const acknowledgedBeforeDelivery = [...fake.acknowledgements];
	harness.engine.notePrompt(false);
	await until(() => rootNotices(harness).length === 1 && fake.acknowledgements.length === 1);
	assert.deepEqual(acknowledgedBeforeDelivery, [], "Herdr must retain its notice until the root receives the result");
	assert.equal(fake.acknowledgements[0].rootHasNotice, true);
});

test("userStop during a pending pane spawn forwards cancellation as soon as the authoritative pane id arrives", { timeout: 20_000 }, async t => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	// Release before setup's teardown hook, including assertion-failure paths.
	t.after(() => release());
	const { harness, fake } = await setup(t, launchScript);
	fake.spawnGate = gate;
	const prompt = harness.parent.prompt("Launch a pane that is stopped during startup", { source: "extension" });
	await until(() => fake.spawns.length === 1);
	const proxy = firstProxy(harness);
	assert.ok(proxy.active);
	await harness.engine.userStop(proxy.meta.agentId);
	assert.equal(proxy.active?.cancelRequested, "user");
	assert.equal(proxy.meta.stoppedByUser, true);
	assert.deepEqual(fake.cancellations, [], "there is no authoritative pane id to cancel before spawn returns");
	release();
	await prompt;
	await until(() => fake.cancellations.length === 1 && !proxy.active);
	await harness.engine.teardown(proxy.meta.agentId);
	assert.deepEqual(fake.cancellations, ["pane-1"]);
	assert.equal(proxy.meta.herdr?.agentId, "pane-1");
	assert.equal(proxy.meta.runs[0].status, "killed");
	assert.equal(harness.engine.control.activeRuns(), 0);
	assert.equal(harness.children.size, 0);
});

test("a resumed pane emits the new run start and the real activity adapter follows that identity and result", { timeout: 20_000 }, async t => {
	const { harness, fake } = await setup(t, launchScript);
	const changes: { status: string; output: string; newRun: boolean }[] = [];
	const starts: { agentId: string; runId: string }[] = [];
	const adapter = new SubagentAdapter(harness.engine, (entry, newRun) => { changes.push({ status: entry.status, output: entry.output, newRun }); });
	const off = harness.engine.subscribe(event => {
		if (event.type === "run-event" && event.event.type === "started") starts.push({ agentId: event.agentId, runId: event.runId });
	});
	t.after(() => { off(); adapter.dispose(); });
	await harness.parent.prompt("Launch a pane for an activity regression", { source: "extension" });
	const proxy = firstProxy(harness), firstRun = proxy.active!.runId;
	assert.equal(adapter.identity(proxy.meta.agentId)?.runId, firstRun);
	fake.notice("pane-1", "completed", "First pane report");
	await until(() => !proxy.active && changes.at(-1)?.status === "completed");
	await harness.engine.teardown(proxy.meta.agentId);
	assert.match(changes.at(-1)!.output, /First pane report/);
	const beforeResume = changes.length;
	const receipt = await harness.engine.sendMessage({ to: proxy.meta.agentId, message: "Continue in the same pane" }, ROOT_CALLER, "activity-pane-resume");
	assert.equal(receipt.success, true);
	await until(() => fake.resumes.length === 1 && proxy.meta.herdr?.runId === "herdr-run-2" && adapter.identity(proxy.meta.agentId)?.runId === proxy.active?.runId);
	const secondRun = proxy.active!.runId;
	assert.notEqual(secondRun, firstRun);
	assert.ok(starts.some(event => event.agentId === proxy.meta.agentId && event.runId === secondRun), "the adapter receives a started event for the resumed engine run");
	assert.ok(changes.slice(beforeResume).some(entry => entry.newRun && entry.status === "running"));
	assert.equal(changes.at(-1)!.status, "running");
	assert.equal(changes.at(-1)!.output, "", "the old run's output is reset on new-run start");
	fake.notice("pane-1", "completed", "Second pane report");
	await until(() => !proxy.active && changes.at(-1)?.status === "completed");
	await harness.engine.teardown(proxy.meta.agentId);
	assert.equal(adapter.identity(proxy.meta.agentId)?.runId, secondRun);
	assert.match(changes.at(-1)!.output, /Second pane report/);
	assert.doesNotMatch(changes.at(-1)!.output, /First pane report/);
	assert.match(proxy.meta.runs[1].resultText!, /Second pane report/);
	assert.equal(fake.spawns.length, 1);
	assert.equal(fake.resumes.length, 1);
});
