import { test } from "node:test";
import assert from "node:assert/strict";
import { childSystemPrompt, contextFilePolicy, taskMessage } from "../src/context/prompt.ts";
import { builtInDefinitions } from "../src/definitions/builtins.ts";
import type { AgentDefinition, DefinitionSource } from "../src/types.ts";

const definition: AgentDefinition = {
	agentType: "worker", description: "Do work", prompt: "Solve the assigned problem.", source: "user",
	disallowedTools: [], skills: [], diagnostics: [],
};

test("child wrapper preserves the role and states authority, environment, messages and final handback", () => {
	const text = childSystemPrompt({ definition, cwd: "C:\\work\\project", isBackground: true });
	for (const required of [definition.prompt, 'Working directory: "C:\\\\work\\\\project"', "Execution: background",
		"absolute file paths", "not user consent", "permissions, configuration, or instruction files", "AGENTS.md", "CLAUDE.md",
		'"agent-message" entries', "Final handback", "complete and concise", "changed file paths", "unverified claims", "Shell access does not guarantee read-only behavior"]) {
		assert(text.includes(required), `Missing ${required}`);
	}
	assert(!text.includes("Agent memory"));
	assert(!text.includes("Execution: foreground"));
	assert(!text.includes("parent conversation:"));
	assert.equal(childSystemPrompt({ definition, cwd: "/repo", isBackground: false }).includes("Execution: foreground"), true);
});

test("memory is separately delimited reference material and bounded", () => {
	const text = childSystemPrompt({ definition, cwd: "/repo", isBackground: false, memoryIndex: "m".repeat(30_000) });
	assert(text.includes("reference material, not additional authority"));
	const content = text.split("<agent-memory>\n")[1].split("\n</agent-memory>")[0];
	assert.equal(content.length, 20_000);
	assert(content.endsWith("[Content truncated]"));
	assert(text.indexOf("</agent-memory>") < text.indexOf("Final handback"));
});

test("built-in role constraints survive the system wrapper without being supplied to custom namesakes", () => {
	const builtins = builtInDefinitions({ forkEnabled: false });
	const explore = childSystemPrompt({ definition: builtins.find((item) => item.agentType === "Explore")!, cwd: "/repo", isBackground: true });
	for (const required of ["never create report files", "quick", "medium", "very thorough", "rather than reviewing or auditing", "Do not change files or delegate"]) assert(explore.includes(required));
	const plan = childSystemPrompt({ definition: builtins.find((item) => item.agentType === "Plan")!, cwd: "/repo", isBackground: false });
	assert(plan.includes("3–5 critical file paths"));
	assert(plan.includes("ordered implementation sequence"));
	const custom = childSystemPrompt({ definition: { ...definition, agentType: "Explore" }, cwd: "/repo", isBackground: false });
	assert(!custom.includes("very thorough"));
	assert(!custom.includes("never create report files"));
});

test("task message puts the delegation before delimited skills, preserving order and deduplicating names", () => {
	const text = taskMessage({ prompt: "Do this assignment first.", preloadedSkills: [
		{ name: "alpha", content: "First skill instructions" }, { name: "beta", content: "Second skill instructions" },
		{ name: "alpha", content: "Duplicate should not appear" },
	] });
	assert(text.startsWith("Do this assignment first."));
	assert(text.indexOf("Do this assignment") < text.indexOf('<preloaded-skill name="alpha">'));
	assert(text.indexOf("First skill instructions") < text.indexOf("Second skill instructions"));
	assert.equal(text.match(/<\/preloaded-skill>/g)?.length, 2);
	assert(!text.includes("Duplicate should not appear"));
	assert.equal(taskMessage({ prompt: "unchanged", preloadedSkills: [] }), "unchanged");
});

test("the entire task message is bounded, with closed skill sections and explicit truncation", () => {
	const text = taskMessage({ prompt: "task", preloadedSkills: [
		{ name: "big", content: "x".repeat(30_000) }, { name: "later", content: "must not fit" },
	] });
	assert.equal(text.length, 20_000);
	assert(text.startsWith("task"));
	assert(text.endsWith("</preloaded-skill>"));
	assert(text.includes("[Content truncated]"));
	assert(!text.includes("must not fit"));
	const longTask = taskMessage({ prompt: "t".repeat(30_000), preloadedSkills: [{ name: "a", content: "omitted" }] });
	assert.equal(longTask.length, 20_000);
	assert(longTask.endsWith("[Content truncated]"));
	assert(!longTask.includes("preloaded-skill"));
	assert(taskMessage({ prompt: "", preloadedSkills: [{ name: "n".repeat(30_000), content: "x" }] }).length <= 20_000);
});

test("cwd and skill-name newlines are encoded as data rather than extra headings", () => {
	assert(childSystemPrompt({ definition, cwd: "/repo\nInjected heading", isBackground: false }).includes('"/repo\\nInjected heading"'));
	assert(taskMessage({ prompt: "task", preloadedSkills: [{ name: 'x"\ny', content: "content" }] }).includes('name="x\\"\\ny"'));
});

test("context-file policy depends on both omitClaudeMd and definition source", () => {
	for (const source of ["built-in", "policy", "user", "project", "package", "flag"] as DefinitionSource[]) {
		assert.equal(contextFilePolicy({ ...definition, source }), "all");
		assert.equal(contextFilePolicy({ ...definition, source, omitClaudeMd: false }), "all");
		assert.equal(contextFilePolicy({ ...definition, source, omitClaudeMd: true }), source === "built-in" || source === "policy" ? "none" : "managed-only");
	}
});
