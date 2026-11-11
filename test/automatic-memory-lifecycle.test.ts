import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { installAutomaticMemory } from "../src/extension/automatic-memory.ts";
import { loadProjectMemory } from "../src/extension/project-memory.ts";
import { MemoryStore } from "../src/extension/memory-store.ts";
import { runMemoryPass } from "../src/extension/memory-worker.ts";

function reply(content: any[] = []): any { return { role: "assistant", content, usage: { cost: { total: 0.01 } }, stopReason: "stop", timestamp: Date.now() }; }
async function setup(t: TestContext, overrides: Record<string, unknown> = {}) {
	await mkdir(resolve("captures"), { recursive: true });
	const root = await mkdtemp(resolve("captures/memory-lifecycle-"));
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const waits = new Map<string, () => void>();
	const notices: string[] = [];
	const calls: any[] = [];
	const statuses: Array<string | undefined> = [];
	const ctx = { cwd: root, isIdle: () => true, getSystemPrompt: () => "inherited instructions", waitForIdle: async () => {},
		ui: { notify: (text: string) => notices.push(text), setStatus: (key: string, value: string | undefined) => { assert.equal(key, "grok-memory"); statuses.push(value); } }, sessionManager: { getBranch: () => entries, getSessionId: () => "current" } };
	installAutomaticMemory({
		on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => ["read", "write", "edit"],
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ id: `custom-${entries.length}`, type: "custom", customType, data });
			waits.get(customType)?.(); waits.delete(customType);
		},
	} as any, {
		enabled: true, storageRoot: join(root, "store"), settingsPath: join(root, "settings.json"), queue: async (_path, run) => run(), authorize: async () => true,
		complete: () => async request => { calls.push(request); return reply(); }, ...overrides,
	});
	const emit = async (name: string, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	await emit("session_start");
	t.after(async () => { await emit("session_shutdown"); await rm(root, { recursive: true, force: true }); });
	return { root, entries, calls, notices, statuses, ctx, emit, commands,
		next: (type: string) => new Promise<void>(resolve => waits.set(type, resolve)),
		prompt: (id: string) => entries.push({ id, type: "message", message: { role: "user", content: "Useful correction" } }),
	};
}

test("memory requests use their configured model and reasoning, not the conversation model", async t => {
	const h = await setup(t, { complete: undefined });
	const requests: any[] = [];
	const model = { id: "gpt-6.1-terra", provider: "openai-codex" };
	Object.assign(h.ctx, {
		model: { id: "other-conversation-model" },
		modelRegistry: {
			find: (provider: string, id: string) => { assert.equal(provider, model.provider); assert.equal(id, model.id); return model; },
			streamSimple: (selected: unknown, _context: unknown, options: unknown) => {
				assert.equal(selected, model); requests.push(options);
				return { result: async () => reply() };
			},
		},
	});
	h.prompt("user");
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].reasoning, "medium");
	assert.deepEqual(h.statuses, ["on", "extracting", "on"]);
	assert.equal(h.entries.find(entry => entry.customType === "grok-memory-usage").data.model, model.id);

	await writeFile(join(h.root, "settings.json"), JSON.stringify({ automaticMemory: { provider: "custom", model: "configured", reasoning: "low" } }));
	const custom = await setup(t, { complete: undefined, settingsPath: join(h.root, "settings.json") });
	Object.assign(custom.ctx, { modelRegistry: {
		find: (provider: string, id: string) => { assert.equal(provider, "custom"); assert.equal(id, "configured"); return model; },
		streamSimple: (_model: unknown, _context: unknown, options: any) => {
			assert.equal(options.reasoning, "low"); return { result: async () => reply() };
		},
	} });
	custom.prompt("user");
	await custom.commands.get("memory").handler("extract", custom.ctx);
	assert.ok(custom.entries.some(entry => entry.customType === "grok-memory-cursor"));
	Object.assign(custom.ctx, { modelRegistry: { find: () => undefined } });
	custom.prompt("next");
	await custom.commands.get("memory").handler("extract", custom.ctx);
	assert.match(custom.notices.at(-1)!, /Memory model custom\/configured is unavailable/);
	assert.equal(custom.statuses.at(-1), "error");
});

test("memory status reports missing authorization and clears on shutdown", async t => {
	const h = await setup(t, { authorize: async () => false });
	assert.equal(h.statuses.at(-1), "needs authorization");
	await h.emit("session_shutdown");
	assert.equal(h.statuses.at(-1), undefined);
});

test("five user prompts trigger automatic extraction and resume restores its cursor", async t => {
	const h = await setup(t, { options: { idleMs: 10_000 } });
	for (let i = 0; i < 4; i++) h.prompt(`user-${i}`);
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.calls.length, 0);
	h.prompt("user-4");
	const done = h.next("grok-memory-cursor");
	await h.emit("agent_settled", { aborted: false });
	await done;
	assert.equal(h.calls.length, 1);
	assert.match(h.calls[0].systemPrompt, /inherited instructions/);
	await h.emit("session_start");
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.calls.length, 1);
});

test("idle flushing reviews fewer than five prompts", async t => {
	const h = await setup(t, { options: { idleMs: 5 } });
	h.prompt("only-prompt");
	const done = h.next("grok-memory-cursor");
	await h.emit("agent_settled", { aborted: false });
	// Keep this test alive while the production timer is deliberately unref'ed.
	const hold = setInterval(() => {}, 1000);
	try { await done; } finally { clearInterval(hold); }
	assert.equal(h.calls.length, 1);
});

test("dreaming requires five other modified sessions and records successful consolidation", async t => {
	const h = await setup(t, { recentSessions: async () => Array.from({ length: 5 }, (_, index) => ({ id: `other-${index}`, modified: Date.now(), text: "user: durable feedback" })) });
	const done = h.next("grok-memory-consolidated");
	await h.emit("agent_settled", { aborted: false });
	await done;
	assert.equal(h.calls.length, 5);
	const memory = await loadProjectMemory(h.root, join(h.root, "store"));
	assert.ok(Number(await readFile(join(memory.directory, ".last-consolidated"), "utf8")) > 0);
	assert.match(h.calls[0].systemPrompt, /consolidation agent/);
	assert.deepEqual(h.statuses, ["on", "consolidating", "on"]);
});

test("a cross-session lock prevents concurrent background writers and status explains it", async t => {
	const h = await setup(t);
	const memory = await loadProjectMemory(h.root, join(h.root, "store"));
	await writeFile(join(memory.directory, ".consolidate-lock"), "other process");
	h.prompt("user");
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(h.calls.length, 0);
	assert.match(h.notices.at(-1)!, /lock exists/);
	assert.equal(await readFile(join(memory.directory, ".consolidate-lock"), "utf8"), "other process");
});

test("disabling extraction persists its mode and prevents manual extraction", async t => {
	const h = await setup(t);
	await h.commands.get("memory").handler("extraction off", h.ctx);
	h.prompt("user");
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(h.calls.length, 0);
	assert.match(h.notices.at(-1)!, /mode is disabled/);
	const settings = JSON.parse(await readFile(join(h.root, "settings.json"), "utf8"));
	assert.equal(settings.automaticMemory.extraction, false);
});

test("memory agents cannot acquire an inactive write tool and stop at five model turns", async t => {
	const h = await setup(t);
	const memory = await loadProjectMemory(h.root, join(h.root, "store"));
	let calls = 0;
	const result = await runMemoryPass({ store: new MemoryStore(memory.directory), signal: new AbortController().signal,
		policy: "policy", conversation: "feedback", mode: "extract", allowedTools: () => ["read"],
		complete: async request => {
			assert.deepEqual(request.tools?.map(tool => tool.name), ["memory_read"]);
			calls++;
			return reply([{ type: "toolCall", id: `call-${calls}`, name: "memory_write", arguments: { path: "new.md", content: "not allowed" } }]);
		},
	});
	assert.deepEqual(result, { writes: 0, exhausted: true });
	assert.equal(calls, 5);
	await assert.rejects(readFile(join(memory.directory, "new.md")), { code: "ENOENT" });
});
