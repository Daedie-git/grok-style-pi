import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import test from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import standalone from "../extensions/index.ts";
import { herdrSubagentRoot } from "../src/herdr/store.ts";

function environment(t: { after(fn: () => void): void }, inside: boolean) {
	const before = { HERDR_ENV: process.env.HERDR_ENV, HERDR_BIN_PATH: process.env.HERDR_BIN_PATH };
	process.env.HERDR_ENV = inside ? "1" : "0";
	process.env.HERDR_BIN_PATH = join(tmpdir(), "missing-herdr-for-package-test");
	t.after(() => {
		for (const [key, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

function registration() {
	const tools: ToolDefinition[] = [];
	const events: string[] = [];
	// No Grok factories, theme, UI methods, or in-process subagent manager are supplied.
	const pi = {
		registerTool(tool: ToolDefinition) { tools.push(tool); },
		on(name: string) { events.push(name); },
	} as unknown as ExtensionAPI;
	return { pi, tools, events };
}

test("standalone loading outside Herdr registers nothing", async (t) => {
	environment(t, false);
	const { pi, tools, events } = registration();
	await standalone(pi);
	assert.deepEqual(tools, []);
	assert.deepEqual(events, []);
});

test("standalone loading preserves tools, child lifecycle, explicit-request policy, and state location", async (t) => {
	environment(t, true);
	const { pi, tools, events } = registration();
	await standalone(pi);
	assert.deepEqual(tools.map((tool) => tool.name), ["Agent", "get_subagent_result", "steer_subagent"]);
	assert.match(tools[0].description, /^Do not call this tool unless the user explicitly asked/);
	assert.ok(events.includes("session_start"));
	assert.ok(events.includes("session_shutdown"));
	assert.ok(events.includes("agent_settled"));
	assert.ok(events.includes("tool_call"));
	for (const tool of tools) {
		assert.equal(tool.renderCall, undefined);
		assert.equal(tool.renderResult, undefined);
		assert.equal(tool.renderShell, undefined);
	}
	assert.equal(herdrSubagentRoot({ XDG_STATE_HOME: "/state" }), join("/state", "grok-style-pi", "herdr-subagents"));
});

test("the packed standalone package loads and runs its worker with only its own dependencies and the Pi host", { timeout: 60_000 }, async (t) => {
	environment(t, true);
	const root = mkdtempSync(join(tmpdir(), "herdr-standalone-pack-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = fileURLToPath(new URL("..", import.meta.url));
	const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: source, encoding: "utf8" }));
	const paths = packed[0].files.map((file: { path: string }) => file.path) as string[];
	assert.ok(paths.includes("extensions/index.ts"));
	assert.ok(paths.includes("src/herdr/worker-entry.mjs"));
	assert.ok(paths.includes("src/herdr/claude-hook-entry.mjs"));
	assert.ok(paths.includes("LICENSE"));
	assert.ok(paths.includes("README.md"));
	assert.ok(paths.every((path) => !path.startsWith("test/") && !path.startsWith("src/chrome/")));
	const modules = join(root, "node_modules");
	const pkg = join(modules, "herdr-subagents");
	mkdirSync(pkg, { recursive: true });
	execFileSync("tar", ["-xzf", join(root, packed[0].filename), "--strip-components=1", "-C", pkg]);
	const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
	assert.equal(manifest.dependencies["grok-style-pi"], undefined);
	assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
	for (const dependency of [...Object.keys(manifest.dependencies), "@earendil-works/pi-coding-agent"]) {
		const destination = join(modules, dependency);
		mkdirSync(dirname(destination), { recursive: true });
		let origin = dirname(fileURLToPath(import.meta.resolve(dependency)));
		while (!existsSync(join(origin, "package.json")) || JSON.parse(readFileSync(join(origin, "package.json"), "utf8")).name !== dependency) {
			assert.notEqual(dirname(origin), origin, `package root for ${dependency} was not found`);
			origin = dirname(origin);
		}
		symlinkSync(origin, destination, "dir");
	}
	const jiti = createJiti(import.meta.url);
	const entry = await jiti.import<{ default: ExtensionFactory }>(join(pkg, "extensions/index.ts"));
	const { pi, tools } = registration();
	await entry.default(pi);
	assert.deepEqual(tools.map((tool) => tool.name), ["Agent", "get_subagent_result", "steer_subagent"]);
	const { HerdrStore } = await jiti.import<typeof import("../src/herdr/store.ts")>(join(pkg, "src/herdr/store.ts"));
	const store = new HerdrStore(join(root, "state"));
	try {
		await store.assertProtocolReady();
		assert.deepEqual(await store.listAgents(), []);
	} finally { await store.close(); }
});
