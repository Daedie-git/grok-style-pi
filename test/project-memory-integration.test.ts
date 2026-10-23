import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGrokStyleExtension } from "../src/extension.ts";
import { defaultFeatures, type Features } from "../src/extension/features.ts";
import { loadProjectMemory } from "../src/extension/project-memory.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";
import { runInChildScope } from "../packages/subagent-engine/src/child-context.ts";

const allOff = Object.fromEntries(Object.keys(defaultFeatures).map(key => [key, false])) as Features;

function fixture(t: any) {
	const base = mkdtempSync(join(tmpdir(), "grok-memory-integration-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const cwd = join(base, "workspace");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	return { base, cwd, storageRoot: join(base, "saved-memories") };
}

function setup(features: Partial<Features>, projectMemoryRoot?: string) {
	const handlers = new Map<string, Function>();
	const notices: string[] = [];
	const registered: string[] = [];
	createGrokStyleExtension({
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { registered.push(tool.name); },
	}, {
		features: { ...allOff, ...features },
		projectMemoryRoot,
		CustomEditor: class {} as any,
		tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map(name => [name, () => ({ name, parameters: {}, execute() {} })])) as any,
	});
	return {
		handlers, registered, notices,
		before(event: any, cwd: string) {
			return handlers.get("before_agent_start")!(event, { cwd, ui: { notify: (text: string) => notices.push(text) } });
		},
	};
}

test("disabled memory performs no memory I/O and withdraws only its own section", async t => {
	const { base, storageRoot } = fixture(t);
	const h = setup({}, storageRoot);
	const sections = { grok_project_memory: "previous enabled context", project_memory: "another extension", unrelated: "keep me" };
	assert.equal(await h.before({ systemPrompt: "base", systemPromptOptions: { sections } }, join(base, "does-not-exist")), undefined);
	assert.deepEqual(sections, { project_memory: "another extension", unrelated: "keep me" });
	assert.equal(existsSync(storageRoot), false);
	assert.deepEqual(h.notices, []);
	assert.deepEqual(h.registered, [...BUILTIN_TOOL_NAMES]);
});

test("memory coexists with communication, refreshes its index, and uses the hook cwd", async t => {
	const { base, cwd, storageRoot } = fixture(t);
	const memory = await loadProjectMemory(cwd, storageRoot);
	writeFileSync(memory.indexPath, "- [Testing](feedback-testing.md) — use real databases\n");
	writeFileSync(join(memory.directory, "feedback-testing.md"), "TOPIC_BODY_NOT_EAGERLY_LOADED");
	const h = setup({ memory: true, communication: true }, storageRoot);
	const sections: Record<string, string> = { unrelated: "unchanged" };
	await h.before({ systemPrompt: "base", systemPromptOptions: { sections } }, cwd);
	assert.match(sections.communication, /Lead with the answer/);
	assert.equal(sections.unrelated, "unchanged");
	assert.ok(sections.grok_project_memory.includes(JSON.stringify(memory.directory)));
	assert.match(sections.grok_project_memory, /use real databases/);
	assert.doesNotMatch(sections.grok_project_memory, /TOPIC_BODY_NOT_EAGERLY_LOADED/);
	assert.deepEqual(h.registered, [...BUILTIN_TOOL_NAMES]);

	writeFileSync(memory.indexPath, "- [Review](feedback-review.md) — NEW_INDEX_CONTENT\n");
	await h.before({ systemPrompt: "base", systemPromptOptions: { sections } }, cwd);
	assert.match(sections.grok_project_memory, /NEW_INDEX_CONTENT/);
	assert.doesNotMatch(sections.grok_project_memory, /use real databases/);

	const other = join(base, "other-workspace");
	mkdirSync(join(other, ".git"), { recursive: true });
	await h.before({ systemPrompt: "base", systemPromptOptions: { sections } }, other);
	assert.doesNotMatch(sections.grok_project_memory, /NEW_INDEX_CONTENT/);
	assert.equal(readFileSync(memory.indexPath, "utf8"), "- [Review](feedback-review.md) — NEW_INDEX_CONTENT\n");
});

test("reloaded disabled memory preserves saved notes and removes the prior section", async t => {
	const { cwd, storageRoot } = fixture(t);
	const enabled = setup({ memory: true }, storageRoot);
	const sections: Record<string, string> = {};
	await enabled.before({ systemPrompt: "base", systemPromptOptions: { sections } }, cwd);
	const memory = await loadProjectMemory(cwd, storageRoot);
	writeFileSync(memory.indexPath, "SAVED_NOTE_POINTER");
	enabled.handlers.get("session_shutdown")!();
	const disabled = setup({}, storageRoot);
	await disabled.before({ systemPrompt: "base", systemPromptOptions: { sections } }, cwd);
	assert.equal(sections.grok_project_memory, undefined);
	assert.equal(readFileSync(memory.indexPath, "utf8"), "SAVED_NOTE_POINTER");
});

test("legacy prompt support replaces its own block without duplicating or losing unrelated text", async t => {
	const { cwd, storageRoot } = fixture(t);
	const enabled = setup({ memory: true }, storageRoot);
	const first = await enabled.before({ systemPrompt: "BASE_AND_OTHER_EXTENSIONS" }, cwd);
	assert.match(first.systemPrompt, /<grok_project_memory>/);
	const second = await enabled.before({ systemPrompt: first.systemPrompt }, cwd);
	// An unchanged hook returns no override; Pi keeps the incoming prompt.
	assert.equal(second, undefined);
	assert.equal(first.systemPrompt.match(/<grok_project_memory>/g).length, 1);
	assert.match(first.systemPrompt, /^BASE_AND_OTHER_EXTENSIONS/);
	const disabled = setup({}, storageRoot);
	const removed = await disabled.before({ systemPrompt: first.systemPrompt }, cwd);
	assert.equal(removed.systemPrompt, "BASE_AND_OTHER_EXTENSIONS");
});

test("memory errors leave other guidance intact and notify only once per session", async () => {
	const h = setup({ memory: true, communication: true });
	const sections: Record<string, string> = { grok_project_memory: "stale", other: "keep" };
	for (let i = 0; i < 2; i++) await h.before({ systemPrompt: "base", systemPromptOptions: { sections } }, process.cwd());
	assert.equal(sections.grok_project_memory, undefined);
	assert.equal(sections.other, "keep");
	assert.match(sections.communication, /Lead with the answer/);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0], /Project memory unavailable/);
});

test("shutdown aborts pending memory I/O before storage creation or prompt publication", async t => {
	const { cwd, storageRoot } = fixture(t);
	const h = setup({ memory: true }, storageRoot);
	const sections: Record<string, string> = {};
	const pending = h.before({ systemPrompt: "base", systemPromptOptions: { sections } }, cwd);
	h.handlers.get("session_shutdown")!();
	assert.equal(await pending, undefined);
	assert.equal(sections.grok_project_memory, undefined);
	assert.equal(existsSync(storageRoot), false, "shutdown must stop subsequent storage creation");
	assert.deepEqual(h.notices, [], "cancellation is not reported as a load failure");
});

test("legacy communication composes with enabled and disabled memory without retaining old memory", async t => {
	const { cwd, storageRoot } = fixture(t);
	for (const enabled of [false, true]) {
		const h = setup({ memory: enabled, communication: true }, storageRoot);
		const original = "base\n\n<grok_project_memory>\nSTALE_MEMORY\n</grok_project_memory>";
		const result = await h.before({ systemPrompt: original }, cwd);
		assert.ok(result.systemPrompt.startsWith("base"));
		assert.match(result.systemPrompt, /<communication>/);
		assert.doesNotMatch(result.systemPrompt, /STALE_MEMORY/);
		assert.equal(result.systemPrompt.includes("<grok_project_memory>"), enabled);
		assert.equal(existsSync(storageRoot), enabled);
	}
});

test("legacy communication does not republish stale memory after cancellation", async t => {
	const { cwd, storageRoot } = fixture(t);
	const h = setup({ memory: true, communication: true }, storageRoot);
	const oldPrompt = "base\n\n<grok_project_memory>\nSTALE_MEMORY\n</grok_project_memory>";
	const pending = h.before({ systemPrompt: oldPrompt }, cwd);
	h.handlers.get("session_shutdown")!();
	assert.equal(await pending, undefined, "cancellation must suppress the entire composed prompt override");
	assert.equal(existsSync(storageRoot), false);
	assert.deepEqual(h.notices, []);
});

test("root project memory remains inert inside engine child contexts", t => {
	const { storageRoot } = fixture(t);
	const h = runInChildScope({ agentId: "child", depth: 1 }, () => setup({ memory: true }, storageRoot));
	assert.equal(h.handlers.size, 0);
	assert.equal(h.registered.length, 0);
	assert.equal(existsSync(storageRoot), false);
});
