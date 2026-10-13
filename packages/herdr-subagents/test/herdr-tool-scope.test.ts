import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, getModel, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHerdrSubagents } from "../src/herdr/extension.ts";
import { HerdrRunner } from "../src/herdr/runner.ts";
import type { HerdrClient } from "../src/herdr/client.ts";

test("real Pi nested calls obey Herdr scope without activating allowed deferred tools", { timeout: 15_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const root = mkdtempSync(join(tmpdir(), "herdr-scope-"));
	const client = {
		isAlive: async () => false, listAgents: async () => [], listPanes: async () => [],
		createTab: async () => ({ paneId: "child", tabId: "tab" }), startPi: async () => {}, showLabel: async () => {},
	} as unknown as HerdrClient;
	const runner = new HerdrRunner({ root, client });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	writeFileSync(join(root, ".pi", "agents", "scope.md"), "---\ntools: bridge,allowed_deferred\n---\nTask");
	const ref = await runner.spawn({ prompt: "Task", description: "Scope test", subagentType: "scope", cwd: root, paneId: "parent", runInBackground: true });
	const record = await runner.resolve(ref.agentId);
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let forbiddenCalls = 0;
	let nestedResult: any;
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			createHerdrSubagents({ root, client, agentDir: root, env: { HERDR_PANE_ID: "child" }, listMachines: async () => [] }),
			(pi) => {
				pi.registerTool({ name: "bridge", label: "Bridge", description: "Test nested tool", parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						nestedResult = await ctx.executeTool("forbidden", {});
						return { content: [{ type: "text", text: "Checked nested scope" }], details: undefined };
					} });
				for (const name of ["forbidden", "allowed_deferred"]) pi.registerTool({ name, label: name, description: name,
					exposure: "deferred", parameters: Type.Object({}), async execute() {
						forbiddenCalls++;
						return { content: [{ type: "text", text: "Must not run" }], details: undefined };
					} });
			},
		],
	});
	await loader.reload();
	const { session, extensionsResult } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
		model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager: settings,
		sessionManager: SessionManager.open(record.sessionFile), resourceLoader: loader });
	t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
	assert.deepEqual(extensionsResult.errors, []);
	let requests = 0;
	session.agent.streamFunction = (model) => {
		const stream = createAssistantMessageEventStream();
		const first = requests++ === 0;
		const message: AssistantMessage = { role: "assistant", content: first ? [{ type: "toolCall", id: "bridge-call", name: "bridge", arguments: {} }] : [{ type: "text", text: "Done" }],
			api: model.api, provider: model.provider, model: model.id, stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); });
		return stream;
	};
	await session.bindExtensions({ mode: "json" });
	await session.prompt("Check scope", { source: "extension" });
	assert.equal(forbiddenCalls, 0);
	assert.ok(nestedResult, JSON.stringify(session.messages));
	assert.equal(nestedResult.isError, true);
	assert.match(JSON.stringify(nestedResult.result.content), /not allowed to use that tool/);
	assert.deepEqual(session.getActiveToolNames(), ["bridge"]);
});
