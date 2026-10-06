import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { herdrIntegrationEnvironment, loadSubagentExtension } from "../integrations/subagents.ts";
import { createHerdrSubagents, remoteWorkerEntry } from "../packages/herdr-subagents/src/herdr/extension.ts";
import { HerdrStore } from "../packages/herdr-subagents/src/herdr/store.ts";
import { HerdrRunner } from "../packages/herdr-subagents/src/herdr/runner.ts";
import type { HerdrClient } from "../packages/herdr-subagents/src/herdr/client.ts";
import { Worker } from "node:worker_threads";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectSubagentRuntime } from "../src/subagents/runtime.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the Grok package ships the standalone runner and both compatibility entries", { timeout: 30_000 }, () => {
	const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
	}));
	const paths = packed[0].files.map((file: { path: string }) => file.path) as string[];
	for (const path of [
		"packages/herdr-subagents/package.json", "packages/herdr-subagents/src/herdr/extension.ts",
		"packages/herdr-subagents/src/herdr/worker-entry.mjs", "packages/herdr-subagents/src/herdr/claude-hook-entry.mjs",
		"src/herdr/worker-entry.mjs", "src/herdr/claude-hook-entry.mjs",
	]) assert.ok(paths.includes(path), `${path} must ship with Grok`);
});

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

test("the extracted runner keeps Grok diamonds optional without changing execution or duplicating policy", async () => {
	const tools: ToolDefinition[] = [];
	const pi = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerMessageRenderer() {}, on() {} } as unknown as ExtensionAPI;
	const factory = createHerdrSubagents({ env: { HERDR_ENV: "1" }, listMachines: async () => [] });
	await factory(pi);
	const native = tools.splice(0);
	for (const enabled of [true, false]) {
		const captured: ToolDefinition<any, any, any>[] = [];
		const capture: ExtensionFactory = (api) => factory({ ...api, registerTool(tool) { captured.push(tool); api.registerTool(tool); } });
		await loadSubagentExtension(pi, { HERDR_ENV: "1" }, { herdr: capture, current: () => { assert.fail("wrong runner"); } }, enabled);
		assert.deepEqual(tools.map((tool) => tool.name), native.map((tool) => tool.name));
		for (const [i, tool] of tools.entries()) {
			assert.equal(tool.execute, captured[i].execute);
			assert.equal(tool.parameters, captured[i].parameters);
			assert.equal(tool.description, native[i].description);
			assert.equal(tool.renderShell, enabled && i < 2 ? "self" : undefined);
		}
		assert.equal(tools[0].description.match(/Do not call this tool unless/g)?.length, 1);
		tools.length = 0;
	}
});

test("the combined entrypoint keeps implicit remote Grok roots and respects explicit standalone overrides", () => {
	const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
	const combined = herdrIntegrationEnvironment(env);
	assert.equal(remoteWorkerEntry(combined), fileURLToPath(new URL("../src/herdr/worker-entry.mjs", import.meta.url)));
	assert.deepEqual(env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, "the caller's environment is not mutated");
	assert.equal(remoteWorkerEntry(herdrIntegrationEnvironment({ ...env, GROK_HERDR_REMOTE_PACKAGE: "/legacy" })), "/legacy/src/herdr/worker-entry.mjs");
	assert.equal(remoteWorkerEntry(herdrIntegrationEnvironment({ ...env, HERDR_SUBAGENTS_REMOTE_PACKAGE: "/standalone", GROK_HERDR_REMOTE_PACKAGE: "/legacy" })), "/standalone/src/herdr/worker-entry.mjs");
});

test("the legacy remote worker path forwards to the extracted package", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-legacy-entry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new HerdrStore((events) => {
		const worker = new Worker(new URL("../src/herdr/worker-entry.mjs", import.meta.url), {
			workerData: { root }, execArgv: ["--disable-warning=ExperimentalWarning"],
		});
		worker.on("message", events.reply);
		worker.on("error", events.fail);
		return {
			post: (request) => worker.postMessage(request),
			hold: (active) => { if (active) worker.ref(); else worker.unref(); },
			close: async () => { await worker.terminate(); },
		};
	});
	try {
		await store.assertProtocolReady();
		assert.deepEqual(await store.listAgents(), []);
	} finally { await store.close(); }
});

test("existing Claude hook commands still report results through the legacy path", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-legacy-hook-"));
	let live = false;
	let prompt = "";
	const client: HerdrClient = {
		split: async () => ({ paneId: "w1:p2" }),
		createTab: async () => ({ paneId: "w1:p2", tabId: "w1:t2" }),
		startPi: async () => { assert.fail("wrong runtime"); },
		startClaude: async () => { live = true; },
		promptAgent: async (_name, text) => { prompt = text; },
		closePane: async () => { live = false; },
		isAlive: async () => live,
		getAgent: async (name) => live ? { name, paneId: "w1:p2" } : undefined,
		showLabel: async () => {}, listAgents: async () => [], listPanes: async () => [],
	};
	const runner = new HerdrRunner({ root, client });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const ref = await runner.spawn({ runtime: "claude-code", prompt: "Review", description: "Review", subagentType: "reviewer", cwd: root, paneId: "w1:p1", runInBackground: true });
	const record = await runner.resolve(ref.agentId);
	const entry = fileURLToPath(new URL("../src/herdr/claude-hook-entry.mjs", import.meta.url));
	for (const [event, data] of [["UserPromptSubmit", { prompt }], ["Stop", { last_assistant_message: "Legacy hook result" }]] as const) {
		const result = spawnSync(process.execPath, [entry, root, record.id], {
			input: JSON.stringify({ session_id: record.sessionId, hook_event_name: event, ...data }), encoding: "utf8", timeout: 15_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
	}
	assert.equal((await runner.read(ref)).result, "Legacy hook result");
});
