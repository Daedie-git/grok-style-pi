import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import subagents, { createGrokSubagents } from "../integrations/subagents.ts";
import grok from "../extensions/index.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { defaultFeatures } from "../src/extension/features.ts";
import { SubagentAdapter } from "../src/subagents/adapter.ts";
import { runInChildScope } from "../packages/subagent-engine/src/child-context.ts";
import type { Engine } from "../packages/subagent-engine/src/engine.ts";
import type { Activity } from "../src/activity/ui.ts";
import { scripted, until, type Script } from "../packages/subagent-engine/test/fixtures/harness.ts";
import { FakeEngine } from "./fixtures/engine-activity.ts";

async function fixture(t: TestContext, parent: Script, child: Script, autonomy = true) {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	mkdirSync(resolve("captures"), { recursive: true });
	const root = mkdtempSync(join(resolve("captures"), "grok-engine-"));
	const agentDir = join(root, "agent"); mkdirSync(agentDir);
	// Real child discovery loads the actual file entrypoint; its child-context guard must make it inert.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [fileURLToPath(new URL("../integrations/subagents.ts", import.meta.url))] }));
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "offline-test");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let engine!: Engine;
	const children: AgentSession[] = [];
	const activity: Activity[] = [];
	let adapter!: SubagentAdapter;
	const features = { ...Object.fromEntries(Object.keys(defaultFeatures).map((key) => [key, false])), toolStyling: true, autonomy } as typeof defaultFeatures;
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createGrokSubagents({ env: {}, style: { features }, engine: {
			env: {}, agentDir, homeDir: root, modelRuntime: async () => runtime,
			onEngine(created) { engine = created; adapter?.dispose(); adapter = new SubagentAdapter(created, (entry) => { if (!activity.includes(entry)) activity.push(entry); }); },
			onSessionCreated(session) { children.push(session); session.agent.streamFunction = scripted(child, () => {}) as never; },
		} })],
	});
	const oldSteer = process.env.GROK_STEER_DIR; process.env.GROK_STEER_DIR = join(root, "steer");
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader: loader });
	let modelInput: unknown;
	const transport = scripted(parent, () => {});
	session.agent.streamFunction = ((model: any, context: any, options: any) => {
		modelInput = context;
		return transport(model, context, options);
	}) as never;
	const extensionErrors: unknown[] = [];
	await session.bindExtensions({ mode: "json", onError: (error) => { extensionErrors.push(error); } });
	t.after(async () => {
		adapter.dispose();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		if (oldSteer === undefined) delete process.env.GROK_STEER_DIR; else process.env.GROK_STEER_DIR = oldSteer;
		rmSync(root, { recursive: true, force: true });
	});
	return { session, get engine() { return engine; }, get adapter() { return adapter; }, activity, children, features, extensionErrors, modelInput: () => modelInput };
}

test("real Grok integration dispatches Agent in a Pi tool loop and records completion", { timeout: 15000 }, async (t) => {
	const h = await fixture(t, ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { subagent_type: "general-purpose", description: "contract work", prompt: "finish this assignment", run_in_background: false } }] } : { text: "Parent handback" }, () => ({ text: "Child report" }));
	await h.session.prompt("Perform the contract assignment");
	assert.match(JSON.stringify(h.session.messages), /Child report/);
	assert.equal(h.children.length, 1);
	assert.equal(h.activity[0].status, "completed");
	assert.equal(h.activity[0].title, "general-purpose: contract work");
	assert.match(h.activity[0].output, /Child report/);
	assert.match(h.activity[0].model!, /claude-sonnet/);
	assert.equal(h.activity[0].stop, undefined);
	for (const name of ["Agent", "SendMessage", "TaskStop", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "get_subagent_result", "steer_subagent"]) assert.ok(h.session.getAllTools().some((tool) => tool.name === name));
	assert.equal(h.children[0].getAllTools().some((tool) => tool.name === "show_image"), false, "Grok user extension stays inert in a real engine child");
});

test("autonomy feature controls the engine's actual system guidance", { timeout: 15000 }, async (t) => {
	for (const autonomy of [true, false]) {
		await t.test(String(autonomy), async (inner) => {
			const h = await fixture(inner, () => ({ text: "done" }), () => ({ text: "unused" }), autonomy);
			await h.session.prompt("Inspect guidance");
			const system = (h.modelInput() as { messages: { role: string; content: unknown }[] }).messages.filter((message) => message.role === "system").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
			if (autonomy) { assert.match(system, /proactive use without a separate user request/); assert.doesNotMatch(system, /Delegate only when the user explicitly requests/); }
			else { assert.match(system, /Delegate only when the user explicitly requests/); assert.doesNotMatch(system, /proactive use without a separate user request/); }
		});
	}
});

test("real background activity Stop uses engine user cancellation without aborting the parent", { timeout: 15000 }, async (t) => {
	let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
	const h = await fixture(t, ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { subagent_type: "general-purpose", description: "wait", prompt: "wait", run_in_background: true } }] } : { text: "Parent remains usable" }, () => { entered(); return { wait: new Promise<void>(() => {}), then: { text: "unused" } }; });
	await h.session.prompt("Start an independent assignment"); await ready;
	const stop = h.activity[0].stop!;
	await stop();
	await until(() => h.activity[0].status === "stopped");
	assert.equal(h.session.isStreaming, false);
	assert.match(JSON.stringify(h.session.messages), /Parent remains usable/);
	assert.equal(h.engine.control.get(h.activity[0].id.slice(6))?.meta.stoppedByUser, true);
	await assert.rejects(async () => { await stop(); }, /run has ended/);
});

test("real session reload adopts the live engine and restores cancellable activity", { timeout: 15000 }, async (t) => {
	let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
	const h = await fixture(t, ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { subagent_type: "general-purpose", description: "survive reload", prompt: "wait", run_in_background: true } }] } : { text: "Parent ready" }, () => { entered(); return { wait: new Promise<void>(() => {}), then: { text: "unused" } }; });
	await h.session.prompt("Start work that survives reload"); await ready;
	const engine = h.engine;
	const adapter = h.adapter;
	const original = h.activity[0];
	const snapshot = engine.agentSnapshots().find((agent) => agent.agentId === original.id.slice(6))!;
	assert.equal(snapshot.running, true);
	assert.equal(snapshot.runId, adapter.identity(snapshot.agentId)?.runId);
	assert.equal(snapshot.backend, "in-process");
	assert.equal(snapshot.startedAt, original.startedAt);
	snapshot.description = "Detached UI copy";
	assert.equal(engine.agentSnapshots().find((agent) => agent.agentId === snapshot.agentId)?.description, "survive reload");
	const oldStop = original.stop!;
	await h.session.reload();
	assert.ok(h.engine === engine, "the broker's original engine is adopted");
	assert.ok(h.adapter !== adapter, "onEngine rebinds observation after adoption");
	assert.deepEqual(h.extensionErrors, []);
	assert.equal(h.children.length, 1, "reload does not recreate the child");
	assert.equal(h.children[0].isStreaming, true);
	const restored = h.activity.at(-1)!;
	assert.notEqual(restored, original);
	assert.equal(restored.id, original.id);
	assert.equal(restored.title, "general-purpose: survive reload");
	assert.equal(restored.status, "running");
	await assert.rejects(async () => { await oldStop(); }, /run has ended/);
	await restored.stop!();
	await until(() => restored.status === "stopped");
	assert.equal(engine.control.get(restored.id.slice(6))?.meta.stoppedByUser, true);
});

test("autonomy changes on reload reach newly created child tool policy", { timeout: 15000 }, async (t) => {
	const h = await fixture(t, ({ index }) => index === 1 ? { tools: [{ name: "Agent", args: { subagent_type: "general-purpose", description: "after reload", prompt: "finish", run_in_background: false } }] } : { text: "done" }, () => ({ text: "child done" }));
	await h.session.prompt("Prepare reload");
	h.features.autonomy = false;
	await h.session.reload();
	await h.session.prompt("Explicitly launch an agent after the setting change");
	assert.equal(h.children.length, 1);
	const description = h.children[0].getAllTools().find((tool) => tool.name === "Agent")?.description ?? "";
	assert.match(description, /Delegate only when the user explicitly requests/);
	assert.doesNotMatch(description, /proactive use without a separate user request/);
});

test("adapter run identity fences late events and old Stop closures across continuations", async () => {
	const engine = new FakeEngine(); let activity!: Activity;
	const adapter = new SubagentAdapter(engine, (entry) => { activity = entry; });
	engine.spawn(); const original = adapter.identity("one"); const oldStop = activity.stop!;
	engine.settle(); engine.emit({ type: "run-event", agentId: "one", runId: "r2", event: { type: "started" } });
	assert.notEqual(adapter.identity("one"), original);
	await assert.rejects(async () => { await oldStop(); }, /run has ended/);
	engine.text("stale", "one", "r1"); engine.settle("failed", "one", "r1");
	engine.emit({ type: "run-event", agentId: "one", runId: "r1", event: { type: "started" } });
	assert.equal(activity.status, "running"); assert.doesNotMatch(activity.output, /stale/);
	const currentStop = activity.stop!; adapter.dispose();
	await assert.rejects(async () => { await currentStop(); }, /run has ended/);
	assert.equal(engine.listeners.size, 0);
});

test("all full Grok entrypoints are inert in child context", async () => {
	const pi = new Proxy({}, { get(_target, name) { throw new Error(`Unexpected child registration: ${String(name)}`); } }) as ExtensionAPI;
	await runInChildScope({ agentId: "child", depth: 1 }, async () => {
		await subagents(pi); await grok(pi);
		const runtime = createGrokStyleExtension(pi, {} as never);
		const tool = { name: "custom" };
		assert.equal(runtime.styleTool(tool as never), tool);
	});
});
