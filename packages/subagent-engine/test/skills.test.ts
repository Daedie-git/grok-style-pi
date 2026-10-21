import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { loadSkills as loadPiSkills } from "@earendil-works/pi-coding-agent";
import { forkContextSkills, loadSkills, preloadSkills, skillAgentType } from "../src/skills.ts";
import { taskMessage } from "../src/context/prompt.ts";

function fixture(t: TestContext) {
	const captures = resolve(import.meta.dirname, "../../../captures");
	mkdirSync(captures, { recursive: true });
	const root = mkdtempSync(join(captures, "skills-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	return { root, agentDir, cwd };
}
function skill(path: string, name: string, extra = "", content = `Instructions for ${name}`) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `---\nname: ${name}\ndescription: Description for ${name}\n${extra}---\n\n${content}\n`);
}

test("discovery mirrors installed Pi defaults, including user-first collisions", t => {
	const { root, agentDir, cwd } = fixture(t);
	skill(join(agentDir, "skills", "user", "SKILL.md"), "user");
	skill(join(agentDir, "skills", "same", "SKILL.md"), "same", "", "user winner");
	skill(join(cwd, ".pi", "skills", "project", "SKILL.md"), "project");
	skill(join(cwd, ".pi", "skills", "same", "SKILL.md"), "same", "", "project loser");
	skill(join(cwd, ".claude", "skills", "unconfigured", "SKILL.md"), "unconfigured");
	skill(join(root, ".pi", "skills", "ancestor", "SKILL.md"), "ancestor");
	const upstream = loadPiSkills({ agentDir, cwd, includeDefaults: true, skillPaths: [] });
	const loaded = loadSkills({ agentDir, cwd, projectTrusted: true });
	assert.deepEqual(loaded.map(item => [item.name, item.path]), upstream.skills.map(item => [item.name, item.filePath]));
	assert.equal(loaded.find(item => item.name === "same")?.content, "user winner");
	assert.deepEqual(new Set(loaded.map(item => item.name)), new Set(["user", "same", "project"]));
});

test("untrusted projects do not supply skills, including a colliding trusted skill", t => {
	const { agentDir, cwd } = fixture(t);
	skill(join(agentDir, "skills", "trusted", "SKILL.md"), "trusted");
	skill(join(cwd, ".pi", "skills", "untrusted", "SKILL.md"), "untrusted", "context: fork\n");
	assert.deepEqual(loadSkills({ agentDir, cwd, projectTrusted: false }).map(item => item.name), ["trusted"]);
});

test("discovery follows Pi root Markdown, nested SKILL.md, ignore and skill-root rules", t => {
	const { agentDir, cwd } = fixture(t);
	const base = join(agentDir, "skills");
	skill(join(base, "standalone.md"), "standalone");
	skill(join(base, "deep", "nested", "SKILL.md"), "nested");
	skill(join(base, "deep", "not-a-skill.md"), "not-a-skill");
	skill(join(base, "ignored", "SKILL.md"), "ignored");
	skill(join(base, "boundary", "SKILL.md"), "boundary");
	skill(join(base, "boundary", "child", "SKILL.md"), "hidden-child");
	skill(join(base, "node_modules", "dependency", "SKILL.md"), "dependency");
	writeFileSync(join(base, ".gitignore"), "ignored/\n");
	assert.deepEqual(new Set(loadSkills({ agentDir, cwd, projectTrusted: true }).map(item => item.name)), new Set(["standalone", "nested", "boundary"]));
});

test("frontmatter preserves fresh skill-child configuration without history-fork semantics", t => {
	const { agentDir, cwd } = fixture(t);
	const path = join(agentDir, "skills", "scoped", "SKILL.md");
	skill(path, "scoped", "context: fork\nagent: Explore\nmodel: sonnet\neffort: high\nallowed-tools: [Read, Grep, 'Agent(Explore, Plan)']\ndisable-model-invocation: true\n", "Fresh skill task body");
	const [loaded] = loadSkills({ agentDir, cwd, projectTrusted: true });
	assert.deepEqual(loaded, {
		name: "scoped", path, description: "Description for scoped", content: "Fresh skill task body",
		context: "fork", agent: "Explore", model: "sonnet", effort: "high", allowedTools: ["Read", "Grep", "Agent(Explore, Plan)"], disableModelInvocation: true,
	});
	assert.equal("parentMessages" in loaded, false);
	assert.equal("isFork" in loaded, false);
});

test("allowed tools supports comma/space strings and fails closed for malformed scopes", t => {
	const { agentDir, cwd } = fixture(t);
	for (const [name, value] of [["commas", "Read, Grep, Agent(Explore, Plan)"], ["spaces", "Read Write Bash(git status)"], ["empty", "[]"], ["invalid", "42"], ["bad-list", "[Read, 42]"], ["unbalanced", "Read Agent(Explore"]]) {
		skill(join(agentDir, "skills", name, "SKILL.md"), name, `allowed-tools: ${value}\n`);
	}
	const byName = new Map(loadSkills({ agentDir, cwd, projectTrusted: true }).map(item => [item.name, item]));
	assert.deepEqual(byName.get("commas")?.allowedTools, ["Read", "Grep", "Agent(Explore, Plan)"]);
	assert.deepEqual(byName.get("spaces")?.allowedTools, ["Read", "Write", "Bash(git status)"]);
	for (const name of ["empty", "invalid", "bad-list", "unbalanced"]) assert.deepEqual(byName.get(name)?.allowedTools, []);
});

test("fork-context user selection accepts disabled-model skills, model selection excludes them", t => {
	const { agentDir, cwd } = fixture(t);
	skill(join(agentDir, "skills", "inline", "SKILL.md"), "inline");
	skill(join(agentDir, "skills", "forked", "SKILL.md"), "forked", "context: fork\n");
	skill(join(agentDir, "skills", "explicit", "SKILL.md"), "explicit", "context: fork\ndisable-model-invocation: true\n");
	const skills = loadSkills({ agentDir, cwd, projectTrusted: true });
	assert.deepEqual(new Set(forkContextSkills(skills, "user").map(item => skillAgentType(item.name))), new Set(["skill:forked", "skill:explicit"]));
	assert.deepEqual(forkContextSkills(skills, "model").map(item => skillAgentType(item.name)), ["skill:forked"]);
	assert.equal(forkContextSkills(skills, "model").some(item => item.name === "explicit"), false);
});

test("preload preserves requested order, removes duplicates and ignores unavailable skills", t => {
	const { agentDir, cwd } = fixture(t);
	skill(join(agentDir, "skills", "first", "SKILL.md"), "first", "", "First body");
	skill(join(agentDir, "skills", "second", "SKILL.md"), "second", "", "Second body");
	const skills = loadSkills({ agentDir, cwd, projectTrusted: true });
	assert.deepEqual(preloadSkills(["second", "missing", "first", "second"], skills), [{ name: "second", content: "Second body" }, { name: "first", content: "First body" }]);
	const content = taskMessage({ prompt: "Delegation first", preloadedSkills: preloadSkills(["second", "first"], skills) });
	assert.equal(content.startsWith("Delegation first"), true);
	assert.ok(content.indexOf("Second body") > content.indexOf("Delegation first"));
	assert.ok(content.indexOf("First body") > content.indexOf("Second body"));
});

test("missing directories and malformed skills do not create executable entries", t => {
	const { agentDir, cwd } = fixture(t);
	assert.deepEqual(loadSkills({ agentDir, cwd, projectTrusted: true }), []);
	const base = join(agentDir, "skills");
	mkdirSync(join(base, "broken"), { recursive: true });
	writeFileSync(join(base, "broken", "SKILL.md"), "---\ndescription: [unterminated\n---\nbody");
	mkdirSync(join(base, "undescribed"));
	writeFileSync(join(base, "undescribed", "SKILL.md"), "---\nname: undescribed\n---\nbody");
	assert.deepEqual(loadSkills({ agentDir, cwd, projectTrusted: true }), []);
});
