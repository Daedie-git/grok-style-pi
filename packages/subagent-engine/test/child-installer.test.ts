import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childInstaller } from "../src/child-installer.ts";
import { claudeConfig, protectedRoots } from "../src/claude-memory/location.ts";
import { claudeMemoryWriteBlock } from "../src/claude-memory/recall.ts";
import type { Caller, Engine } from "../src/engine.ts";

test("children may read Claude memory but never write it", async () => {
	type ToolCall = { toolName: string; input: Record<string, unknown> };
	type Gate = (event: ToolCall) => Promise<{ block: boolean; reason?: string } | undefined>;
	let gate: Gate | undefined;
	const env = {};
	const engine = {
		control: new Map(),
		hookEnvironment: () => ({ agentDir: "/unused", projectTrusted: false, env: {} }),
		toolRevocation: async () => undefined,
		memoryWriteBlock: (_agentId: string, toolName: string, input: unknown) => claudeMemoryWriteBlock(toolName, input, "/repo", protectedRoots(claudeConfig(env, "/home/person"), [])),
	} as unknown as Engine;
	const caller: Caller = { agentId: "child", depth: 1, background: true, isFork: false, allowedTools: new Set(["read", "write", "edit", "bash"]) };
	const pi = {
		registerTool() {},
		on(name: string, handler: Gate) { if (name === "tool_call") gate = handler; },
	} as unknown as ExtensionAPI;
	childInstaller(() => ({ autonomy: "explicit", forkEnabled: false, offered: [], exploreAvailable: false }))(engine, caller)(pi);
	assert.ok(gate);
	const memory = "/home/person/.claude/projects/-repo/memory/topic.md";
	assert.equal(await gate!({ toolName: "read", input: { path: memory } }), undefined);
	for (const toolName of ["write", "edit"]) assert.equal((await gate!({ toolName, input: { path: memory } }))?.block, true);
	assert.equal((await gate!({ toolName: "write", input: { path: "/home/person/.claude/agent-memory/reviewer/MEMORY.md" } }))?.block, true);
	assert.equal((await gate!({ toolName: "bash", input: { command: `echo note >> ${memory}` } }))?.block, true);
	assert.equal(await gate!({ toolName: "write", input: { path: "/repo/notes.md" } }), undefined);
	assert.equal(await gate!({ toolName: "bash", input: { command: "ls ~/.claude/projects" } }), undefined);
});
