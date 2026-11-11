import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGrokSubagents } from "../integrations/subagents.ts";
import { defaultFeatures } from "../src/extension/features.ts";

// Registration must preserve the runner's machine discovery even when it owns no tools.
test("combined Herdr app Agent advertises saved machines and its supported remote launch path", async (t) => {
	mkdirSync(resolve("captures"), { recursive: true });
	const root = mkdtempSync(join(resolve("captures"), "machine-guidance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		on() {}, registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {}, registerMarkdownTransformer() {},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	const features = Object.fromEntries(Object.keys(defaultFeatures).map((key) => [key, false])) as typeof defaultFeatures;
	const extension = createGrokSubagents({
		env: { HC_TERMINAL_ID: "t7", HC_BIN_PATH: join(root, "must-not-run-hc") },
		style: { features }, engine: { env: {}, agentDir: root, homeDir: root },
		herdr: { agentDir: root, listMachines: async () => [
			{ id: "linux-id", label: "linux-station-01", target: "linux-ssh", enabled: true },
			{ id: "windows-id", label: "windows-station-01", target: "windows-ssh", enabled: true },
		] },
	});
	await extension(pi);
	const agent = tools.get("Agent")!;
	assert.ok(agent);
	assert.match(agent.description, /Saved machines: linux-station-01 \(linux-ssh\), windows-station-01 \(windows-ssh\)/);
	assert.match(agent.description, /machine_cwd/);
	assert.match(agent.description, /hc ls --json/);
	assert.match(agent.description, /Do not use SSH.*launch/);
	assert.equal([...tools.keys()].filter((name) => name === "Agent").length, 1);
});
