import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getModel, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createHerdrSubagents, type HerdrBackendHandle, type HerdrBackendNotice, type HerdrSubagentOptions } from "../src/herdr/extension.ts";
import { workerChannel } from "../src/herdr/store.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import { createChildSession } from "../src/herdr/child.ts";
import { HerdrRunner } from "../src/herdr/runner.ts";

async function until(check: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise((done) => setTimeout(done, 10)); }
	assert.fail("Backend condition timed out");
}
function fixture(t: TestContext) {
	const captures = resolve("captures");
	mkdirSync(captures, { recursive: true });
	const root = mkdtempSync(join(captures, "herdr-backend-"));
	const live = new Map<string, string>();
	let sequence = 0;
	const client: HerdrClient = {
		async createTab() { return { paneId: `child-${++sequence}`, tabId: `tab-${sequence}` }; },
		async split() { return { paneId: `child-${++sequence}` }; },
		async startPi(value) { live.set(value.name, value.paneId); },
		async startClaude(value) { live.set(value.name, value.paneId); },
		async promptAgent() {},
		async closePane(pane) { for (const [id, value] of live) if (value === pane) live.delete(id); },
		async isAlive(id) { return live.has(id); },
		async getAgent(id) { const paneId = live.get(id); return paneId ? { name: id, paneId } : undefined; },
		async listAgents() { return [...live].map(([name, paneId]) => ({ name, paneId })); },
		async listPanes() { return []; }, async showLabel() {},
	};
	const observer = new HerdrRunner({ root, client });
	const cleanups: (() => Promise<void>)[] = [];
	t.after(async () => {
		for (const close of cleanups) await close();
		await observer.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	});
	return { root, client, observer, cleanups };
}
async function install(f: ReturnType<typeof fixture>, paneId = "parent", sessionFile = "/parent/session.jsonl", sessionId = "parent", options: Partial<HerdrSubagentOptions> = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools: unknown[] = [], sent: string[] = [], notices: unknown[] = [], saved: any[] = [];
	let active = ["read", "write", "Agent"];
	let backend!: HerdrBackendHandle;
	const pi = {
		registerTool(tool: unknown) { tools.push(tool); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		sendMessage(message: unknown) { notices.push(message); }, sendUserMessage(text: string) { sent.push(text); }, appendEntry() {},
		getActiveTools() { return active; }, setActiveTools(names: string[]) { active = names; },
	} as unknown as ExtensionAPI;
	await createHerdrSubagents({ mode: "backend", onBackend(handle) { backend = handle; }, root: f.root, client: f.client,
		env: { HERDR_PANE_ID: paneId }, agentDir: f.root, listMachines: async () => [], ...options })(pi);
	const ctx = { cwd: f.root, isProjectTrusted: () => true, isIdle: () => true, abort() {}, ui: { notify() {} },
		sessionManager: { getEntries: () => saved, getBranch: () => [], getSessionFile: () => sessionFile, getSessionId: () => sessionId } } as unknown as ExtensionContext;
	let closed = false;
	const close = async (reason = "reload") => {
		if (closed) return;
		closed = true;
		await handlers.get("session_shutdown")!({ reason });
	};
	f.cleanups.push(close);
	return { backend, handlers, tools, sent, notices, saved, ctx, active: () => active,
		async start() { await handlers.get("session_start")!({}, ctx); }, close,
	};
}
async function execute(f: ReturnType<typeof fixture>, agentId: string, text = "Backend child result") {
	const record = await f.observer.resolve(agentId);
	const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id;
	let sent = "";
	const child = await createChildSession(f.observer.store, record.paneId, { sessionFile: record.sessionFile, sessionId }, {
		sendUserMessage(value) { sent = value; }, abort() {}, assistantText: () => text, streaming: () => false, clearAssistant() {},
	});
	assert(child);
	await child.poll();
	assert.equal((await child.input(sent))?.action, "transform");
	await child.noteLive();
	await child.noteSettled("completed");
	await child.dispose();
}
const request = (cwd: string) => ({ prompt: "Inspect the code", description: "Inspect code", subagentType: "Explore", runInBackground: true, cwd });

test("backend factory registers no tools and sends no Pi notices; only explicit acknowledgement clears the outbox", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const parent = await install(f);
	t.after(() => parent.close());
	const received: HerdrBackendNotice[] = [];
	parent.backend.onNotice((notice) => received.push(notice));
	await parent.start();
	assert.deepEqual(parent.tools, []);
	const launched = await parent.backend.spawn(request(f.root), parent.ctx);
	assert.match(launched.agentId, /explore/);
	assert.equal(parent.backend.capabilities(launched.agentId).sharedTasks, true);
	assert.equal(parent.backend.capabilities(launched.agentId).fork, false);
	await execute(f, launched.agentId);
	await until(() => received.length === 1);
	assert.equal(received[0].runId, launched.runId);
	assert.match(received[0].content, /Backend child result/);
	assert.deepEqual(parent.notices, []);
	const status = await parent.backend.read(launched.agentId, { wait: true });
	assert.equal(status.status, "completed");
	assert.equal(status.phase, "completed");
	assert.equal(status.resultText, "Backend child result");
	assert.equal(received[0].phase, "completed");
	assert.equal((await f.observer.store.notices("parent")).length, 1, "reading a terminal run cannot acknowledge backend notices");
	parent.saved.push({ type: "custom_message", customType: "herdr-subagent-notification", details: { noticeId: received[0].noticeId } });
	await new Promise((done) => setTimeout(done, 450));
	assert.equal((await f.observer.store.notices("parent")).length, 1, "backend mode does not infer receipts from Pi history");
	await parent.backend.acknowledge(received[0].noticeId);
	await parent.backend.acknowledge(received[0].noticeId);
	assert.equal((await f.observer.store.notices("parent")).length, 0);
	await assert.rejects(parent.backend.acknowledge("unknown-notice"), /Unknown Herdr notice/);
});

test("unacknowledged notices survive extension reload and listeners can unsubscribe", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const first = await install(f);
	const firstNotices: HerdrBackendNotice[] = [];
	const unsubscribe = first.backend.onNotice((notice) => firstNotices.push(notice));
	await first.start();
	const launched = await first.backend.spawn(request(f.root), first.ctx);
	await execute(f, launched.agentId);
	await until(() => firstNotices.length === 1);
	unsubscribe();
	await first.close();
	const second = await install(f);
	t.after(() => second.close());
	await second.start();
	await new Promise((done) => setTimeout(done, 250));
	assert.equal((await f.observer.store.notices("parent")).length, 1, "no listener means no delivery or acknowledgement");
	const received: HerdrBackendNotice[] = [];
	second.backend.onNotice((notice) => received.push(notice));
	await until(() => received.length === 1);
	assert.equal(received[0].noticeId, firstNotices[0].noticeId);
	assert.equal(received[0].agentId, launched.agentId);
	await second.backend.acknowledge(received[0].noticeId);
	assert.deepEqual(second.notices, []);
});

test("backend mode retains child input authorization, tool filtering and settled lifecycle", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, ".pi", "agents"), { recursive: true });
	writeFileSync(join(f.root, ".pi", "agents", "scoped.md"), "---\ntools: read\n---\nRead only.");
	const ref = await f.observer.spawn({ ...request(f.root), subagentType: "scoped", paneId: "parent" });
	const record = await f.observer.resolve(ref.agentId);
	const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id;
	const child = await install(f, record.paneId, record.sessionFile, sessionId);
	t.after(() => child.close());
	await child.start();
	await until(() => child.sent.length === 1);
	const input = await child.handlers.get("input")!({ text: child.sent[0] });
	assert.equal(input.action, "transform");
	assert.match(input.text, /Inspect the code/);
	assert.equal((await child.handlers.get("input")!({ text: "<!-- herdr-command:aaaaaaaa-bbbb:cccccccc-dddd -->\nExpired" })).action, "handled");
	await child.handlers.get("before_agent_start")!();
	assert.deepEqual(child.active(), ["read"]);
	assert.equal((await child.handlers.get("tool_call")!({ toolName: "write" })).block, true);
	assert.equal(await child.handlers.get("tool_call")!({ toolName: "read" }), undefined);
	await child.handlers.get("agent_start")!();
	await child.handlers.get("ui_prompt_start")!();
	assert.equal((await f.observer.read(ref)).phase, "blocked");
	await child.handlers.get("ui_prompt_end")!();
	await child.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "Scoped child finished" }] } });
	await child.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] });
	await child.handlers.get("agent_settled")!();
	assert.equal((await f.observer.read(ref)).result, "Scoped child finished");
	assert.equal((await f.observer.read(ref)).phase, "completed");
	assert.deepEqual(child.tools, []);
});

test("backend cancellation reports a request before child acknowledgement and Claude steering is unsupported", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const parent = await install(f);
	t.after(() => parent.close());
	await parent.start();
	const launched = await parent.backend.spawn(request(f.root), parent.ctx);
	assert.equal((await parent.backend.cancel(launched.agentId)).acknowledged, true, "queued undispatched runs can be cancelled authoritatively");
	const running = await parent.backend.spawn({ ...request(f.root), subagentType: "running" }, parent.ctx);
	const record = await f.observer.resolve(running.agentId);
	const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id;
	let streaming = false, command = "";
	const child = await createChildSession(f.observer.store, record.paneId, { sessionFile: record.sessionFile, sessionId }, {
		sendUserMessage(text) { command = text; }, abort() { streaming = false; }, assistantText: () => "", streaming: () => streaming, clearAssistant() {},
	});
	assert(child);
	await child.poll();
	await child.input(command);
	streaming = true;
	await child.noteLive();
	assert.equal((await parent.backend.steer(running.agentId, "More detail")).ok, true);
	assert.equal((await parent.backend.cancel(running.agentId)).acknowledged, false, "a running child's stop request is not acknowledgement");
	await child.poll();
	assert.equal((await parent.backend.cancel(running.agentId)).acknowledged, true);
	await child.dispose();
	const claude = await parent.backend.spawn({ ...request(f.root), runtime: "claude-code", subagentType: "general" }, parent.ctx);
	assert.deepEqual(parent.backend.capabilities(claude.agentId), { liveDelivery: false, maxTurns: false, fork: false, sharedTasks: false });
	assert.equal((await parent.backend.steer(claude.agentId, "Change course")).ok, false);
	assert.equal((await parent.backend.cancel(claude.agentId)).acknowledged, true);
	await assert.rejects(parent.backend.spawn({ ...request(f.root), runtime: "claude-code", machine: "remote" }, parent.ctx), /local Herdr panes only/);
});

test("backend resume retains identity and explicit historical reads never consume a newer notice", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const parent = await install(f);
	await parent.start();
	const received: HerdrBackendNotice[] = [];
	parent.backend.onNotice((notice) => received.push(notice));
	const first = await parent.backend.spawn(request(f.root), parent.ctx);
	await execute(f, first.agentId, "First result");
	const next = await parent.backend.resume(first.agentId, "Follow-up", parent.ctx);
	assert.notEqual(next.runId, first.runId);
	await parent.backend.cancel(first.agentId, { runId: first.runId });
	assert.equal((await f.observer.read({ agentId: first.agentId, runId: next.runId })).cancelRequested, false, "captured cancellation cannot target the resumed run");
	assert.equal((await parent.backend.steer(first.agentId, "Expired steering", { runId: first.runId })).ok, false);
	await execute(f, first.agentId, "Second result");
	await until(() => received.length === 2);
	const old = await parent.backend.read(first.agentId, { runId: first.runId, wait: true });
	assert.match(old.text, /First result/);
	assert.equal(old.runId, first.runId);
	assert.equal((await f.observer.store.notices("parent")).length, 2);
	for (const notice of received) await parent.backend.acknowledge(notice.noticeId);
});

test("aborting a backend waiter does not cancel the captured run", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const parent = await install(f);
	await parent.start();
	const launched = await parent.backend.spawn(request(f.root), parent.ctx);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(parent.backend.read(launched.agentId, { wait: true, signal: controller.signal }), /Stopped/);
	assert.equal((await f.observer.read(launched)).cancelRequested, false);
	await parent.backend.cancel(launched.agentId);
});

test("real Pi child processes a backend command through its public session entrypoint", { timeout: 15_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const f = fixture(t);
	const ref = await f.observer.spawn({ ...request(f.root), paneId: "parent" });
	const record = await f.observer.resolve(ref.agentId);
	const runtime = await ModelRuntime.create({ authPath: join(f.root, "auth.json"), modelsPath: null, modelsStorePath: join(f.root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createHerdrSubagents({ mode: "backend", root: f.root, client: f.client, agentDir: f.root, env: { HERDR_PANE_ID: record.paneId }, listMachines: async () => [] })],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: f.root, agentDir: f.root, modelRuntime: runtime, settingsManager: settings,
		model: getModel("anthropic", "claude-sonnet-4-5"), sessionManager: SessionManager.open(record.sessionFile), resourceLoader: loader });
	f.cleanups.unshift(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); });
	let requests = 0;
	session.agent.streamFunction = (model, context) => {
		requests++;
		assert.match(JSON.stringify(context.messages), /Inspect the code/);
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [{ type: "text", text: "Real headless child report" }], stopReason: "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
		return stream;
	};
	await session.bindExtensions({ mode: "json" });
	assert(!session.getAllTools().some((tool) => ["Agent", "get_subagent_result", "steer_subagent"].includes(tool.name)));
	await until(async () => (await f.observer.read(ref)).phase === "completed");
	assert.equal(requests, 1);
	assert.equal((await f.observer.read(ref)).result, "Real headless child report");
});

test("backend remote notices keep qualified IDs and acknowledge only the machine's authoritative store", { timeout: 15_000 }, async (t) => {
	const f = fixture(t);
	const remoteRoot = join(f.root, "remote-store");
	const remote = new HerdrRunner({ root: remoteRoot, client: f.client, machine: "laptop" });
	f.cleanups.push(() => remote.close());
	let disconnect = () => {}, opens = 0;
	const parent = await install(f, "parent", "/parent/session.jsonl", "parent", {
		hostname: "test-host", machineClient: () => f.client, machineChannel: async () => (events) => {
			opens++;
			disconnect = () => events.fail(new Error("Injected backend transport loss"));
			return workerChannel(remoteRoot)(events);
		},
	});
	await parent.start();
	const received: HerdrBackendNotice[] = [];
	parent.backend.onNotice((notice) => received.push(notice));
	const launched = await parent.backend.spawn({ ...request(f.root), machine: "laptop", machineCwd: f.root }, parent.ctx);
	assert.match(launched.agentId, /@laptop$/);
	assert.deepEqual(parent.backend.capabilities(launched.agentId), { liveDelivery: true, maxTurns: true, fork: false, sharedTasks: false });
	const id = launched.agentId.split("@")[0];
	await execute({ ...f, observer: remote }, id, "Remote result");
	await until(() => received.length === 1);
	assert.equal(received[0].agentId, launched.agentId);
	assert.equal(received[0].machine, "laptop");
	assert.equal((await remote.store.notices("test-host/parent")).length, 1);
	assert.equal((await f.observer.store.notices("parent")).length, 0);
	disconnect();
	await parent.backend.acknowledge(received[0].noticeId);
	assert.equal(opens, 2, "acknowledgement reconnects instead of retaining a dead runner");
	assert.equal((await remote.store.notices("test-host/parent")).length, 0);
});
