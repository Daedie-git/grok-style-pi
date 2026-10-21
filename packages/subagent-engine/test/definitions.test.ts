import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { builtInDefinitions, FORK_DIRECTIVE } from "../src/definitions/builtins.ts";
import { discoverDefinitions, selectDefinition } from "../src/definitions/discovery.ts";
import type { DiscoveryOptions } from "../src/definitions/discovery.ts";
import { parseDefinitionFile } from "../src/definitions/parse.ts";
import type { DefinitionSource } from "../src/types.ts";

const markdown = (name: string, description = "description", fields = "", body = "Prompt body.") => `---\nname: ${name}\ndescription: ${description}\n${fields}---\n${body}\n`;
function parse(fields = "", source: DefinitionSource = "user") {
	const result = parseDefinitionFile(markdown("example", "Example agent", fields), { source, namespace: "plugin:sample" });
	assert.equal(result.error, undefined);
	assert.ok(result.definition);
	return result.definition;
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	// Scratch files remain inside the project's ignored captures tree, including on Windows.
	const scratch = join(process.cwd(), "captures");
	await mkdir(scratch, { recursive: true });
	const root = await mkdtemp(join(scratch, "definitions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project", "deep");
	const agentDir = join(root, "user");
	await mkdir(cwd, { recursive: true });
	const options: DiscoveryOptions = { cwd, agentDir, homeDir: root, projectTrusted: true, forkEnabled: true };
	const file = async (dir: string, name: string, content: string) => {
		await mkdir(dir, { recursive: true });
		const path = join(dir, name);
		await writeFile(path, content);
		return path;
	};
	return { root, cwd, agentDir, options, file };
}

test("tools distinguish inherited, wildcard and explicit empty, preserving Agent(a, b)", () => {
	assert.equal(parse().tools, undefined);
	assert.deepEqual(parse("tools: []\n").tools, []);
	assert.deepEqual(parse("tools: '*'\n").tools, ["*"]);
	assert.deepEqual(parse("tools: [Read, '*', Agent(a, b), Bash]\n").tools, ["Read", "*", "Agent(a, b)", "Bash"]);
	assert.deepEqual(parse("tools: Read, Agent(a, b), Write\n").tools, ["Read", "Agent(a, b)", "Write"]);
	assert.deepEqual(parse("tools:\n  - Read\n  - Agent(a, b)\ndisallowedTools: Edit, Write\nskills: [one, two]\n").tools, ["Read", "Agent(a, b)"]);
	assert.deepEqual(parse("disallowedTools: Edit, Agent(a,b)\n").disallowedTools, ["Edit", "Agent(a,b)"]);
});

test("BOM, CRLF, trimmed body and quoted scalars", () => {
	const result = parseDefinitionFile("\uFEFF" + markdown("'my agent'", '"A: description"', "", "\uFEFF  body  \n\n").replaceAll("\n", "\r\n"), { source: "project", path: "/agent.md" });
	assert.equal(result.definition?.agentType, "my agent");
	assert.equal(result.definition?.description, "A: description");
	assert.equal(result.definition?.prompt, "body");
	assert.equal(result.definition?.path, "/agent.md");
});

test("required fields and invalid names fail validation", () => {
	for (const text of ["no frontmatter", "---\nname: x\n---\nprompt", markdown("-bad"), markdown("reserved:name"), markdown("x".repeat(65)), markdown("123"), markdown("x", "[]"), markdown("''")]) {
		assert.ok(parseDefinitionFile(text, { source: "user" }).error, text);
	}
	assert.ok(parseDefinitionFile(markdown("x".repeat(64)), { source: "user" }).definition);
});

test("supported metadata and unsupported values produce diagnostics", () => {
	const definition = parse("model: InHeRiT\nthinking: high\nbackground: true\nomitClaudeMd: false\nmaxTurns: 4\nisolation: worktree\nmemory: local\ncolor: green\npermissionMode: bypassPermissions\n");
	assert.equal(definition.model, "inherit");
	assert.equal(definition.effort, "high");
	assert.equal(definition.background, true);
	assert.equal(definition.omitClaudeMd, false);
	assert.equal(definition.maxTurns, 4);
	assert.equal(definition.memory, "local");
	assert.equal(definition.isolation, "worktree");
	assert.equal(definition.permissionMode, "bypassPermissions");
	assert.match(definition.diagnostics.join("\n"), /permissionMode.*unsupported/);
	const bad = parse("maxTurns: 0\nbackground: 'true'\nomitClaudeMd: yes\nisolation: remote\nmemory: other\n");
	assert.equal(bad.maxTurns, undefined);
	assert.equal(bad.background, undefined);
	assert.equal(bad.isolation, undefined);
	assert.equal(bad.memory, undefined);
	assert.equal(bad.diagnostics.length, 5);
	assert.equal(parse("maxTurns: 1.5\n").maxTurns, undefined);
	assert.equal(parse("effort: low\nthinking: high\n").effort, "low");
});

test("package names are namespaced and privileged fields are ignored", () => {
	const definition = parse("hooks: nonsense\nmcpServers: [server]\npermissionMode: bypassPermissions\nomitClaudeMd: true\n", "package");
	assert.equal(definition.agentType, "plugin:sample:example");
	assert.equal(definition.hooks, undefined);
	assert.equal(definition.mcpServers, undefined);
	assert.equal(definition.permissionMode, undefined);
	assert.equal(definition.omitClaudeMd, true);
	assert.equal(definition.diagnostics.length, 3);
	assert.ok(parseDefinitionFile(markdown("example"), { source: "package" }).error);
	assert.ok(parseDefinitionFile(markdown("bad:name"), { source: "package", namespace: "pkg" }).error);
});

test("parse command hooks from JSON and nested YAML, rejecting other hook types", () => {
	const json = parse('hooks: {"SubagentStart":[{"matcher":"*","hooks":[{"type":"command","command":"echo start","args":["one"],"timeout":2}]}]}\n');
	assert.equal(json.hooks?.SubagentStart?.[0].hooks[0].command, "echo start");
	assert.deepEqual(json.hooks?.SubagentStart?.[0].hooks[0].args, ["one"]);
	const yaml = parse("hooks:\n  SubagentStop:\n    - hooks:\n        - type: command\n          command: echo stop\n        - type: prompt\n          prompt: unsafe\n");
	assert.equal(yaml.hooks?.SubagentStop?.[0].hooks.length, 1);
	assert.equal(yaml.hooks?.SubagentStop?.[0].hooks[0].command, "echo stop");
	assert.match(yaml.diagnostics.join("\n"), /only command/);
	assert.match(parse("hooks: nonsense\n").diagnostics.join("\n"), /hooks must be a mapping/);
	assert.ok(parseDefinitionFile(markdown("test", "desc", "tools: [unterminated\n"), { source: "user" }).error);
});

test("MCP names, named inline configurations, and folded descriptions", () => {
	assert.deepEqual(parse("mcpServers: [alpha, beta]\n").mcpServers, ["alpha", "beta"]);
	const servers = parse('mcpServers: ["alpha", {"server":{"command":"node","args":["server.js"]}}, {"name":"other","config":{"url":"https://example.org"}}]\n').mcpServers;
	assert.equal(servers?.length, 3);
	assert.deepEqual(servers?.[1], { name: "server", config: { command: "node", args: ["server.js"] } });
	const yaml = parse("mcpServers:\n  - server:\n      command: node\n      args: [server.js]\n");
	assert.equal(yaml.mcpServers?.length, 1);
	const folded = parseDefinitionFile("---\nname: test\ndescription: >\n  first line\n  second line\n---\nprompt", { source: "user" });
	assert.equal(folded.definition?.description, "first line second line");
});

test("built-ins expose immutable-by-call contracts and gated fork", () => {
	const definitions = builtInDefinitions({ forkEnabled: true });
	assert.deepEqual(definitions.map((d) => d.agentType), ["general-purpose", "Explore", "Plan", "fork"]);
	assert.equal(definitions[0].tools, undefined);
	for (const name of ["Explore", "Plan"]) {
		const definition = definitions.find((d) => d.agentType === name)!;
		assert.deepEqual(definition.disallowedTools, ["edit", "write", "Agent"]);
		assert.equal(definition.omitClaudeMd, true);
		assert.match(definition.prompt, /not a read-only security guarantee/);
	}
	assert.match(definitions[1].prompt, /quick.*medium.*very thorough/);
	assert.match(definitions[2].prompt, /3–5 critical file paths/);
	assert.equal(definitions[3].maxTurns, 200);
	assert.equal(definitions[3].model, "inherit");
	assert.equal(builtInDefinitions({ forkEnabled: false }).some((d) => d.agentType === "fork"), false);
	definitions[1].disallowedTools.push("read");
	assert.deepEqual(builtInDefinitions({ forkEnabled: true })[1].disallowedTools, ["edit", "write", "Agent"]);
	assert.match(FORK_DIRECTIVE("MY TASK"), /MY TASK/);
	assert.match(FORK_DIRECTIVE("task"), /never delegate/);
	assert.match(FORK_DIRECTIVE("task"), /hashes/);
});

test("discovery applies every source in priority order and retains package namespace", async (t) => {
	const { root, cwd, agentDir, options, file } = await fixture(t);
	const packageDir = join(root, "package");
	const policyDir = join(root, "policy");
	await file(packageDir, "agent.md", markdown("general-purpose", "package"));
	await file(join(agentDir, "agents"), "agent.md", markdown("general-purpose", "user"));
	await file(join(cwd, ".pi/agents"), "agent.md", markdown("general-purpose", "project"));
	await file(policyDir, "agent.md", markdown("general-purpose", "policy"));
	const packageOptions = { ...options, packageDirs: [{ dir: packageDir, namespace: "pkg" }] };
	let set = await discoverDefinitions({ ...packageOptions, projectTrusted: false });
	assert.equal(set.active.get("general-purpose")?.description, "user");
	assert.equal(set.active.get("pkg:general-purpose")?.description, "package");
	set = await discoverDefinitions(packageOptions);
	assert.equal(set.active.get("general-purpose")?.source, "project");
	const flagJson = JSON.stringify({ "general-purpose": { description: "flag", prompt: "flag prompt", tools: [] } });
	set = await discoverDefinitions({ ...packageOptions, flagJson });
	assert.equal(set.active.get("general-purpose")?.source, "flag");
	assert.deepEqual(set.active.get("general-purpose")?.tools, []);
	set = await discoverDefinitions({ ...packageOptions, flagJson, policyDir });
	assert.equal(set.active.get("general-purpose")?.source, "policy");
	assert.equal(set.active.get("general-purpose")?.description, "policy");
	assert.deepEqual(set.list.map((d) => d.agentType), [...set.active.keys()].sort());
});

test("ancestors are shallow-to-deep, additional directories first, home inclusive", async (t) => {
	const { root, cwd, options, file } = await fixture(t);
	const extra = join(root, "additional");
	await file(join(extra, ".pi/agents"), "a.md", markdown("order", "additional"));
	await file(join(root, ".pi/agents"), "a.md", markdown("order", "home"));
	await file(join(root, "project", ".claude/agents"), "a.md", markdown("order", "parent"));
	const deep = await file(join(cwd, ".agents/agents"), "a.md", markdown("order", "deep"));
	let set = await discoverDefinitions({ ...options, additionalDirs: [extra] });
	assert.equal(set.active.get("order")?.description, "deep");
	await rm(deep);
	set = await discoverDefinitions({ ...options, additionalDirs: [extra] });
	assert.equal(set.active.get("order")?.description, "parent");
	await rm(join(root, "project", ".claude/agents/a.md"));
	set = await discoverDefinitions({ ...options, additionalDirs: [extra] });
	assert.equal(set.active.get("order")?.description, "home");
});

test("home boundary excludes shallower ancestors and directory families override in order", async (t) => {
	const { root, cwd, options, file } = await fixture(t);
	await file(join(root, ".pi/agents"), "outside.md", markdown("outside-home"));
	for (const [directory, label] of [[".pi/agents", "pi"], [".claude/agents", "claude"], [".agents/agents", "agents"]]) {
		await file(join(cwd, directory), "a.md", markdown("same", label));
	}
	await file(join(cwd, ".agents/agents"), "z.md", markdown("same", "last filename"));
	const set = await discoverDefinitions({ ...options, homeDir: join(root, "project") });
	assert.equal(set.active.has("outside-home"), false);
	assert.equal(set.active.get("same")?.description, "last filename");
	assert.equal(set.active.get("general-purpose")?.builtIn, "general-purpose");
	assert.equal((await discoverDefinitions({ ...options, forkEnabled: false })).active.has("fork"), false);
});

test("untrusted projects skip ancestors and additional dirs but keep user and flag sources", async (t) => {
	const { root, cwd, agentDir, options, file } = await fixture(t);
	await file(join(root, ".pi/agents"), "home.md", markdown("home-only"));
	await file(join(cwd, ".claude/agents"), "deep.md", markdown("deep-only"));
	await file(join(root, "extra/.agents/agents"), "extra.md", markdown("extra-only"));
	await file(join(agentDir, "agents"), "user.md", markdown("user-only"));
	const set = await discoverDefinitions({ ...options, projectTrusted: false, additionalDirs: [join(root, "extra")], flagJson: '{"flag-only":{"description":"flag"}}' });
	for (const name of ["home-only", "deep-only", "extra-only"]) assert.equal(set.active.has(name), false);
	assert.equal(set.active.has("user-only"), true);
	assert.equal(set.active.has("flag-only"), true);
});

test("exact selection precedes normalized selection and ambiguous errors list candidates", async (t) => {
	const { options } = await fixture(t);
	const set = await discoverDefinitions({ ...options, flagJson: JSON.stringify({ "My_Agent": { description: "one" }, "my-agent": { description: "two" }, "Other Agent": { description: "three" } }) });
	assert.equal(selectDefinition(set, "My_Agent").definition?.description, "one");
	assert.equal(selectDefinition(set, "my-agent").definition?.description, "two");
	assert.equal(selectDefinition(set, "OTHER_AGENT").definition?.agentType, "Other Agent");
	const ambiguous = selectDefinition(set, "MY AGENT");
	assert.match(ambiguous.error!, /Ambiguous.*My_Agent.*my-agent/);
	assert.match(selectDefinition(set, "missing").error!, /Unknown/);
});

test("user and project fork collision replaces the built-in without fork semantics", async (t) => {
	const { cwd, agentDir, options, file } = await fixture(t);
	await file(join(agentDir, "agents"), "fork.md", markdown("fork", "user fork"));
	let set = await discoverDefinitions(options);
	assert.equal(set.active.get("fork")?.builtIn, undefined);
	assert.equal(set.active.get("fork")?.maxTurns, undefined);
	assert.match(set.diagnostics.join("\n"), /Built-in fork removed/);
	await file(join(cwd, ".pi/agents"), "fork.md", markdown("fork", "project fork"));
	set = await discoverDefinitions(options);
	assert.equal(set.active.get("fork")?.source, "project");
	assert.equal(set.active.get("fork")?.builtIn, undefined);
});

test("duplicate paths/inodes are diagnosed and revision tracks only active definitions", async (t) => {
	const { cwd, agentDir, options, file } = await fixture(t);
	await file(join(cwd, ".pi/agents"), "a.md", markdown("active", "first"));
	const userFile = await file(join(agentDir, "agents"), "user.md", markdown("linked", "user"));
	await link(userFile, join(cwd, ".pi/agents", "linked.md"));
	const duplicateOptions = { ...options, additionalDirs: [cwd] };
	const first = await discoverDefinitions(duplicateOptions);
	assert.equal(first.active.get("linked")?.source, "user");
	assert.match(first.diagnostics.join("\n"), /Duplicate definition file/);
	assert.equal((await discoverDefinitions(duplicateOptions)).revision, first.revision);
	await file(join(cwd, ".pi/agents"), "a.md", markdown("active", "changed"));
	assert.notEqual((await discoverDefinitions(duplicateOptions)).revision, first.revision);
	const flagJson = '{"active":{"description":"fixed"}}';
	const overridden = await discoverDefinitions({ ...options, flagJson });
	await file(join(cwd, ".pi/agents"), "a.md", markdown("active", "irrelevant change"));
	assert.equal((await discoverDefinitions({ ...options, flagJson })).revision, overridden.revision);
});

test("revision is independent of JSON configuration key order", async (t) => {
	const { options } = await fixture(t);
	const first = await discoverDefinitions({ ...options, flagJson: '{"custom":{"description":"custom","mcpServers":[{"svc":{"command":"node","args":[]}}]}}' });
	const second = await discoverDefinitions({ ...options, flagJson: '{"custom":{"mcpServers":[{"svc":{"args":[],"command":"node"}}],"description":"custom"}}' });
	assert.equal(first.revision, second.revision);
});

test("malformed files and flags produce diagnostics without blocking valid definitions", async (t) => {
	const { agentDir, options, file } = await fixture(t);
	await file(join(agentDir, "agents"), "bad.md", "bad");
	await file(join(agentDir, "agents"), "good.md", markdown("good"));
	const set = await discoverDefinitions({ ...options, flagJson: "not JSON" });
	assert.equal(set.active.has("good"), true);
	assert.match(set.diagnostics.join("\n"), /bad.md/);
	assert.match(set.diagnostics.join("\n"), /Invalid --agents JSON/);
	const array = await discoverDefinitions({ ...options, flagJson: '[{"name":"array","description":"ok","model":"INHERIT"}]' });
	assert.equal(array.active.get("array")?.model, "inherit");
});
