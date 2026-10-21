import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InProcessBackend } from "../src/backends/in-process.ts";
import { Control } from "../src/control.ts";
import { builtInDefinitions } from "../src/definitions/builtins.ts";
import { ROOT_CALLER } from "../src/engine.ts";
import type { AgentMeta, NoticeRecord, RunOutcome, SendReceipt } from "../src/types.ts";
import { createHarness, scripted, until, type Harness } from "./fixtures/harness.ts";

function noNetwork(t: { mock: { method: Function } }): void {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in regression tests"); });
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
function outbox(harness: Harness): NoticeRecord[] {
	const file = join(harness.root, "agent", "subagents", harness.parent.sessionId, "outbox.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as NoticeRecord);
}
function gatedHook(harness: Harness, event: "SubagentStart" | "SubagentStop", output: object = {}) {
	const ready = join(harness.root, `${event}-ready`);
	const release = join(harness.root, `${event}-release`);
	const after = join(harness.root, `${event}-after`);
	mkdirSync(join(harness.root, "agent"), { recursive: true });
	writeFileSync(join(harness.root, "agent", "hooks.json"), JSON.stringify({
		[event]: [{ hooks: [{ type: "command", command: process.execPath, args: [
			fileURLToPath(new URL("./fixtures/hooks/gated.cjs", import.meta.url)), ready, release, after, JSON.stringify(output),
		] }] }],
	}));
	return { ready, after, release: () => writeFileSync(release, "go") };
}
function foregroundParent({ index }: { index: number }) {
	return index === 0
		? { tools: [{ name: "Agent", args: { description: "Find thing", prompt: "Look", run_in_background: false } }] }
		: { text: "Parent done" };
}
function meta(id: string, parent?: string): AgentMeta {
	return {
		agentId: id, agentType: "general-purpose", description: id, rootSessionId: "root",
		...(parent ? { parentAgentId: parent, ownerAgentId: parent } : {}), spawnDepth: parent ? 2 : 1,
		cwd: ".", sessionFile: `${id}.jsonl`, taskListId: "root", backend: "in-process",
		definition: builtInDefinitions({ forkEnabled: false })[0], stopGeneration: 0, runs: [],
	};
}
function failure(): RunOutcome {
	return {
		status: "failed", classification: "failed", resultText: "", error: "intermediate failed while its child is live",
		usage: { billable: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, latestFootprint: 0, liveMetric: 0, modelTransitions: [] },
		toolStats: { toolUses: 0, byTool: {} }, durationMs: 1,
	};
}

test("cancellation while child initialization is suspended never requests a provider or writes a file", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const root = mkdtempSync(join(tmpdir(), "engine-cancel-regression-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	let requests = 0;
	const forbidden = join(root, "AFTER_CANCEL.txt");
	const entered = deferred(), release = deferred();
	const backend = new InProcessBackend({ modelRuntime: runtime, onSessionCreated(session) {
		session.agent.streamFunction = scripted(({ index }) => index === 0
			? { tools: [{ name: "write", args: { path: forbidden, content: "must not execute" } }] }
			: { text: "done" }, count => { requests = count; }) as never;
	} });
	t.after(async () => { release.resolve(); await backend.disposeAll(); });
	const handle = backend.run({
		agentId: "atest", cwd: root, agentDir: join(root, "agent"), sessionFile: join(root, "session.jsonl"),
		model: getModel("anthropic", "claude-sonnet-4-5"), thinkingLevel: "off", projectTrusted: false,
		systemPrompt: { mode: "preamble", text: "Cancellation regression" }, noContextFiles: true,
		installers: [async () => { entered.resolve(); await release.promise; }], selectTools: () => ["write"], depth: 1,
	}, { runId: "rtest", prompt: "Write a file", background: true, stallTimeoutMs: 0 });
	await entered.promise;
	handle.cancel("user");
	release.resolve();
	const outcome = await handle.execution;
	await handle.started;
	assert.equal(outcome.status, "killed");
	assert.equal(outcome.killedBy, "user");
	assert.equal(requests, 0);
	assert.equal(existsSync(forbidden), false);
});

test("dynamically activating a denied tool does not authorize its execution", { timeout: 10_000 }, async t => {
	noNetwork(t);
	let activated = false;
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Reader", prompt: "Read", subagent_type: "reader", run_in_background: false } }] } : { text: "done" },
		agentFiles: { "reader.md": "---\nname: reader\ndescription: read only\ntools: [read]\ndisallowedTools: [write]\n---\nRead only." },
		child: (_id, session) => {
			session.subscribe(event => {
				if (event.type === "turn_end" && !activated) {
					session.setActiveToolsByName(["write"]);
					activated = session.getActiveToolNames().includes("write");
				}
			});
			return ({ index }) => index === 0
				? { tools: [{ name: "read", args: { path: join(harness.root, "data.txt") } }] }
				: index === 1 ? { tools: [{ name: "write", args: { path: join(harness.root, "FORBIDDEN.txt"), content: "must not execute" } }] }
				: { text: "done" };
		},
	});
	t.after(() => harness.close());
	writeFileSync(join(harness.root, "data.txt"), "ok");
	await harness.parent.prompt("Delegate", { source: "extension" });
	assert.equal(activated, true);
	const child = [...harness.children.values()][0];
	const denied = child.messages.find(message => message.role === "toolResult" && message.toolName === "write");
	assert.ok(denied && denied.role === "toolResult");
	assert.equal(denied.isError, true);
	assert.equal(existsSync(join(harness.root, "FORBIDDEN.txt")), false);
});

test("a budget-one child emitting unknown tools makes only one provider request", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Budget test", prompt: "Loop", subagent_type: "looper", run_in_background: false } }] } : { text: "done" },
		agentFiles: { "looper.md": "---\nname: looper\ndescription: loop\nmaxTurns: 1\ntools: [read]\n---\nRead only." },
		// The finite fallback keeps a broken budget implementation from hanging this test.
		child: () => ({ index }) => index < 3 ? { tools: [{ name: "nonexistent", args: {} }] } : { text: "should never request this" },
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	const id = [...harness.children.keys()][0];
	assert.equal(harness.requests.children.get(id), 1);
	assert.equal(harness.engine.control.get(id)!.meta.runs[0].classification, "partial-max-turns");
	assert.equal(harness.engine.control.get(id)!.meta.runs[0].status, "completed");
});

test("deleting a custom definition refuses continuation without another child request", { timeout: 10_000 }, async t => {
	noNetwork(t);
	let now = 10_000;
	const harness = await createHarness({
		now: () => now,
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Custom", prompt: "First", subagent_type: "custom", run_in_background: false } }] } : { text: "done" },
		child: () => () => ({ text: "report" }),
		agentFiles: { "custom.md": "---\nname: custom\ndescription: custom definition\n---\nDo work." },
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	const id = [...harness.children.keys()][0];
	const requests = harness.requests.children.get(id);
	rmSync(join(harness.root, "agent", "agents", "custom.md"));
	now += 2_001; // Expire discovery's cache without a wall-clock sleep.
	assert.equal((await harness.engine.definitions()).active.has("custom"), false);
	const receipt = await harness.engine.sendMessage({ to: id, message: "Continue after revocation" }, ROOT_CALLER, "revocation-check");
	assert.equal(receipt.success, false);
	assert.match(receipt.message, /no longer available/i);
	await nextTick();
	assert.equal(harness.requests.children.get(id), requests);
	assert.equal(harness.engine.control.get(id)!.meta.runs.length, 1);
	assert.equal(harness.engine.inbox(id).all()[0].state, "refused");
});

test("a permanently failing continuation stays pending instead of relaunching itself", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "initial report" }) });
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	const id = [...harness.children.keys()][0];
	const child = harness.children.get(id)!;
	let attempts = 0;
	t.mock.method(child, "prompt", async () => { attempts++; throw new Error("permanent prompt setup failure"); });
	// Safety fence only for a regression: let the assertion fail rather than spin forever.
	const unsubscribe = harness.engine.subscribe(event => {
		if (event.type === "settled" && event.agentId === id && attempts >= 3) void harness.engine.userStop(id);
	});
	t.after(unsubscribe);
	const receipt = await harness.engine.sendMessage({ to: id, message: "Retry this message" }, ROOT_CALLER, "poison");
	assert.equal(receipt.success, true);
	await until(() => outbox(harness).some(record => record.agentId === id && record.kind === "terminal_failure"));
	await nextTick();
	await nextTick();
	assert.equal(attempts, 1);
	assert.equal(harness.engine.control.get(id)!.meta.runs.length, 2);
	assert.equal(harness.engine.control.get(id)!.active, undefined);
	assert.equal(harness.engine.control.get(id)!.meta.runs.at(-1)!.status, "failed");
	assert.equal(harness.requests.children.get(id), 1, "failed continuation never contacts the provider");
	assert.equal(harness.engine.inbox(id).undelivered().length, 1, "accepted input remains durable for a later explicit retry");
});

test("user-stop traverses a finished intermediate and tombstones the running grandchild", () => {
	let sequence = 0;
	const persisted = new Map<string, AgentMeta>();
	const control = new Control({ maxConcurrent: 20, maxDepth: 3 }, {
		persist: value => { persisted.set(value.agentId, structuredClone(value)); }, inboxOf: () => ({ undelivered: () => [] }), newRunId: () => `r${++sequence}`,
	});
	const a = control.reserveSpawn({ meta: meta("A"), background: true });
	const b = control.reserveSpawn({ meta: meta("B", "A"), background: true });
	const c = control.reserveSpawn({ meta: { ...meta("C", "B"), spawnDepth: 3 }, background: true });
	assert.ok("runId" in a && "runId" in b && "runId" in c);
	control.finalize("B", b.runId, failure(), { text: "", truncated: false });
	assert.equal(control.get("B")!.active, undefined);
	assert.equal(control.get("B")!.disposition, "evictable");
	assert.ok(control.get("C")!.active);
	assert.deepEqual(control.requestStop("A", "user"), ["C", "A"]);
	assert.equal(control.get("C")!.active!.cancelRequested, "user");
	for (const id of ["A", "B", "C"]) {
		assert.equal(control.get(id)!.meta.stoppedByUser, true);
		assert.equal(control.get(id)!.meta.stopGeneration, 1);
		assert.equal(persisted.get(id)!.stoppedByUser, true);
	}
});

test("reserveSpawn persistence failure leaves no ghost record, binding or admission slot", () => {
	let sequence = 0;
	let fail = true;
	const control = new Control({ maxConcurrent: 1, maxDepth: 3 }, {
		persist: () => { if (fail) throw new Error("ENOSPC simulated"); }, inboxOf: () => ({ undelivered: () => [] }), newRunId: () => `r${++sequence}`,
	});
	const result = control.reserveSpawn({ meta: { ...meta("failed"), name: "worker" }, background: true });
	assert.ok("error" in result);
	assert.match(result.error, /ENOSPC/);
	assert.equal(control.activeRuns(), 0);
	assert.equal(control.conversations.size, 0);
	assert.equal(control.get("failed"), undefined);
	assert.equal(control.nameTaken("worker"), false);
	assert.equal(control.admissionError({ spawnDepth: 1 }), undefined);
	fail = false;
	assert.ok("runId" in control.reserveSpawn({ meta: { ...meta("replacement"), name: "worker" }, background: true }));
	assert.equal(control.activeRuns(), 1);
});

test("foreground Agent tool result attributes child usage to the parent's session totals", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	const result = harness.parent.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
	assert.ok(result && result.role === "toolResult");
	const id = [...harness.children.keys()][0];
	const childTokens = harness.engine.control.get(id)!.meta.runs[0].usage!.billable.totalTokens;
	assert.equal(childTokens, 11);
	assert.equal(result.usage?.totalTokens, childTokens);
	assert.equal(harness.parent.getSessionStats().tokens.total, harness.requests.parent * 11 + childTokens);
});

test("foreground completion creates only passive notices and never wakes another parent turn", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => outbox(harness).length > 0);
	await nextTick();
	const notices = outbox(harness);
	assert.ok(notices.length > 0, "foreground completion still records its passive report");
	assert.ok(notices.every(notice => notice.passive), "no transition ever creates an active foreground notice");
	assert.equal(harness.requests.parent, 2, "only the initial call and normal tool-result continuation query the parent");
});

function seedRepository(root: string): void {
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
		assert.equal(result.status, 0, result.stderr);
	};
	git("init", "-q");
	git("config", "user.name", "Regression Test");
	git("config", "user.email", "regression@example.invalid");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(root, "seed.txt"), "seed");
	git("add", "seed.txt");
	git("commit", "-qm", "seed");
}

test("a continuation requested at settlement cannot lose its active worktree to prior-run cleanup", { timeout: 15_000 }, async t => {
	noNetwork(t);
	const holdContinuation = deferred(), continuationStarted = deferred();
	let receipt: Promise<SendReceipt> | undefined;
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Isolated", prompt: "Answer", isolation: "worktree", run_in_background: false } }] } : { text: "done" },
		child: () => ({ index }) => {
			if (index === 0) return { text: "initial report" };
			continuationStarted.resolve();
			return { wait: holdContinuation.promise, then: { text: "continued report" } };
		},
	});
	seedRepository(harness.root);
	const off = harness.engine.subscribe(event => {
		if (event.type === "settled" && event.outcome.status === "completed" && !receipt) {
			receipt = harness.engine.sendMessage({ to: event.agentId, message: "Continue immediately" }, ROOT_CALLER, "worktree-cleanup-race");
		}
	});
	t.after(async () => { off(); holdContinuation.resolve(); await harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	await continuationStarted.promise;
	assert.ok(receipt);
	assert.equal((await receipt).success, true);
	const id = [...harness.children.keys()][0];
	// The first notice is emitted only after that run's worktree cleanup finishes.
	await until(() => outbox(harness).some(notice => notice.agentId === id));
	const conversation = harness.engine.control.get(id)!;
	assert.equal(conversation.meta.runs.length, 2);
	assert.ok(conversation.active);
	assert.equal(conversation.active.runId, conversation.meta.runs[1].runId);
	assert.equal(conversation.meta.worktreeCleanlyRemoved, false);
	assert.equal(existsSync(conversation.meta.cwd), true);
	assert.equal(readFileSync(join(conversation.meta.cwd, "seed.txt"), "utf8"), "seed");
	await harness.engine.userStop(id);
	await until(() => !conversation.active);
	await conversation.exiting;
});

test("user-stop during SubagentStart survives setup and prevents session creation and model writes", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({
		parent: foregroundParent,
		child: () => ({ index }) => index === 0 ? { tools: [{ name: "write", args: { path: join(harness.root, "MODEL_AFTER_STOP"), content: "forbidden" } }] } : { text: "done" },
	});
	const hook = gatedHook(harness, "SubagentStart");
	t.after(async () => { hook.release(); await harness.close(); });
	const prompt = harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => existsSync(hook.ready));
	const id = [...harness.engine.control.conversations.keys()][0];
	assert.equal(harness.children.size, 0, "start hook still holds setup before child creation");
	await harness.engine.userStop(id);
	hook.release();
	await prompt;
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	assert.equal(harness.requests.children.get(id) ?? 0, 0);
	assert.equal(harness.children.has(id), false);
	assert.equal(existsSync(join(harness.root, "MODEL_AFTER_STOP")), false);
	assert.equal(conversation.meta.runs[0].status, "killed");
	assert.equal(conversation.meta.runs[0].killedBy, "user");
});

test("shutdown after root detachment still cancels and drains its streaming child", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const hold = deferred();
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Running", prompt: "Wait" } }] } : { text: "done" },
		child: () => () => ({ wait: hold.promise, then: { text: "released" } }),
	});
	t.after(async () => { hold.resolve(); await harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	const id = [...harness.children.keys()][0];
	await until(() => harness.requests.children.get(id) === 1);
	assert.equal(harness.children.get(id)!.isStreaming, true);
	harness.engine.detachRoot();
	await harness.engine.shutdownRoot("quit");
	assert.equal(harness.engine.control.activeRuns(), 0);
	assert.equal(harness.engine.control.get(id)!.active, undefined);
	assert.equal(harness.children.get(id)!.isStreaming, false);
	assert.equal(harness.engine.control.get(id)!.meta.runs[0].status, "killed");
	assert.equal(harness.engine.control.get(id)!.meta.runs[0].killedBy, "session-end");
});

test("queued steering at a one-turn final answer continues in a new run, never an extra turn", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const firstAnswer = deferred();
	const requestRuns: (string | undefined)[] = [];
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "One turn", prompt: "Wait", subagent_type: "one" } }] } : { text: "done" },
		agentFiles: { "one.md": "---\nname: one\ndescription: one turn\nmaxTurns: 1\n---\nWork." },
		child: id => ({ index }) => {
			requestRuns.push(harness.engine.control.get(id)?.active?.runId);
			return index === 0 ? { wait: firstAnswer.promise, then: { text: "first final answer" } } : { text: "second final answer" };
		},
	});
	t.after(async () => { firstAnswer.resolve(); await harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	const id = [...harness.children.keys()][0];
	await until(() => requestRuns.length === 1);
	const receipt = await harness.engine.sendMessage({ to: id, message: "Also do another thing" }, ROOT_CALLER, "queued-at-turn-limit");
	assert.equal(receipt.success, true);
	firstAnswer.resolve();
	const conversation = harness.engine.control.get(id)!;
	await until(() => conversation.meta.runs.length >= 2 && !conversation.active);
	await conversation.exiting;
	assert.equal(harness.requests.children.get(id), 2);
	assert.equal(conversation.meta.runs.length, 2);
	assert.deepEqual(conversation.meta.runs.map(run => run.classification), ["partial-max-turns", "completed"]);
	assert.deepEqual(requestRuns, conversation.meta.runs.map(run => run.runId));
	assert.equal(conversation.meta.runs[0].resultText, "first final answer");
	assert.equal(conversation.meta.runs[1].resultText, "second final answer");
	assert.equal(harness.engine.inbox(id).undelivered().length, 0);
});

test("an automatically reserved continuation revalidates a definition revoked during settlement", { timeout: 10_000 }, async t => {
	noNetwork(t);
	let now = 10_000;
	const harness = await createHarness({
		now: () => now,
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Custom", prompt: "Answer", subagent_type: "custom" } }] } : { text: "done" },
		agentFiles: { "custom.md": "---\nname: custom\ndescription: custom\n---\nWork." },
		child: () => ({ index }) => ({ text: `answer ${index}` }),
	});
	const hook = gatedHook(harness, "SubagentStop", { continue: false });
	t.after(async () => { hook.release(); await harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => existsSync(hook.ready));
	const id = [...harness.children.keys()][0];
	const receipt = await harness.engine.sendMessage({ to: id, message: "Continue after settlement" }, ROOT_CALLER, "automatic-revocation");
	assert.equal(receipt.success, true, "input was accepted while the original run was still live");
	rmSync(join(harness.root, "agent", "agents", "custom.md"));
	now += 2_001;
	assert.equal((await harness.engine.definitions()).active.has("custom"), false);
	hook.release();
	const conversation = harness.engine.control.get(id)!;
	await until(() => conversation.meta.runs.length >= 2 && !conversation.active);
	await conversation.exiting;
	assert.equal(conversation.meta.runs.length, 2);
	assert.equal(conversation.meta.runs[1].status, "failed");
	assert.ok(outbox(harness).some(notice => notice.runId === conversation.meta.runs[1].runId && /no longer available/i.test(notice.payload.failure ?? "")));
	assert.equal(harness.requests.children.get(id), 1, "the refused automatic run never contacts its model");
	assert.equal(harness.engine.inbox(id).all().length, 1);
	assert.equal(harness.engine.inbox(id).all()[0].state, "refused");
});

test("user-stop cancels a live SubagentStop process even after Pi's stream signal ends", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Stop hook", prompt: "Answer" } }] } : { text: "done" },
		child: () => () => ({ text: "answer" }),
	});
	const hook = gatedHook(harness, "SubagentStop");
	t.after(async () => { hook.release(); await harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => existsSync(hook.ready));
	const id = [...harness.children.keys()][0];
	assert.equal(harness.children.get(id)!.agent.signal, undefined, "the hook runs after the model signal's lifetime");
	await harness.engine.userStop(id);
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	// Release only after cancellation has drained: a surviving hook would now write its marker.
	hook.release();
	await nextTick();
	assert.equal(existsSync(hook.after), false);
	assert.equal(harness.requests.children.get(id), 1);
	assert.equal(conversation.meta.runs[0].status, "killed");
	assert.equal(conversation.meta.runs[0].killedBy, "user");
});

test("failed foreground Agent results still bill all child usage exactly once", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({
		parent: foregroundParent,
		child: (_id, session) => {
			session.settingsManager.applyOverrides({ retry: { enabled: false } });
			return ({ index }) => index === 0 ? { tools: [{ name: "read", args: { path: join(harness.root, "seed.txt") } }] } : { error: "invalid_request_error: request failed" };
		},
	});
	t.after(() => harness.close());
	writeFileSync(join(harness.root, "seed.txt"), "seed");
	await harness.parent.prompt("Delegate", { source: "extension" });
	const id = [...harness.children.keys()][0];
	const result = harness.parent.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
	assert.ok(result && result.role === "toolResult");
	assert.equal(result.isError, true);
	assert.equal(harness.requests.children.get(id), 2);
	const summary = harness.engine.control.get(id)!.meta.runs[0];
	assert.equal(summary.status, "failed");
	assert.equal(summary.usage!.billable.totalTokens, 22);
	assert.equal(result.usage?.totalTokens, 22);
	assert.equal(harness.parent.getSessionStats().tokens.total, harness.requests.parent * 11 + 22);
	const before = harness.parent.getSessionStats().tokens.total;
	await harness.engine.readResult(id, ROOT_CALLER, {});
	await harness.engine.readResult(id, ROOT_CALLER, {});
	assert.equal(harness.parent.getSessionStats().tokens.total, before, "result reads do not charge child usage again");
});

test("a nested foreground child's passive notice never queues input or relaunches its owner", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const ids: string[] = [];
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Owner", prompt: "Call child", subagent_type: "owner", run_in_background: false } }] } : { text: "done" },
		agentFiles: { "owner.md": "---\nname: owner\ndescription: owner\nmaxTurns: 1\n---\nWork." },
		child: id => {
			ids.push(id);
			return ({ index }) => id === ids[0] && index === 0 ? { tools: [{ name: "Agent", args: { description: "Nested", prompt: "Answer", run_in_background: false } }] } : { text: "done" };
		},
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	assert.equal(ids.length, 2);
	const owner = harness.engine.control.get(ids[0])!;
	await until(() => !owner.active && outbox(harness).some(notice => notice.agentId === ids[1]));
	await owner.exiting;
	await nextTick();
	const childNotices = outbox(harness).filter(notice => notice.agentId === ids[1]);
	assert.ok(childNotices.length > 0);
	assert.ok(childNotices.every(notice => notice.passive));
	assert.equal(harness.engine.inbox(ids[0]).all().length, 0);
	assert.equal(harness.requests.children.get(ids[0]), 1);
	assert.equal(owner.meta.runs.length, 1);
	assert.equal(owner.meta.runs[0].classification, "partial-max-turns");
	assert.equal(owner.active, undefined);
});

test("a nested conversation fork inherits its immediate owner's effort rather than the root's", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const ids: string[] = [];
	const harness = await createHarness({
		env: { PI_SUBAGENT_FORK: "1" },
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Owner", prompt: "Fork", subagent_type: "owner", run_in_background: false } }] } : { text: "done" },
		agentFiles: { "owner.md": "---\nname: owner\ndescription: owner\neffort: low\n---\nWork." },
		child: id => {
			ids.push(id);
			return ({ index }) => id === ids[0] && index === 0 ? { tools: [{ name: "Agent", args: { description: "Fork", prompt: "Answer", subagent_type: "fork", run_in_background: false } }] } : { text: "done" };
		},
	});
	t.after(() => harness.close());
	harness.parent.setThinkingLevel("high");
	await harness.parent.prompt("Delegate", { source: "extension" });
	assert.equal(ids.length, 2);
	assert.equal(harness.parent.thinkingLevel, "high");
	assert.equal(harness.children.get(ids[0])!.thinkingLevel, "low");
	assert.equal(harness.children.get(ids[1])!.thinkingLevel, "low");
	assert.equal(harness.engine.control.get(ids[1])!.meta.isFork, true);
	assert.equal(harness.engine.control.get(ids[1])!.meta.effort!.effective, "low");
});

test("root shutdown waits for a settled run's teardown fence before returning", { timeout: 15_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Isolated", prompt: "Fail", isolation: "worktree", run_in_background: false } }] } : { text: "done" },
		child: (_id, session) => {
			session.settingsManager.applyOverrides({ retry: { enabled: false } });
			return () => ({ error: "invalid_request_error: request failed" });
		},
	});
	seedRepository(harness.root);
	// Hold genuine post-settlement teardown in its interrupted-stop fallback.
	// Unlike relying on Git's speed, this guarantees shutdown encounters a live fence.
	const hook = gatedHook(harness, "SubagentStop");
	t.after(async () => { hook.release(); await harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => existsSync(hook.ready));
	const id = [...harness.children.keys()][0];
	const conversation = harness.engine.control.get(id)!;
	assert.equal(conversation.active, undefined);
	assert.ok(conversation.exiting);
	assert.equal(existsSync(conversation.meta.cwd), true);
	let teardownFinished = false, shutdownReturned = false;
	void conversation.exiting.then(() => { teardownFinished = true; });
	const shuttingDown = harness.engine.shutdownRoot("quit").then(() => { shutdownReturned = true; });
	await nextTick();
	assert.equal(shutdownReturned, false, "shutdown must wait even though the provider run has already settled");
	assert.equal(teardownFinished, false);
	hook.release();
	await shuttingDown;
	assert.equal(teardownFinished, true);
	assert.equal(existsSync(hook.after), true);
	assert.equal(conversation.meta.worktreeCleanlyRemoved, true);
	assert.equal(existsSync(conversation.meta.cwd), false);
	assert.equal(harness.engine.control.activeRuns(), 0);
});

test("caller abort during session initialization is not lost before the foreground abort listener attaches", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const controller = new AbortController();
	let initialized = false;
	const harness = await createHarness({
		parent: () => ({ text: "unused" }),
		child: () => {
			initialized = true;
			controller.abort();
			return ({ index }) => index === 0 ? { tools: [{ name: "write", args: { path: join(harness.root, "AFTER_INIT_ABORT.txt"), content: "forbidden" } }] } : { text: "done" };
		},
	});
	t.after(() => harness.close());
	const result = await harness.engine.spawn({ description: "Abort initialization", prompt: "Write", run_in_background: false }, ROOT_CALLER, {
		toolCallId: "abort-during-init", ctx: harness.parent.extensionRunner.createContext(), signal: controller.signal,
	});
	assert.equal(initialized, true);
	assert.equal(controller.signal.aborted, true);
	assert.equal((result.details as { status: string }).status, "killed");
	const conversation = [...harness.engine.control.conversations.values()][0];
	await harness.engine.teardown(conversation.meta.agentId);
	assert.equal(conversation.active, undefined);
	assert.equal(conversation.meta.runs[0].status, "killed");
	assert.equal(existsSync(join(harness.root, "AFTER_INIT_ABORT.txt")), false);
});

test("concurrent resumes of one workflow run admit exactly one new task", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const hold = deferred(), childStarted = deferred();
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" }, parent: () => ({ text: "done" }),
		child: () => () => { childStarted.resolve(); return { wait: hold.promise, then: { text: "continued" } }; },
	});
	t.after(async () => { hold.resolve(); await harness.close(); });
	const manager = harness.engine.workflows(), ctx = harness.parent.extensionRunner.createContext();
	const script = (body: string) => `export const meta={name:'resume-race',description:'Regression'}; ${body}`;
	const first = await manager.launch({ script: script("return 1;") }, ctx);
	assert.notEqual(first.isError, true, first.text);
	const receipt = first.details as { runId: string; taskId: string };
	await until(() => outbox(harness).some(notice => notice.agentId === receipt.taskId));
	const input = { script: script("return await agent('Hold the accepted resume');"), resumeFromRunId: receipt.runId };
	const resumed = await Promise.all([manager.launch(input, ctx), manager.launch(input, ctx)]);
	const accepted = resumed.filter(result => !result.isError), refused = resumed.filter(result => result.isError);
	assert.equal(accepted.length, 1);
	assert.equal(refused.length, 1);
	assert.match(refused[0].text, /already being resumed|still running|still active/i);
	const next = accepted[0].details as { runId: string; taskId: string };
	assert.equal(next.runId, receipt.runId);
	assert.notEqual(next.taskId, receipt.taskId);
	assert.equal(manager.has(next.taskId), true);
	await childStarted.promise;
	assert.equal(harness.children.size, 1);
	assert.equal(harness.engine.control.activeRuns(), 1);
});

test("workflow Bash clamp decodes exact and prefix rules before authorizing real shell calls", { timeout: 15_000 }, async t => {
	noNetwork(t);
	const commands = ["pwd", "git status --short", "git log --oneline", "pwd -P", "printf forbidden > CLAMP_FORBIDDEN.txt"];
	const script = "export const meta={name:'clamp',description:'Clamp regression'}; return await agent('Exercise shell rules',{bashCommandClamp:['Bash(pwd)','Bash(git status:*)']});";
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" },
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Workflow", args: { script } }] } : { text: "done" },
		child: () => ({ index }) => index === 0 ? { tools: commands.map(command => ({ name: "bash", args: { command } })) } : { text: "shell checks finished" },
	});
	t.after(() => harness.close());
	seedRepository(harness.root);
	await harness.parent.prompt("Run the clamped shell workflow", { source: "extension" });
	await until(() => [...harness.children.values()].some(child => child.messages.filter(message => message.role === "toolResult" && message.toolName === "bash").length === commands.length));
	const child = [...harness.children.values()][0];
	const results = child.messages.filter(message => message.role === "toolResult" && message.toolName === "bash");
	assert.equal(results.length, commands.length);
	for (const [index, result] of results.entries()) {
		assert.ok(result.role === "toolResult");
		assert.equal(result.isError, index >= 2, `${commands[index]}: ${JSON.stringify(result.content)}`);
		if (index >= 2) assert.match(JSON.stringify(result.content), /Only these commands are allowed/);
	}
	assert.equal(existsSync(join(harness.root, "CLAMP_FORBIDDEN.txt")), false);
	await until(() => harness.engine.control.activeRuns() === 0);
});

test("interactive /skill:name without arguments launches the fresh skill agent instead of rejecting its empty invocation prompt", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const hold = deferred();
	const harness = await createHarness({ parent: () => ({ text: "done" }), child: () => () => ({ wait: hold.promise, then: { text: "skill completed" } }) });
	t.after(async () => { hold.resolve(); await harness.close(); });
	const dir = join(harness.root, "agent", "skills", "reviewskill");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: reviewskill\ndescription: Skill regression\ncontext: fork\ndisable-model-invocation: true\n---\nPerform the no-argument skill task.\n");
	assert.ok(harness.engine.userForkSkill("reviewskill"));
	const result = await harness.parent.extensionRunner.emitInput("/skill:reviewskill", undefined, "interactive");
	assert.equal(result.action, "handled");
	await until(() => harness.children.size === 1 && [...harness.requests.children.values()][0] === 1);
	const conversation = [...harness.engine.control.conversations.values()][0];
	assert.equal(conversation.meta.skill?.name, "reviewskill");
	assert.equal(conversation.meta.isFork, undefined, "a skill-scoped child is not a conversation-history fork");
	assert.equal(conversation.meta.runs[0].status, "running");
	assert.match(JSON.stringify([...harness.children.values()][0].messages), /Perform the no-argument skill task/);
	assert.equal(harness.requests.parent, 0, "the handled command launches the child without querying the root model");
	hold.resolve();
	await until(() => !conversation.active);
	assert.equal(conversation.meta.runs[0].status, "completed");
});
