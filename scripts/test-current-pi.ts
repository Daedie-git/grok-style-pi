import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installGrokStyle } from "../extensions/install.ts";
import { defaultFeatures } from "../src/extension/features.ts";

// Point this at a current Pi public index.js; do not resolve private installed-package files.
const entry = process.env.GROK_CURRENT_PI;
if (!entry) throw new Error("Set GROK_CURRENT_PI to the current Pi package's public dist/index.js.");
const agent = await import(pathToFileURL(entry).href);
assert.equal(typeof agent.createCodemodeExtension, "function", "this smoke test requires current codemode support");
const root = mkdtempSync(join(tmpdir(), "grok-current-pi-"));
const off = Object.fromEntries(Object.keys(defaultFeatures).map(key => [key, false])) as typeof defaultFeatures;
const theme = { fg: (_token: string, value: string) => value };
try {
	for (const enabled of [false, true]) {
		let constructions = 0, nativeExecutions = 0, styledExecutions = 0;
		const nativeFactory = agent.createCodemodeExtension({ models: false });
		const settingsManager = agent.SettingsManager.inMemory({ packages: [], extensions: [] });
		const manager = agent.SessionManager.inMemory(root);
		const loader = new agent.DefaultResourceLoader({
			cwd: root, agentDir: root, settingsManager,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [
				{ name: "codemode", factory: async (pi: any) => {
					nativeExecutions++;
					await nativeFactory(pi);
				}, replaceable: true },
				{ name: "grok-style", factory: async (pi: any) => {
					await installGrokStyle(pi, {
						features: { ...off, toolStyling: enabled },
						loadAgent: async () => ({ ...agent, createCodemodeExtension() {
							constructions++;
							const styledFactory = agent.createCodemodeExtension({ models: false });
							return async (api: any) => { styledExecutions++; await styledFactory(api); };
						} }),
					});
				} },
			],
		});
		await loader.reload();
		const { session, extensionsResult } = await agent.createAgentSession({ cwd: root, agentDir: root, settingsManager, sessionManager: manager, resourceLoader: loader });
		try {
			assert.deepEqual(extensionsResult.errors, []);
			await session.bindExtensions({ mode: "json" });
			const tool = session.getToolDefinition("codemode");
			assert.ok(tool);
			assert.equal(session.getAllTools().filter((value: any) => value.name === "codemode").length, 1);
			assert.equal(constructions, enabled ? 1 : 0);
			// Pi runs replaceable factories before deciding which registration survives.
			assert.equal(nativeExecutions, 1);
			assert.equal(styledExecutions, enabled ? 1 : 0);
			assert.equal(tool.defaultActive, false);
			assert.equal(session.getActiveToolNames().includes("codemode"), false);
			assert.equal(tool.exposure, "model-only");
			assert.equal(typeof tool.prepareLoadout, "function");
			assert.equal(tool.constrainedSampling.type, "grammar");
			if (enabled) {
				assert.equal(tool.renderShell, "self");
				assert.deepEqual(tool.renderCall({ code: 'text("test");' }, theme, {}).render(100), ["◆ codemode"]);
			} else {
				const native = agent.createCodemodeExtension({ models: false });
				let definition: any;
				await native({ registerTool(value: any) { definition = value; } });
				assert.equal(tool.renderCall, definition.renderCall);
				assert.equal(tool.renderResult, definition.renderResult);
			}
			const ctx = { tools: [], sessionManager: manager, executeTool() { throw new Error("unexpected nested tool"); } };
			const result = await tool.execute("smoke", { code: 'store("smoke", 42); text("sandbox passed");' }, undefined, undefined, ctx);
			assert.match(result.content.map((block: any) => block.text ?? "").join("\n"), /sandbox passed/);
			assert.equal(manager.getBranch().filter((value: any) => value.type === "custom" && value.customType === "codemode-store").length, 1);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	}
	console.log(`Pi ${agent.VERSION}: enabled/disabled styling, native renderer, activation, registration, sandbox, and store passed.`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
