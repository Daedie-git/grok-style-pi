import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childInstaller } from "../src/child-installer.ts";
import type { Caller, Engine } from "../src/engine.ts";

test("live memory disablement revokes only memory-scoped child tools", async () => {
	type ToolCall = { toolName: string; input: Record<string, unknown> };
	type Gate = (event: ToolCall) => Promise<{ block: boolean; reason?: string } | undefined>;
	let gate: Gate | undefined;
	let enabled = true;
	let guardCalls = 0;
	const engine = {
		control: new Map(),
		hookEnvironment: () => ({ agentDir: "/unused", projectTrusted: false, env: {} }),
		toolRevocation: async () => undefined,
		memoryEnabled: () => enabled,
	} as unknown as Engine;
	const caller: Caller = {
		agentId: "child",
		depth: 1,
		background: true,
		isFork: false,
		allowedTools: new Set(["read", "write", "edit"]),
		memoryScoped: ["write", "edit"],
		memoryGuard: (_name, input) => {
			guardCalls++;
			return input.path === "/memory/topic.md" ? undefined : "Outside memory directory.";
		},
	};
	const pi = {
		registerTool() {},
		on(name: string, handler: Gate) { if (name === "tool_call") gate = handler; },
	} as unknown as ExtensionAPI;
	childInstaller(() => ({ autonomy: "explicit", forkEnabled: false, offered: [], exploreAvailable: false }))(engine, caller)(pi);
	assert.ok(gate);
	const call = (toolName: string, path = "/memory/topic.md") => gate!({ toolName, input: { path } });
	assert.equal(await call("write"), undefined);
	assert.equal(guardCalls, 1);
	assert.deepEqual(await call("write", "/outside.md"), { block: true, reason: "Outside memory directory." });

	enabled = false;
	for (const name of ["write", "edit"]) {
		assert.deepEqual(await call(name), { block: true, reason: "Persistent agent memory is disabled." });
	}
	assert.equal(guardCalls, 2);
	assert.equal(await call("read", "/ordinary-project-file.ts"), undefined);
	assert.deepEqual(await call("bash"), { block: true, reason: "This agent is not allowed to use that tool." });
	// Disablement cannot depend on the optional path guard being present.
	caller.memoryGuard = undefined;
	assert.equal((await call("write"))?.block, true);
	enabled = true;
	assert.equal(await call("write"), undefined);
});
