import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { parseAgentFile } from "../src/herdr/agent-file.ts";
import { createHerdrCli, agentsFromList, paneIdFromSplit, splitDirection, tabFromCreate, type HerdrClient } from "../src/herdr/client.ts";
import { createChildSession, type ChildMessenger, type ChildIdentity } from "../src/herdr/child.ts";
import { createHerdrSubagents } from "../src/herdr/extension.ts";
import { HerdrRunner, completionNotice, herdrAgentName, needsNewTab, readHerdrAgent, spawnHerdrAgent, type SpawnRequest } from "../src/herdr/runner.ts";
import { HerdrStore, type HerdrTask } from "../src/herdr/store.ts";
import { isTerminal, type RunRef, type ExecutionEvent } from "../src/herdr/state.ts";
import { selectSubagentRuntime } from "../src/subagents/runtime.ts";
import { loadSubagentExtension } from "../integrations/subagents.ts";

function request(extra: Partial<SpawnRequest> = {}): SpawnRequest {
	return { prompt: "Find the launch path", description: "Find launch path", subagentType: "Explore", runInBackground: true, cwd: "/work", paneId: "w1:p1", tabId: "w1:t1", ...extra };
}

function fakeClient(partial: Partial<HerdrClient> = {}) {
	const events: string[] = [];
	const live = new Map<string, { paneId: string; tabId: string }>();
	const tabs = new Map<string, string>();
	let sequence = 2;
	const client: HerdrClient = {
		layout: async () => ({ columns: 120, rows: 40 }),
		split: async (options) => {
			events.push(`split:${options.direction}`);
			const paneId = `w1:p${sequence++}`;
			tabs.set(paneId, "w1:t1");
			return { paneId };
		},
		startPi: async (options) => {
			events.push(`start:${options.name}`);
			live.set(options.name, { paneId: options.paneId, tabId: tabs.get(options.paneId) ?? "w1:t1" });
		},
		closePane: async (paneId) => {
			events.push(`close:${paneId}`);
			for (const [name, value] of live) if (value.paneId === paneId) live.delete(name);
		},
		isAlive: async (name) => live.has(name),
		showLabel: async (paneId, label) => { events.push(`label:${paneId}:${label}`); },
		listAgents: async () => [{ paneId: "w1:p1", tabId: "w1:t1" }, ...[...live].map(([name, value]) => ({ name, ...value }))],
		createTab: async () => {
			events.push("tab");
			const paneId = `w1:p${sequence++}`;
			const tabId = `w1:t${sequence++}`;
			tabs.set(paneId, tabId);
			return { tabId, paneId };
		},
		...partial,
	};
	return { client, events, live };
}

function fixture(t: TestContext, partial: Partial<HerdrClient> = {}) {
	const root = mkdtempSync(join(tmpdir(), "herdr-v2-"));
	const fake = fakeClient(partial);
	let clock = Date.now();
	const runner = new HerdrRunner({ root, client: fake.client, now: () => clock });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	return { root, runner, ...fake, advance: (ms: number) => { clock += ms; } };
}

async function attach(runner: HerdrRunner, ref: RunRef, options: { streaming?: boolean; checkpoint?: ChildIdentity["checkpoint"] } = {}) {
	const record = await runner.resolve(ref.agentId);
	const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id as string;
	let streaming = options.streaming ?? false;
	let output = "";
	let aborted = 0;
	let checkpoint: ChildIdentity["checkpoint"] = options.checkpoint;
	const sent: { text: string; deliverAs?: string }[] = [];
	const messenger: ChildMessenger = {
		sendUserMessage(text, delivery) { sent.push({ text, deliverAs: delivery?.deliverAs }); },
		abort() { aborted++; },
		assistantText: () => output,
		streaming: () => streaming,
		clearAssistant() { output = ""; },
		checkpoint(run, event) { checkpoint = { ref: run, event }; },
	};
	const identity = { sessionFile: record.sessionFile, sessionId, checkpoint };
	const child = (await createChildSession(runner.store, record.paneId, identity, messenger))!;
	assert.ok(child);
	return {
		child, messenger, identity, sent,
		aborted: () => aborted,
		checkpoint: () => checkpoint,
		setStreaming(value: boolean) { streaming = value; },
		async start() {
			await child.poll();
			const message = sent.at(-1)!;
			assert.equal((await child.input(message.text))?.action, "transform");
			streaming = true;
			await child.noteLive();
			await child.poll();
		},
		async finish(result = "Launch is in src/main.ts", outcome: "completed" | "aborted" | "error" = "completed") {
			output = result;
			streaming = false;
			await child.noteSettled(outcome);
		},
	};
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function eventually(predicate: () => Promise<boolean>, message = "condition did not become true") {
	for (let count = 0; count < 200; count++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

test("Herdr selects the pane runner; other sessions retain Pi Subagents", async () => {
	assert.equal(selectSubagentRuntime({ HERDR_ENV: "1" }), "herdr");
	assert.equal(selectSubagentRuntime({}), "pi-subagents");
	const loaded: string[] = [];
	const pi = { registerTool() {} } as unknown as ExtensionAPI;
	const factory = (name: string): ExtensionFactory => () => { loaded.push(name); };
	await loadSubagentExtension(pi, { HERDR_ENV: "1" }, { herdr: factory("herdr"), current: factory("current") }, false);
	await loadSubagentExtension(pi, {}, { herdr: factory("herdr"), current: factory("current") }, false);
	assert.deepEqual(loaded, ["herdr", "current"]);
});

test("spawn publishes only after Pi starts and returns both identities", async (t) => {
	const f = fixture(t);
	const original = f.client.startPi;
	f.client.startPi = async (options) => {
		const record = await f.runner.resolve(options.name);
		const ref = { agentId: record.id, runId: record.currentRunId };
		assert.equal((await f.runner.read(ref)).deadline, 0);
		assert.ok(options.args.includes(record.sessionFile));
		assert.equal((await f.runner.store.launches())[0].stage, "starting-pi");
		await original(options);
	};
	const result = await spawnHerdrAgent(request(), { ...f, runner: f.runner });
	assert.match(result.text, /Agent ID: explore/);
	assert.match(result.text, /Run ID:/);
	assert.deepEqual(f.events, ["split:right", "start:explore", "label:w1:p2:explore"]);
	const ref = { agentId: String(result.details.agentId), runId: String(result.details.runId) };
	assert.equal((await f.runner.read(ref)).phase, "queued");
	assert.equal((await f.runner.store.launches())[0].stage, "published");
});

test("child holds steering durably, accepts the task, and preserves the final result", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	await f.runner.steer(ref, "Look at main only");
	const c = await attach(f.runner, ref);
	assert.equal(c.sent.length, 0);
	await c.start();
	assert.match(c.sent[0].text, /You are a subagent/);
	assert.equal(c.sent[1].deliverAs, "steer");
	assert.match(c.sent[1].text, /Look at main only/);
	assert.equal((await f.runner.read(ref)).accepted, true);
	await c.finish();
	assert.equal((await f.runner.wait(ref)).result, "Launch is in src/main.ts");
	await c.child.noteSettled("error");
	assert.equal((await f.runner.read(ref)).phase, "completed");
});

test("held steering survives reload before prompt dispatch", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	await f.runner.steer(ref, "Hold this across reload");
	const before = await attach(f.runner, ref);
	await before.child.dispose();
	const after = await attach(f.runner, ref);
	await after.start();
	assert.equal(after.sent.length, 2);
	assert.match(after.sent[1].text, /Hold this across reload/);
});

test("new session in a retained pane does not inherit the review allow-list", async (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, "agents"));
	writeFileSync(join(f.root, "agents", "Explore.md"), "---\ntools: read, grep\n---\nRead only.");
	const ref = await f.runner.spawn(request({ agentDir: f.root }));
	const c = await attach(f.runner, ref);
	assert.equal(c.child.allows("write"), false);
	assert.equal(c.child.allows("read"), true);
	const record = await f.runner.resolve(ref.agentId);
	assert.equal(await createChildSession(f.runner.store, record.paneId, { sessionFile: "/new/session.jsonl", sessionId: "new" }, c.messenger), undefined);
	assert.equal(await createChildSession(f.runner.store, record.paneId, { sessionFile: record.sessionFile, sessionId: "new" }, c.messenger), undefined);
});

test("an ambiguous dispatched prompt is interrupted on reload and never replayed", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const record = await f.runner.resolve(ref.agentId);
	const binding = (await f.runner.store.attach(record.paneId, record.sessionFile, "session"))!;
	assert.ok(await f.runner.store.claimNextCommand(ref.agentId, binding.token, false));
	const sent: string[] = [];
	const child = await createChildSession(f.runner.store, record.paneId, { sessionFile: record.sessionFile, sessionId: "session" }, {
		sendUserMessage(text) { sent.push(text); }, abort() {}, assistantText: () => "", streaming: () => false, clearAssistant() {},
	});
	await child!.poll();
	assert.deepEqual(sent, []);
	assert.equal((await f.runner.read(ref)).phase, "failed");
	assert.match((await f.runner.read(ref)).error!, /will not be replayed/);
});

test("reload after sending but before acceptance also reports interruption", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const before = await attach(f.runner, ref);
	await before.child.poll();
	await before.child.dispose();
	const after = await attach(f.runner, ref);
	await after.child.poll();
	assert.equal(after.sent.length, 0);
	assert.equal((await f.runner.read(ref)).phase, "failed");
});

test("live reload reattaches but fences late callbacks from the old child", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const before = await attach(f.runner, ref);
	await before.start();
	const after = await attach(f.runner, ref, { streaming: true });
	await before.finish("stale");
	assert.equal((await f.runner.read(ref)).phase, "running");
	await after.finish("current");
	assert.equal((await f.runner.read(ref)).result, "current");
});

test("durable Pi completion checkpoint repairs interrupted SQLite completion", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const before = await attach(f.runner, ref);
	await before.start();
	await before.child.dispose();
	const event: ExecutionEvent = { type: "completed", result: "persisted in Pi" };
	const after = await attach(f.runner, ref, { checkpoint: { ref, event } });
	await after.child.poll();
	assert.equal((await f.runner.read(ref)).result, "persisted in Pi");
	assert.equal(after.sent.length, 0);
});

test("concurrent resumes have one winner and never overwrite the old run", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	await c.finish("first result");
	const secondRunner = new HerdrRunner({ root: f.root, client: f.client });
	try {
		const attempts = await Promise.allSettled([
			f.runner.resume(ref.agentId, "follow-up one"), secondRunner.resume(ref.agentId, "follow-up two"),
		]);
		assert.equal(attempts.filter((value) => value.status === "fulfilled").length, 1);
		assert.equal((await f.runner.read(ref)).result, "first result");
		const record = await f.runner.resolve(ref.agentId);
		assert.notEqual(record.currentRunId, ref.runId);
		await f.runner.cancel(ref);
		assert.equal((await f.runner.read({ agentId: record.id, runId: record.currentRunId })).cancelRequested, false);
	} finally { await secondRunner.close(); }
});

test("old waiters retain their run across completion and a fast resume", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	const sleeping = deferred();
	const wake = deferred();
	const observer = new HerdrRunner({ root: f.root, client: f.client, sleep: async () => { sleeping.resolve(); await wake.promise; } });
	try {
		const waiting = observer.wait(ref);
		await sleeping.promise;
		await c.finish("old result");
		const next = await f.runner.resume(ref.agentId, "continue");
		await c.start();
		await c.finish("new result");
		wake.resolve();
		assert.equal((await waiting).result, "old result");
		assert.equal((await f.runner.read(next)).result, "new result");
	} finally { wake.resolve(); await observer.close(); }
});

test("wait cancellation is read-only; tool cancellation explicitly targets its captured run", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(f.runner.wait(ref, controller.signal), /Stopped/);
	assert.equal((await f.runner.read(ref)).cancelRequested, false);
	const result = await readHerdrAgent(f.root, ref.agentId, { wait: true }, { client: f.client, runner: f.runner, signal: controller.signal });
	assert.equal(result.details.status, "stopped");
	assert.equal((await f.runner.read(ref)).cancelRequested, true);
});

test("startup expiry cannot overwrite completion or a newer resume", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	await c.finish("done");
	const next = await f.runner.resume(ref.agentId, "continue");
	await f.runner.store.expireUnacceptedRun(ref, Number.MAX_SAFE_INTEGER);
	assert.equal((await f.runner.read(ref)).result, "done");
	assert.equal((await f.runner.read(next)).phase, "queued");
});

test("expired input cannot start Pi after it has been queued", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.child.poll();
	f.advance(20_000);
	await f.runner.reconcile();
	assert.equal((await f.runner.read(ref)).phase, "failed");
	assert.deepEqual(await c.child.input(c.sent[0].text), { action: "handled" });
	await c.child.noteLive();
	assert.ok(c.aborted() > 0);
});

test("unacknowledged cancellation cannot time out into a false stopped result", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.child.poll();
	await f.runner.cancel(ref);
	f.advance(20_000);
	await f.runner.reconcile(ref);
	const value = await f.runner.read(ref);
	assert.equal(value.phase, "failed");
	assert.match(value.error!, /may still be live/);
	assert.deepEqual(await c.child.input(c.sent[0].text), { action: "handled" });
});

test("blocked children return promptly; pane death is a lifecycle fact", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	await c.child.noteStatus("blocked");
	assert.equal((await f.runner.wait(ref)).phase, "blocked");
	f.live.delete(ref.agentId);
	await f.runner.reconcile();
	assert.equal((await f.runner.read(ref)).phase, "failed");
	assert.match((await f.runner.read(ref)).error!, /pane closed/);
});

test("unknown liveness does not become a false pane-closed result", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	f.client.isAlive = async () => { throw new Error("transport unavailable"); };
	await assert.rejects(f.runner.reconcile(), /transport unavailable/);
	assert.equal((await f.runner.read(ref)).phase, "queued");
});

test("one unavailable agent does not prevent another run's lifecycle reconciliation", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn(request());
	const second = await f.runner.spawn(request());
	f.advance(20_000);
	f.client.isAlive = async (name) => { if (name === first.agentId) throw new Error("unavailable"); return true; };
	await assert.rejects(f.runner.reconcile(), /unavailable/);
	assert.equal((await f.runner.read(second)).phase, "failed");
});

test("turn limits abort and terminal results cannot be overwritten by settle", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request({ maxTurns: 2 }));
	const c = await attach(f.runner, ref);
	await c.start();
	await c.child.noteTurn();
	assert.equal(c.aborted(), 0);
	await c.child.noteTurn();
	assert.equal(c.aborted(), 1);
	await c.finish("partial", "aborted");
	assert.equal((await f.runner.read(ref)).phase, "stopped");
	assert.match((await f.runner.read(ref)).error!, /Turn limit of 2/);
	await c.child.noteSettled("completed");
	assert.equal((await f.runner.read(ref)).phase, "stopped");
});

test("background notices belong to runs and remain pending until acknowledged", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn(request());
	const c = await attach(f.runner, first);
	await c.start();
	await c.finish("first output");
	let notices = await f.runner.store.notices("w1:p1");
	assert.equal(notices.length, 1);
	assert.match(completionNotice(notices[0]), /first output/);
	assert.equal((await f.runner.store.notices("w1:p1"))[0].id, notices[0].id);
	const second = await f.runner.resume(first.agentId, "continue");
	await c.start();
	await c.finish("second output");
	notices = await f.runner.store.notices("w1:p1");
	assert.deepEqual(new Set(notices.map((notice) => notice.runId)), new Set([first.runId, second.runId]));
	await f.runner.store.acknowledgeNotice(first.runId);
	assert.equal((await f.runner.store.notices("w1:p1"))[0].runId, second.runId);
});

for (const stage of ["isAlive", "listAgents", "layout", "split", "createTab", "startPi", "showLabel"] as const) {
	test(`cancellation during ${stage} never releases an unintended prompt`, async (t) => {
		const f = fixture(t);
		const controller = new AbortController();
		const original = f.client[stage].bind(f.client) as (...args: any[]) => Promise<any>;
		(f.client[stage] as (...args: any[]) => Promise<any>) = async (...args) => {
			const result = await original(...args);
			controller.abort();
			return result;
		};
		const result = await spawnHerdrAgent(request(stage === "createTab" ? { tabId: undefined } : {}), { root: f.root, client: f.client, runner: f.runner, signal: controller.signal });
		if (stage === "showLabel") {
			assert.equal(result.details.status, "stopped");
		} else {
			assert.match(result.text, /Stopped/);
			assert.equal(f.events.some((event) => event.startsWith("label:")), false);
		}
		for (const agent of await f.runner.store.listAgents()) {
			const run = await f.runner.read({ agentId: agent.id, runId: agent.currentRunId });
			assert.equal(run.accepted, false);
			assert.ok(isTerminal(run.phase));
		}
		if (stage === "split" || stage === "createTab" || stage === "startPi") assert.ok(f.events.some((event) => event.startsWith("close:")));
	});
}

test("cancellation during resume liveness does not create a run", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	await c.finish();
	const controller = new AbortController();
	f.client.isAlive = async () => { controller.abort(); return true; };
	await assert.rejects(f.runner.resume(ref.agentId, "never publish", controller.signal), /Stopped/);
	assert.equal((await f.runner.resolve(ref.agentId)).currentRunId, ref.runId);
});

test("cancelling a dispatched run waits for child acknowledgement", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	const pending = await f.runner.cancel(ref);
	assert.equal(pending.phase, "running");
	assert.equal(pending.cancelRequested, true);
	await c.child.poll();
	assert.equal(c.aborted(), 1);
	await c.finish("partial", "aborted");
	assert.equal((await f.runner.read(ref)).phase, "stopped");
});

test("failed Pi startup closes its pane but retains diagnostic run history", async (t) => {
	const f = fixture(t, { startPi: async () => { throw new Error("agent not ready"); } });
	await assert.rejects(f.runner.spawn(request()), /agent not ready/);
	assert.ok(f.events.includes("close:w1:p2"));
	const agent = await f.runner.resolve("explore");
	assert.equal((await f.runner.read({ agentId: agent.id, runId: agent.currentRunId })).phase, "failed");
	assert.equal((await f.runner.store.launches())[0].stage, "closed");
});

test("cleanup failures remain visible and retain the reservation", async (t) => {
	const f = fixture(t, {
		startPi: async () => { throw new Error("startup uncertain"); },
		closePane: async () => { throw new Error("connection lost"); },
	});
	await assert.rejects(f.runner.spawn(request()), /Cleanup failed.*may still be live/);
	const pending = (await f.runner.store.launches())[0];
	assert.equal(pending.stage, "cleanup");
	assert.equal((await f.runner.read(pending)).phase, "failed");
});

test("ambiguous pane creation is not retried and keeps a capacity reservation", async (t) => {
	const f = fixture(t, { split: async () => { throw new Error("reply lost"); } });
	await assert.rejects(f.runner.spawn(request()), /outcome is unknown/);
	const pending = (await f.runner.store.launches())[0];
	assert.equal(pending.stage, "ambiguous");
	assert.equal(pending.tabId, "w1:t1");
	assert.equal(pending.paneId, undefined);
});

test("concurrent placement counts durable reservations even before Herdr sees Pi", async (t) => {
	const f = fixture(t);
	f.client.listAgents = async () => [{ paneId: "w1:p1", tabId: "w1:t1" }, { paneId: "w1:other", tabId: "w1:t1" }];
	await Promise.all([f.runner.spawn(request()), f.runner.spawn(request())]);
	assert.equal(f.events.filter((event) => event.startsWith("split:")).length, 1);
	assert.equal(f.events.filter((event) => event === "tab").length, 1);
});

test("observed panes and reservations are deduplicated for capacity", async (t) => {
	const f = fixture(t);
	await f.runner.spawn(request());
	await f.runner.spawn(request());
	assert.equal(f.events.filter((event) => event.startsWith("split:")).length, 2);
	await f.runner.spawn(request());
	assert.equal(f.events.filter((event) => event === "tab").length, 1);
});

test("unknown occupancy chooses a new tab", async (t) => {
	const f = fixture(t, { listAgents: async () => { throw new Error("unavailable"); } });
	await f.runner.spawn(request());
	assert.equal(f.events[0], "tab");
	assert.equal(f.events.some((event) => event.startsWith("split:")), false);
});

test("inherit_context clones the session and preserves model and tool configuration", async (t) => {
	const f = fixture(t);
	const parent = join(f.root, "parent.jsonl");
	writeFileSync(parent, '{"type":"session","id":"parent","version":3}\n');
	mkdirSync(join(f.root, "agents"));
	writeFileSync(join(f.root, "agents", "Explore.md"), "---\ntools: read, grep\nmodel: openai-codex/gpt-6-astra\nthinking: xhigh\n---\nQuote the files.\n");
	const ref = await f.runner.spawn(request({ agentDir: f.root, inheritContext: true, sessionFile: parent, isolated: true }));
	const record = await f.runner.resolve(ref.agentId);
	assert.equal(readFileSync(record.sessionFile, "utf8"), readFileSync(parent, "utf8"));
	assert.deepEqual(record.allowedTools, ["read", "grep"]);
	assert.equal(record.instructions, "Quote the files.");
	assert.equal(f.events.at(-1), "label:w1:p2:explore · gpt-6-astra-xhigh");
});

test("depth belongs to the managed session, not a stale pane", async (t) => {
	const f = fixture(t);
	let parent = await f.runner.spawn(request());
	for (let depth = 2; depth <= 3; depth++) {
		const record = await f.runner.resolve(parent.agentId);
		parent = await f.runner.spawn(request({ paneId: record.paneId, sessionFile: record.sessionFile }));
		assert.equal((await f.runner.resolve(parent.agentId)).depth, depth);
	}
	const record = await f.runner.resolve(parent.agentId);
	await assert.rejects(f.runner.spawn(request({ paneId: record.paneId, sessionFile: record.sessionFile })), /depth 4/);
	const independent = await f.runner.spawn(request({ paneId: record.paneId, sessionFile: "/new-session" }));
	assert.equal((await f.runner.resolve(independent.agentId)).depth, 1);
});

test("legacy active runs block new protocol launches without modifying legacy state", async (t) => {
	const f = fixture(t);
	const old = join(f.root, "old-review");
	mkdirSync(old);
	writeFileSync(join(old, "task.json"), '{"id":"old-review"}');
	writeFileSync(join(old, "status.json"), '{"status":"running"}');
	await assert.rejects(f.runner.spawn(request()), /Legacy Herdr agent old-review is still active/);
	assert.equal(readFileSync(join(old, "status.json"), "utf8"), '{"status":"running"}');
	writeFileSync(join(old, "status.json"), '{"status":"completed"}');
	await f.runner.spawn(request());
});

async function peer(t: TestContext, root: string) {
	const child = fork(new URL("./fixtures/herdr-process.ts", import.meta.url), [root], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = "";
	child.stderr!.on("data", (data) => { stderr += String(data); });
	let sequence = 0;
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	const ready = deferred();
	child.on("message", (reply: any) => {
		if (reply.ready) ready.resolve();
		else {
			const waiter = pending.get(reply.id);
			pending.delete(reply.id);
			if (reply.error) waiter?.reject(new Error(reply.error));
			else waiter?.resolve(reply.value);
		}
	});
	child.on("exit", () => { for (const value of pending.values()) value.reject(new Error(`Peer exited: ${stderr}`)); });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
	});
	await Promise.race([ready.promise, once(child, "exit").then(() => { throw new Error(`Peer startup failed: ${stderr}`); })]);
	return {
		child,
		call(operation: string, ...args: string[]): Promise<any> {
			return new Promise((resolve, reject) => {
				const id = ++sequence;
				pending.set(id, { resolve, reject });
				child.send({ id, operation, args });
			});
		},
	};
}

async function kill(child: ChildProcess) {
	const exit = once(child, "exit");
	child.kill("SIGKILL");
	await exit;
}

test("real cross-process placement locks cannot be stolen and release on process death", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const first = await peer(t, f.root);
	const second = await peer(t, f.root);
	assert.equal(await first.call("lock", "first"), true);
	const path = join(f.root, "placement.sqlite");
	utimesSync(path, new Date(0), new Date(0));
	assert.equal(await second.call("lock", "second"), false);
	// Control writes remain available even while placement is held by another process.
	assert.deepEqual(await second.call("agents"), []);
	await kill(first.child);
	assert.equal(await second.call("lock", "second"), true);
	await second.call("unlock", "second");
});

test("real separate processes cannot both resume the same previous run", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	await c.finish("original");
	const a = await peer(t, f.root);
	const b = await peer(t, f.root);
	const outcomes = await Promise.allSettled([
		a.call("resume", ref.agentId, ref.runId, "one"), b.call("resume", ref.agentId, ref.runId, "two"),
	]);
	assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
	assert.equal((await f.runner.read(ref)).result, "original");
});

test("cancellation while waiting for cross-process placement keeps the UI thread responsive", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const holder = await peer(t, f.root);
	assert.equal(await holder.call("lock", "holder"), true);
	const controller = new AbortController();
	let ticks = 0;
	const timer = setInterval(() => { ticks++; }, 5);
	try {
		const result = f.runner.spawn(request(), controller.signal);
		await eventually(async () => (await f.runner.store.launches()).length === 1);
		await new Promise((resolve) => setTimeout(resolve, 80));
		controller.abort();
		await assert.rejects(result, /Stopped/);
		assert.ok(ticks >= 5);
		assert.equal(f.events.length, 0);
	} finally { clearInterval(timer); }
});

test("recovering a dead launch owner closes known panes and does not retry unknown creation", async (t) => {
	const f = fixture(t);
	const process = await peer(t, f.root);
	const owner = `${process.child.pid}:dead-launch`;
	const task: HerdrTask = { id: "orphan", herdrName: "orphan", paneId: "", type: "Explore", description: "orphan", prompt: "do not run", depth: 1, createdAt: new Date().toISOString() };
	const ref = (await f.runner.store.reserveAgent(task, join(f.root, "orphan.jsonl"), owner, Date.now()))!;
	await f.runner.store.recordLaunch(ref, owner, "starting-pi", { paneId: "w1:orphan", tabId: "w1:t1" }, Date.now());
	const unknown = (await f.runner.store.reserveAgent({ ...task, id: "unknown", herdrName: "unknown" }, join(f.root, "unknown.jsonl"), owner, Date.now()))!;
	await f.runner.store.recordLaunch(unknown, owner, "creating", { tabId: "w1:t1" }, Date.now());
	await kill(process.child);
	await f.runner.spawn(request());
	assert.ok(f.events.includes("close:w1:orphan"));
	assert.equal((await f.runner.store.launches()).find((value) => value.runId === unknown.runId)?.stage, "ambiguous");
	assert.equal((await f.runner.read(ref)).phase, "failed");
	assert.equal((await f.runner.read(unknown)).phase, "failed");
});

test("a startup UI prompt pauses the acceptance deadline", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.child.poll();
	await c.child.noteStatus("blocked");
	await f.runner.store.expireUnacceptedRun(ref, Date.now() + 60_000);
	assert.equal((await f.runner.read(ref)).phase, "blocked");
	assert.equal((await f.runner.wait(ref)).accepted, false);
	await c.child.noteStatus("running");
	c.setStreaming(true);
	await c.child.noteLive();
	await c.finish("accepted after prompt");
	assert.equal((await f.runner.read(ref)).result, "accepted after prompt");
});

test("run_id retrieves an older result without consuming the newer notice", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn(request());
	const c = await attach(f.runner, first);
	await c.start();
	await c.finish("old output");
	const second = await f.runner.resume(first.agentId, "continue");
	await c.start();
	await c.finish("new output");
	const result = await readHerdrAgent(f.root, first.agentId, { runId: first.runId }, { client: f.client, runner: f.runner });
	assert.match(result.text, /old output/);
	assert.doesNotMatch(result.text, /new output/);
	assert.deepEqual((await f.runner.store.notices("w1:p1")).map((notice) => notice.id), [second.runId]);
});

test("a retired runner's failed cleanup is recovered after reload in the same process", async (t) => {
	const f = fixture(t);
	const before = new HerdrRunner({ root: f.root, client: { ...f.client, startPi: async () => { throw new Error("start failed"); }, closePane: async () => { throw new Error("close unavailable"); } } });
	await assert.rejects(before.spawn(request()), /Cleanup failed/);
	await before.close();
	await f.runner.reconcile();
	assert.ok(f.events.includes("close:w1:p2"));
	assert.equal((await f.runner.store.launches())[0].stage, "closed");
});

test("confirmed departed agents release reservations without closing unrelated panes", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn(request());
	await f.runner.spawn(request());
	f.live.delete(first.agentId);
	await f.runner.spawn(request());
	assert.equal(f.events.filter((event) => event.startsWith("split:")).length, 3);
	assert.equal(f.events.filter((event) => event.startsWith("close:")).length, 0);
});

test("the worker loads from an installed package path without Node TypeScript stripping", async () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-package-"));
	const pkg = join(dir, "node_modules", "grok-style-pi");
	mkdirSync(join(pkg, "src", "herdr"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
	for (const name of ["store.ts", "state.ts", "worker.ts", "worker-entry.mjs"]) {
		copyFileSync(fileURLToPath(new URL(`../src/herdr/${name}`, import.meta.url)), join(pkg, "src", "herdr", name));
	}
	symlinkSync(fileURLToPath(new URL("../node_modules/jiti", import.meta.url)), join(dir, "node_modules", "jiti"), "dir");
	try {
		const loaded = await createJiti(import.meta.url).import<{ HerdrStore: typeof HerdrStore }>(join(pkg, "src", "herdr", "store.ts"));
		const store = new loaded.HerdrStore(join(dir, "state"));
		try { assert.deepEqual(await store.listAgents(), []); }
		finally { await store.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI distinguishes missing agents from transport failures on either output stream", async () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-cli-"));
	const bin = join(dir, "herdr.mjs");
	writeFileSync(bin, '#!/usr/bin/env node\nprocess[process.env.HERDR_TEST_STREAM].write(process.env.HERDR_TEST_REPLY + "\\n"); process.exit(Number(process.env.HERDR_TEST_EXIT));\n', { mode: 0o755 });
	const cli = (reply: unknown, exit = 1, stream = "stdout") => createHerdrCli({ ...process.env, HERDR_BIN_PATH: bin, HERDR_TEST_REPLY: JSON.stringify(reply), HERDR_TEST_EXIT: String(exit), HERDR_TEST_STREAM: stream });
	try {
		for (const stream of ["stdout", "stderr"]) {
			assert.equal(await cli({ error: { code: "agent_not_found", message: "missing" } }, 1, stream).isAlive("missing"), false);
			await assert.rejects(cli({ error: { code: "transport_error", message: "connection failed" } }, 1, stream).isAlive("name"), /connection failed/);
			await assert.rejects(cli("connection unavailable", 1, stream).isAlive("name"), /connection unavailable/);
		}
		await assert.rejects(cli({}, 0).listAgents(), /agents array/);
		assert.equal(await cli({ result: { agent: "pi" } }, 0).isAlive("name"), true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fresh Agent spawn proceeds when Herdr reports its unused name on stderr", async (t) => {
	const f = fixture(t);
	const bin = join(f.root, "herdr.mjs");
	const trace = join(f.root, "cli.jsonl");
	writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_TEST_TRACE, JSON.stringify(args) + "\\n");
const operation = args.slice(0, 2).join(" ");
if (operation === "agent get") {
	console.error(JSON.stringify({ error: { code: "agent_not_found", message: "agent target " + args[2] + " not found" }, id: "cli:agent:get" }));
	process.exit(1);
}
const results = {
	"agent list": { agents: [{ tab_id: "w1:t1", pane_id: "w1:p1" }] },
	"pane layout": { columns: 120, rows: 40 },
	"pane split": { pane: { pane_id: "w1:p2" } },
};
console.log(JSON.stringify({ result: results[operation] ?? {} }));
`, { mode: 0o755 });
	const runner = new HerdrRunner({ root: f.root, client: createHerdrCli({ ...process.env, HERDR_BIN_PATH: bin, HERDR_TEST_TRACE: trace }) });
	try {
		const ref = await runner.spawn(request({ name: "relay-correctness", subagentType: "general-purpose" }));
		assert.equal(ref.agentId, "relay-correctness");
		assert.equal((await runner.read(ref)).phase, "queued");
		assert.equal((await runner.store.launches())[0].stage, "published");
		const calls: string[][] = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(calls[0], ["agent", "get", "relay-correctness"]);
		assert.ok(calls.some((args) => args[0] === "agent" && args[1] === "start" && args[2] === "relay-correctness"));
	} finally { await runner.close(); }
});

test("agent files, naming, geometry, and Herdr payload contracts remain intact", () => {
	const parsed = parseAgentFile("---\ntools:\n  - read\n  - grep\nmax_turns: 4\nextensions: false\n---\nQuote the files.\n");
	assert.deepEqual(parsed.tools, ["read", "grep"]);
	assert.equal(parsed.maxTurns, 4);
	assert.equal(parsed.isolated, true);
	assert.deepEqual(parseAgentFile("---\ntools: []\n---\nNo tools.").tools, []);
	assert.equal(herdrAgentName("Auth Audit!!!", "Explore"), "auth-audit");
	assert.equal(herdrAgentName("a".repeat(40), "Explore").length, 31);
	assert.equal(paneIdFromSplit({ result: { pane: { pane_id: "w1:p4" } } }), "w1:p4");
	assert.equal(splitDirection({ result: { columns: 160, rows: 20 } }), "right");
	assert.equal(splitDirection(undefined), "down");
	assert.equal(needsNewTab(2), false);
	assert.equal(needsNewTab(3), true);
	assert.deepEqual(tabFromCreate({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p8" } } }), { tabId: "w1:t2", paneId: "w1:p8" });
	assert.deepEqual(agentsFromList({ result: { agents: [{ tab_id: "w1:t1", pane_id: "w1:p1" }] } }), [{ tabId: "w1:t1", paneId: "w1:p1" }]);
	assert.throws(() => agentsFromList({}), /agents array/);
});

test("tool names and durable notification receipts survive extension reload", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const c = await attach(f.runner, ref);
	await c.start();
	await c.finish("finished");
	const saved: any[] = [];
	const queued: any[] = [];
	const create = () => {
		const tools: any[] = [];
		const handlers = new Map<string, (...args: any[]) => any>();
		const pi = {
			registerTool(tool: any) { tools.push(tool); },
			on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
			sendMessage(message: any) { queued.push(message); },
			sendUserMessage() {}, appendEntry() {},
		} as unknown as ExtensionAPI;
		createHerdrSubagents({ root: f.root, client: f.client, env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, agentDir: f.root })(pi);
		return { tools, handlers };
	};
	const ctx = { isIdle: () => true, abort() {}, ui: { notify() {} }, sessionManager: { getEntries: () => saved, getBranch: () => [], getSessionFile: () => "/parent/session.jsonl", getSessionId: () => "parent" } };
	const first = create();
	assert.deepEqual(first.tools.map((tool) => tool.name), ["Agent", "get_subagent_result", "steer_subagent"]);
	await first.handlers.get("session_start")!({}, ctx);
	await eventually(async () => queued.length === 1);
	assert.equal((await f.runner.store.notices("w1:p1")).length, 1, "queued messages are not delivery receipts");
	await first.handlers.get("session_shutdown")!({ reason: "reload" });
	const second = create();
	await second.handlers.get("session_start")!({}, ctx);
	await eventually(async () => queued.length === 2);
	assert.equal(queued[0].details.noticeId, queued[1].details.noticeId);
	saved.push({ type: "custom_message", ...queued[1] });
	await eventually(async () => (await f.runner.store.notices("w1:p1")).length === 0);
	await second.handlers.get("session_shutdown")!({ reason: "quit" });
});

test("slow Herdr maintenance does not block child cancellation polling", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const record = await f.runner.resolve(ref.agentId);
	const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id;
	const healthStarted = deferred();
	const healthResult = deferred<Awaited<ReturnType<HerdrClient["listAgents"]>>>();
	f.client.listAgents = async () => { healthStarted.resolve(); return healthResult.promise; };
	const handlers = new Map<string, (...args: any[]) => any>();
	const sent: string[] = [];
	let aborts = 0;
	const pi = {
		registerTool() {}, on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		sendUserMessage(text: string) { sent.push(text); }, sendMessage() {}, appendEntry() {},
	} as unknown as ExtensionAPI;
	createHerdrSubagents({ root: f.root, client: f.client, env: { HERDR_ENV: "1", HERDR_PANE_ID: record.paneId }, agentDir: f.root })(pi);
	const ctx = { isIdle: () => true, abort() { aborts++; }, ui: { notify() {} }, sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => record.sessionFile, getSessionId: () => sessionId } };
	await handlers.get("session_start")!({}, ctx);
	try {
		await eventually(async () => sent.length === 1);
		await healthStarted.promise;
		await handlers.get("input")!({ text: sent[0] });
		await handlers.get("agent_start")!();
		await f.runner.cancel(ref);
		await eventually(async () => aborts > 0, "cancellation was blocked behind the Herdr call");
		await handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "aborted" }] });
		await handlers.get("agent_settled")!();
		assert.equal((await f.runner.read(ref)).phase, "stopped");
	} finally {
		healthResult.resolve([{ name: record.herdrName, paneId: record.paneId }]);
		await handlers.get("session_shutdown")!({ reason: "quit" });
	}
});

test("background maintenance batches the fleet and shares its interval across runners", async (t) => {
	const f = fixture(t);
	const refs = await Promise.all([f.runner.spawn(request()), f.runner.spawn(request()), f.runner.spawn(request())]);
	const peer = new HerdrRunner({ root: f.root, client: f.client });
	t.after(() => peer.close());
	let lists = 0;
	const list = f.client.listAgents;
	f.client.listAgents = async () => { lists++; return list(); };
	f.client.isAlive = async () => { assert.fail("maintenance must batch liveness"); };
	await Promise.all([f.runner.maintain(), peer.maintain()]);
	await Promise.all([f.runner.maintain(), peer.maintain()]);
	assert.equal(lists, 1);
	assert.ok((await Promise.all(refs.map((ref) => f.runner.read(ref)))).every((run) => run.phase === "queued"));
	f.live.delete(refs[0].agentId);
	f.advance(1100);
	await f.runner.maintain();
	assert.equal(lists, 2);
	assert.equal((await f.runner.read(refs[0])).phase, "failed");
	assert.equal((await f.runner.read(refs[1])).phase, "queued");
});

test("maintenance leases fail over and fence stale replies and resumed runs", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	const now = Date.now();
	assert.equal(await f.runner.store.claimMaintenance("old", now), true);
	assert.equal(await f.runner.store.claimMaintenance("peer", now + 100), false);
	assert.equal(await f.runner.store.claimMaintenance("peer", now + 5001), true);
	assert.equal(await f.runner.store.finishMaintenance("old", [{ ref, alive: false }], now + 5002), false);
	assert.equal((await f.runner.read(ref)).phase, "queued");
	const c = await attach(f.runner, ref);
	await c.start(); await c.finish("done");
	const next = await f.runner.resume(ref.agentId, "continue");
	assert.equal(await f.runner.store.finishMaintenance("peer", [{ ref, alive: false }], now + 5003), true);
	assert.equal((await f.runner.read(next)).phase, "queued");
});

test("failed and incomplete fleet snapshots preserve unknown liveness", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(request());
	f.client.listAgents = async () => { throw new Error("transport unavailable"); };
	await assert.rejects(f.runner.maintain(), /transport unavailable/);
	assert.equal((await f.runner.read(ref)).phase, "queued");
	f.advance(1100);
	f.client.listAgents = async () => [{}];
	await assert.rejects(f.runner.maintain(), /incomplete agent listing/);
	assert.equal((await f.runner.read(ref)).phase, "queued");
	f.advance(1100);
	const record = await f.runner.resolve(ref.agentId);
	f.client.listAgents = async () => [{ paneId: record.paneId }];
	await f.runner.maintain();
	assert.equal((await f.runner.read(ref)).phase, "queued");
});

test("simultaneous first opens initialize WAL without losing a control worker", async () => {
	const root = mkdtempSync(join(tmpdir(), "herdr-wal-startup-"));
	const stores = Array.from({ length: 6 }, () => new HerdrStore(root));
	try {
		assert.deepEqual(await Promise.all(stores.map((store) => store.listAgents())), Array.from({ length: 6 }, () => []));
	} finally { await Promise.all(stores.map((store) => store.close())); rmSync(root, { recursive: true, force: true }); }
});
