import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_ALLOWED, compileToolSurface, type SurfaceInput, type ToolLite } from "../src/context/capabilities.ts";
import type { AgentDefinition } from "../src/types.ts";

const definition: AgentDefinition = {
	agentType: "custom", description: "test", prompt: "test", source: "user",
	disallowedTools: [], skills: [], diagnostics: [],
};
const available: ToolLite[] = [
	...['read', 'grep', 'find', 'ls', 'bash', 'powershell', 'edit', 'write', 'Agent',
		'SendMessage', 'TaskList', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskUpdate',
		'TaskClaim', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'SlashCommand', '/skill:run', 'custom'].map((name) => ({ name })),
	{ name: "mcp__repo__search" }, { name: "mcp__repo__fetch" },
	{ name: "otherLookup", mcpServer: "other" }, { name: "pluginMcp", source: "mcp" },
];
function surface(overrides: Partial<SurfaceInput> = {}, changes: Partial<AgentDefinition> = {}) {
	return compileToolSurface({ definition: { ...definition, ...changes }, available, depth: 1,
		maxDepth: 3, background: false, isFork: false, ...overrides });
}

test("an isolated definition keeps only built-in tools, even when it grants others", () => {
	assert.deepEqual(surface({}, { isolated: true }).active.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	assert.deepEqual(surface({}, { isolated: true, tools: ["read", "Agent", "mcp__repo"] }).active, ["read"]);
});

test("foreground inherits the available non-main-thread pool, with an exact exclusion complement", () => {
	const result = surface();
	assert(result.active.includes("TaskCreate"));
	assert(result.active.includes("custom"));
	assert(result.active.includes("Agent"));
	assert.deepEqual(result.excluded, ['TaskClaim', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'SlashCommand', '/skill:run']);
	assert.deepEqual(result.invalid, []);
	assert.deepEqual(result.unavailable, []);
});

test("background keeps Agent before applying its allow set, plus MCP, TaskList and TaskStop", () => {
	const result = surface({ background: true });
	assert.deepEqual(result.active, available.filter((tool) => BACKGROUND_ALLOWED.has(tool.name) ||
		tool.name === "Agent" || tool.name.startsWith("mcp__") || tool.mcpServer || tool.source === "mcp").map((tool) => tool.name));
	for (const name of ["TaskCreate", "TaskGet", "TaskUpdate", "custom"]) assert(!result.active.includes(name));
	for (const background of [false, true]) for (const depth of [3, 4]) {
		assert(!surface({ background, depth }).active.includes("Agent"));
	}
});

test("aliases select Pi tools, while empty and wildcard selections stay distinct", () => {
	assert.deepEqual(surface({}, { tools: [] }).active, []);
	assert.deepEqual(surface({}, { tools: ["*", "Read"] }).active, surface().active);
	assert.deepEqual(surface({}, { tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob", "LS", "PowerShell"] }).active,
		["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
});

test("denies win over inherited, explicit and memory grants", () => {
	for (const tools of [undefined, ["*"], ["Read", "Write", "Agent(a)", "mcp__repo"]]) {
		const result = surface({ memoryTools: ["read", "Write", "mcp__repo__search", "Agent"] }, {
			tools, disallowedTools: ["Read", "write", "Agent(blocked)", "mcp__repo"],
		});
		for (const name of ["read", "write", "Agent", "mcp__repo__search", "mcp__repo__fetch"]) assert(!result.active.includes(name));
		assert.deepEqual(result.memoryScoped, []);
		assert.equal(result.allowedAgentTypes, undefined);
	}
	assert.deepEqual(surface({}, { tools: ["Read"], disallowedTools: ["*"] }).active, []);
});

test("Agent type grants union, but plain Agent or inheritance grants unrestricted types", () => {
	const result = surface({}, { tools: ["Agent(a, b)", "Agent(b,c)"] });
	assert.deepEqual(result.active, ["Agent"]);
	assert.deepEqual(result.allowedAgentTypes, ["a", "b", "c"]);
	assert.equal(surface({}, { tools: ["Agent(a)", "Agent"] }).allowedAgentTypes, undefined);
	assert.equal(surface({}, { tools: ["*", "Agent(a)"] }).allowedAgentTypes, undefined);
	assert.deepEqual(surface({ depth: 3 }, { tools: ["Agent(a)"] }).unavailable, ["Agent(a)"]);
});

test("MCP server expansion uses names and server metadata, with server and individual denies", () => {
	assert.deepEqual(surface({}, { tools: ["mcp__repo", "mcp__other"] }).active,
		["mcp__repo__search", "mcp__repo__fetch", "otherLookup"]);
	assert.deepEqual(surface({}, { tools: ["mcp__repo"], disallowedTools: ["mcp__repo__fetch"] }).active, ["mcp__repo__search"]);
	assert.deepEqual(surface({}, { tools: ["mcp__repo__search"], disallowedTools: ["mcp__repo"] }).active, []);
	assert.deepEqual(surface({ available: [{ name: "mcp__my_server__lookup" }] }, { tools: ["mcp__my_server"] }).active, ["mcp__my_server__lookup"]);
});

test("diagnostics distinguish invalid, recognized absent, and currently filtered tools", () => {
	const result = surface({ background: true }, { tools: ["nonesuch", "nonesuch", "NotebookEdit", "TaskCreate", "mcp__missing", "mcp__repo__absent"] });
	assert.deepEqual(result.active, []);
	assert.deepEqual(result.invalid, ["nonesuch"]);
	assert.deepEqual(result.unavailable, ["NotebookEdit", "TaskCreate", "mcp__missing", "mcp__repo__absent"]);
	assert.deepEqual(surface({ available: [] }, { tools: ["Read", "read", "Agent", "TaskList"] }).unavailable, ["Read", "read", "Agent", "TaskList"]);
});

test("memory grants are additive and only newly granted tools become scoped", () => {
	const result = surface({ memoryTools: ["Read", "Write", "Write", "Edit"] }, { tools: ["Read"], disallowedTools: ["Edit"] });
	assert.deepEqual(result.active, ["read", "write"]);
	assert.deepEqual(result.memoryScoped, ["write"]);
	assert(!result.excluded.includes("write"));
	assert.deepEqual(surface({ depth: 3, background: true, memoryTools: ["Agent", "TaskCreate"] }, { tools: [] }).active, []);
});

test("fork preserves exact parent order and unknown names despite depth, background and denies", () => {
	const parentTools = ["custom", "Agent", "TaskCreate", "runtimeOnly", "/skill:run", "custom"];
	const result = surface({ isFork: true, parentTools, depth: 9, background: true, memoryTools: ["write"] },
		{ tools: [], disallowedTools: ["*"] });
	assert.deepEqual(result.active, parentTools);
	assert.notEqual(result.active, parentTools);
	assert.deepEqual(result.unavailable, ["runtimeOnly"]);
	assert.deepEqual(result.memoryScoped, []);
	assert.equal(result.allowedAgentTypes, undefined);
	assert.deepEqual(surface({ isFork: true }).active, []);
});
