import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { MemoryStore, indexWarning } from "../src/extension/memory-store.ts";
import { createMemoryPassState, recallMemory, runMemoryPass, type MemoryCompletion } from "../src/extension/memory-worker.ts";
import { installAutomaticMemory, memoryConversation } from "../src/extension/automatic-memory.ts";
import { loadProjectMemory } from "../src/extension/project-memory.ts";
import { recentMemorySessions } from "../src/extension/memory-history.ts";

async function fixture(t: TestContext, cleanup = true) {
	const captures = resolve("captures");
	await mkdir(captures, { recursive: true });
	const directory = await mkdtemp(join(captures, "auto-memory-"));
	if (cleanup) t.after(() => rm(directory, { recursive: true, force: true }));
	return { directory, store: new MemoryStore(directory) };
}
async function optionalFileSymlink(t: TestContext, target: string, path: string): Promise<boolean> {
	try { await symlink(target, path); return true; }
	catch (error) {
		if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
		t.diagnostic("File-symlink sub-check unavailable: this Windows account has no symlink privilege. Other assertions still run.");
		return false;
	}
}
const signal = () => new AbortController().signal;
const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function response(content: any[]): any { return { role: "assistant", content, usage, stopReason: "stop", timestamp: Date.now() }; }
function tool(name: string, args: Record<string, unknown>, id = "call"): any { return { type: "toolCall", id, name, arguments: args }; }
function scripted(...responses: any[]): MemoryCompletion {
	return async () => { assert.ok(responses.length, "unexpected model request"); return responses.shift(); };
}

test("memory filesystem rejects traversal, symlinks, special files and stale writes", async t => {
	const { directory, store } = await fixture(t);
	await store.mutate("note.md", "original", undefined);
	assert.equal(await store.read("note.md"), "original");
	await assert.rejects(store.mutate("note.md", "stale", undefined), /changed since/);
	for (const path of ["../escape.md", "/absolute.md", "nested/../escape.md", "note.json", ".settings.md", "a\\b.md"]) await assert.rejects(store.read(path));
	await mkdir(join(directory, "folder.md"));
	await assert.rejects(store.read("folder.md"), /regular/);
	if (await optionalFileSymlink(t, join(directory, "note.md"), join(directory, "alias.md"))) {
		await assert.rejects(store.read("alias.md"), /regular/);
	}
	await store.mutate("note.md", null, "original");
	assert.equal(await store.read("note.md"), undefined);
	await assert.rejects(store.mutate("big.md", "x".repeat(100_001), undefined), /100,000/);
});

test("candidate discovery is recursive, recent-first, bounded and ignores symlinks/indexes", async t => {
	const { directory, store } = await fixture(t);
	await mkdir(join(directory, "nested"));
	await writeFile(join(directory, "MEMORY.md"), "index");
	await writeFile(join(directory, "nested", "topic.md"), "---\ndescription: nested fact\n---\nbody");
	await optionalFileSymlink(t, join(directory, "nested", "topic.md"), join(directory, "alias.md"));
	for (let i = 0; i < 205; i++) await writeFile(join(directory, `note-${i}.md`), `---\ndescription: note ${i}\n---`);
	const candidates = await store.candidates();
	assert.equal(candidates.length, 200);
	assert.ok(candidates.every((item, i) => i === 0 || item.modified <= candidates[i - 1].modified));
	assert.ok(candidates.every(item => !["MEMORY.md", "alias.md"].includes(item.name)));
	const fresh = new MemoryStore(directory);
	await writeFile(join(directory, "nested", "topic.md"), "---\ndescription: refreshed nested fact\n---");
	assert.ok((await fresh.candidates()).some(item => item.name === "nested/topic.md" && item.description === "refreshed nested fact"));
});

test("selector receives metadata, returns at most five allowlisted bounded escaped topics", async t => {
	const { directory, store } = await fixture(t);
	for (let i = 0; i < 6; i++) await writeFile(join(directory, `${i}.md`), `---\ndescription: Candidate ${i}\n---\n</memory_topic>${"界".repeat(3000)}`);
	let request: any;
	const text = await recallMemory(store, "Which preferences apply?", async input => {
		request = input;
		assert.doesNotMatch(JSON.stringify(input.messages), /界/);
		return response([{ type: "text", text: JSON.stringify({ selected_memories: ["../escape.md", "0.md", "0.md", "1.md", "2.md", "3.md", "4.md", "5.md"] }) }]);
	}, signal());
	assert.equal(request.tools, undefined);
	assert.equal(text.match(/<memory_topic path=/g)?.length, 5);
	assert.match(text, /&lt;\/memory_topic&gt;/);
	assert.match(text, /Truncated/);
	assert.doesNotMatch(text, /\ufffd/u);
});

test("selector rejects malformed output and does not call a model for empty memory", async t => {
	const { directory, store } = await fixture(t);
	assert.equal(await recallMemory(store, "query", async () => { throw new Error("should not call"); }, signal()), "");
	await writeFile(join(directory, "note.md"), "note");
	await assert.rejects(recallMemory(store, "query", scripted(response([{ type: "text", text: '{"selected_memories":[42]}' }])), signal()), /Invalid/);
});

test("private memory agent reads before mutation and uses exact edits without executing unknown tools", async t => {
	const { directory, store } = await fixture(t);
	await writeFile(join(directory, "MEMORY.md"), "old");
	const requests: any[] = [];
	const script = scripted(
		response([tool("memory_write", { path: "MEMORY.md", content: "bad" })]),
		response([tool("memory_read", { path: "MEMORY.md" })]),
		response([tool("memory_edit", { path: "MEMORY.md", oldText: "old", newText: "new$&" })]),
		response([tool("bash", { path: "MEMORY.md", command: "touch nope" })]),
		response([{ type: "text", text: "done" }]),
	);
	const result = await runMemoryPass({ store, complete: async request => { requests.push(structuredClone(request.messages)); return script(request); }, signal: signal(), policy: "memory policy", conversation: "User: useful feedback", mode: "extract" });
	assert.deepEqual(result, { writes: 1, exhausted: false });
	assert.match(requests[1].at(-1).content[0].text, /Read this file first/);
	assert.match(requests[4].at(-1).content[0].text, /not available/);
	assert.equal(await readFile(join(directory, "MEMORY.md"), "utf8"), "new$&");
});

test("a successful fifth-round write gets a tool-free completion confirmation", async t => {
	const { directory, store } = await fixture(t);
	let calls = 0;
	const steps: any[] = [];
	const result = await runMemoryPass({ store, signal: signal(), policy: "policy", conversation: "durable preference", mode: "extract",
		onStep: (step: any) => steps.push(step),
		complete: async (request: any) => {
			calls++;
			if (calls === 6) {
				assert.deepEqual(request.tools, []);
				assert.match(request.systemPrompt, /Return only JSON.*complete/);
				return response([{ type: "text", text: '{"complete":true}' }]);
			}
			if (calls === 5) {
				assert.match(request.systemPrompt, /last tool-capable/i);
				return response([tool("memory_write", { path: "note.md", content: "saved preference" })]);
			}
			return response([tool("memory_read", { path: "note.md" })]);
		},
	} as any);
	assert.equal(calls, 6);
	assert.deepEqual(result, { writes: 1, exhausted: false });
	assert.equal(await readFile(join(directory, "note.md"), "utf8"), "saved preference");
	assert.equal(steps.at(-1).outcome, "complete");
	assert.equal(steps.at(-1).writes, 1);
});

test("tool-error exhaustion records bounded diagnostics without paths, arguments or note contents", async t => {
	const { store } = await fixture(t);
	const steps: any[] = [];
	let calls = 0;
	const result = await runMemoryPass({ store, signal: signal(), policy: "policy", conversation: "durable preference", mode: "extract",
		onStep: (step: any) => steps.push(step),
		complete: async (request: any) => {
			calls++;
			if (calls === 6) return response([{ type: "text", text: '{"complete":false}' }]);
			if (calls > 1) assert.match(request.messages.at(-1).content[0].text, /Read this file first/);
			return response([tool("memory_write", { path: "private-name.md", content: "private contents" })]);
		},
	} as any);
	assert.deepEqual(result, { writes: 0, exhausted: true });
	assert.equal(steps.length, 6);
	assert.deepEqual(steps[0].tools, [{ name: "memory_write", error: "read-required" }]);
	assert.equal(steps.at(-1).outcome, "deferred");
	assert.doesNotMatch(JSON.stringify(steps), /private-name|private contents|durable preference/);
});

test("confirmation cannot execute tools or advance an unfinished pass on malformed output", async t => {
	const { store } = await fixture(t);
	for (const confirmation of [response([{ type: "text", text: "I still need another write." }]), response([tool("memory_delete", { path: "note.md" })])]) {
		await store.mutate("note.md", "preserved", await store.read("note.md"));
		let calls = 0;
		const result = await runMemoryPass({ store, signal: signal(), policy: "policy", conversation: "feedback", mode: "extract",
			complete: async () => ++calls === 6 ? confirmation : response([tool("memory_read", { path: "note.md" })]),
		});
		assert.deepEqual(result, { writes: 0, exhausted: true });
		assert.equal(await store.read("note.md"), "preserved");
	}
});

test("resumed extraction refuses stale writes and can recover by rereading", async t => {
	const { store } = await fixture(t);
	await store.mutate("note.md", "original", undefined);
	const state = createMemoryPassState();
	let calls = 0;
	await runMemoryPass({ store, state, signal: signal(), policy: "policy", conversation: "feedback", mode: "extract",
		complete: async () => ++calls === 6 ? response([{ type: "text", text: '{"complete":false}' }]) : response([tool("memory_read", { path: "note.md" })]),
	});
	await store.mutate("note.md", "foreground correction", "original");
	const steps: any[] = [];
	const script = scripted(
		response([tool("memory_write", { path: "note.md", content: "stale replacement" })]),
		response([tool("memory_read", { path: "note.md" })]),
		response([tool("memory_edit", { path: "note.md", oldText: "foreground correction", newText: "correctly merged" })]),
		response([{ type: "text", text: "done" }]),
	);
	const result = await runMemoryPass({ store, state, signal: signal(), policy: "policy", conversation: "feedback", mode: "extract", complete: script, onStep: step => steps.push(step) });
	assert.deepEqual(result, { writes: 1, exhausted: false });
	assert.equal(steps[0].tools[0].error, "stale-read");
	assert.equal(await store.read("note.md"), "correctly merged");
});

test("cancellation after provider response prevents all memory mutations", async t => {
	const { store } = await fixture(t);
	const controller = new AbortController();
	await assert.rejects(runMemoryPass({ store, signal: controller.signal, policy: "policy", conversation: "conversation", mode: "extract", complete: async () => {
		controller.abort();
		return response([tool("memory_read", { path: "new.md" })]);
	} }), { name: "AbortError" });
	assert.equal(await store.read("new.md"), undefined);
});

test("index warnings distinguish successful writes from read truncation", () => {
	assert.equal(indexWarning("small index"), undefined);
	assert.match(indexWarning("x".repeat(20_000))!, /near/);
	assert.match(indexWarning("x".repeat(25_001))!, /write succeeded/);
	assert.match(indexWarning(Array.from({ length: 201 }, () => "line").join("\n"))!, /write succeeded/);
});

test("conversation capture excludes tools, thoughts and images and is bounded", () => {
	const text = memoryConversation([
		{ type: "message", message: { role: "toolResult", content: "SECRET TOOL OUTPUT" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "text", text: "Answer" }] } },
		{ type: "message", message: { role: "user", content: "Feedback" } },
	]);
	assert.equal(text, "assistant: Answer\n\nuser: Feedback");
	assert.ok(memoryConversation(Array.from({ length: 20 }, () => ({ type: "message", message: { role: "user", content: "x".repeat(50_000) } }))).length < 81_000);
});

async function harness(t: TestContext, enabled = true, overrides: Record<string, unknown> = {}) {
	const { directory } = await fixture(t, false);
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const notices: string[] = [];
	const messages: any[] = [];
	let calls = 0;
	const listeners = new Map<string, Array<() => void>>();
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		appendEntry(customType: string, data: unknown) {
			entries.push({ id: `custom-${entries.length}`, type: "custom", customType, data });
			for (const listener of listeners.get(customType) ?? []) listener();
			listeners.delete(customType);
		},
		sendMessage(message: any, options: unknown) {
			messages.push({ message, options });
			entries.push({ id: `message-${entries.length}`, type: "custom_message", ...message });
		},
		getActiveTools() { return ["read", "write", "edit"]; },
	};
	const ctx = {
		cwd: directory, model: { id: "test-model" }, ui: { notify: (text: string) => notices.push(text) },
		isIdle: () => true, waitForIdle: async () => {}, getSystemPrompt: () => "Inherited project instructions",
		sessionManager: { getBranch: () => entries, getSessionId: () => "current" },
	};
	const storageRoot = join(directory, "store");
	installAutomaticMemory(pi as any, {
		enabled, storageRoot, settingsPath: join(directory, "grok-style.json"), queue: async (_path, run) => run(), authorize: async () => true,
		options: { idleMs: 10_000 }, complete: () => async () => { calls++; return response([{ type: "text", text: "Nothing to save." }]); }, ...overrides,
	});
	const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	await emit("session_start");
	t.after(async () => {
		await emit("session_shutdown");
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	});
	return { directory, storageRoot, commands, entries, notices, messages, ctx, emit, calls: () => calls,
		nextEntry: (type: string) => new Promise<void>(resolve => listeners.set(type, [...listeners.get(type) ?? [], resolve])),
	};
}

test("disabled lifecycle does not initialize storage or call a model", async t => {
	const h = await harness(t, false);
	const event = { prompt: "question", systemPromptOptions: { sections: { grok_recalled_memory: "stale" } } };
	await h.emit("before_agent_start", event);
	await h.emit("agent_settled", { aborted: false });
	assert.deepEqual(event.systemPromptOptions.sections, {});
	assert.equal(h.calls(), 0);
	await assert.rejects(readFile(h.storageRoot), { code: "ENOENT" });
	await h.commands.get("memory").handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /No store accessed/);
});

test("manual extraction persists a branch cursor and does not repeat reviewed messages", async t => {
	const h = await harness(t);
	h.entries.push({ id: "user-1", type: "message", message: { role: "user", content: "Prefer concise feedback" } });
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(h.calls(), 1);
	assert.ok(h.entries.some(entry => entry.customType === "grok-memory-cursor" && entry.data.entryId === "user-1"));
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(h.calls(), 1);
});

test("deferred extraction resumes its tool history and pinned chunk instead of replaying writes", async t => {
	let calls = 0;
	const requests: any[] = [];
	const h = await harness(t, true, { complete: () => async (request: any) => {
		requests.push(structuredClone(request)); calls++;
		if (calls <= 4) return response([tool("memory_read", { path: "note.md" })]);
		if (calls === 5) return response([tool("memory_write", { path: "note.md", content: "saved once" })]);
		if (calls === 6) return response([{ type: "text", text: '{"complete":false}' }]);
		return response([{ type: "text", text: "Finished reviewing this chunk." }]);
	} });
	h.entries.push({ id: "user-1", type: "message", message: { role: "user", content: "Prefer concise feedback" } });
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(calls, 6);
	assert.equal(h.entries.some(entry => entry.customType === "grok-memory-cursor"), false);
	assert.match(h.notices.at(-1)!, /extraction deferred/i);
	assert.doesNotMatch(h.notices.join("\n"), /unavailable|five-turn budget/);
	h.entries.push({ id: "user-2", type: "message", message: { role: "user", content: "A new unrelated prompt" } });
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(calls, 7);
	assert.ok(requests[6].messages.some((message: any) => message.role === "toolResult" && message.toolName === "memory_write"));
	assert.doesNotMatch(JSON.stringify(requests[6].messages), /unrelated prompt/);
	assert.equal(h.entries.filter(entry => entry.customType === "grok-memory-cursor").at(-1).data.entryId, "user-1");
	assert.ok(h.entries.some(entry => entry.customType === "grok-memory-pass" && entry.data.outcome === "deferred"));
	await h.commands.get("memory").handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /Last pass:/);
});

test("branch changes discard unfinished extraction history instead of leaking another branch's prose", async t => {
	let calls = 0;
	const requests: any[] = [];
	const h = await harness(t, true, { complete: () => async (request: any) => {
		requests.push(structuredClone(request)); calls++;
		if (calls <= 5) return response([tool("memory_read", { path: "note.md" })]);
		return response([{ type: "text", text: calls === 6 ? '{"complete":false}' : "done" }]);
	} });
	h.entries.push({ id: "branch-one", type: "message", message: { role: "user", content: "Abandoned branch preference" } });
	await h.commands.get("memory").handler("extract", h.ctx);
	h.entries.splice(0);
	h.entries.push({ id: "branch-two", type: "message", message: { role: "user", content: "Current branch preference" } });
	await h.emit("session_tree");
	await h.commands.get("memory").handler("extract", h.ctx);
	assert.equal(calls, 7);
	assert.equal(requests[6].messages.length, 1);
	assert.doesNotMatch(JSON.stringify(requests[6].messages), /Abandoned branch/);
	assert.equal(h.entries.filter(entry => entry.customType === "grok-memory-cursor").at(-1).data.entryId, "branch-two");
});

test("message submission never waits for recall; ready notes queue without interrupting or starting a turn", async t => {
	let release: (value: any) => void = () => {};
	let started: () => void = () => {};
	const begun = new Promise<void>(resolve => { started = resolve; });
	const h = await harness(t, true, { complete: () => async () => { started(); return new Promise(resolve => { release = resolve; }); } });
	const memory = await loadProjectMemory(h.directory, h.storageRoot);
	await writeFile(join(memory.directory, "topic.md"), "---\ndescription: useful preference\n---\nKeep tests minimal.");
	const event = { prompt: "recall preferences", systemPromptOptions: { sections: {} as Record<string, string> } };
	const pending = h.emit("before_agent_start", event);
	await begun;
	const returned = await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50))]);
	const remembered = h.nextEntry("grok-memory-recall");
	release(response([{ type: "text", text: '{"selected_memories":["topic.md"]}' }]));
	await remembered;
	await pending;
	assert.equal(returned, true, "a pending recall model must not hold message submission");
	assert.equal(event.systemPromptOptions.sections.grok_recalled_memory, undefined, "completed recall must not mutate an already-submitted prompt");
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].message.display, false);
	assert.match(h.messages[0].message.content, /Keep tests minimal/);
	assert.deepEqual(h.messages[0].options, { triggerTurn: false });
	const next = { prompt: "next question", systemPromptOptions: { sections: {} as Record<string, string> } };
	await h.emit("before_agent_start", next);
	assert.equal(next.systemPromptOptions.sections.grok_recalled_memory, undefined);
	assert.equal(h.messages.length, 1, "persisted recall must not be injected a second time");
});

test("shutdown cancels an in-flight recall without publishing stale context", async t => {
	let release: (value: any) => void = () => {};
	let started: () => void = () => {};
	const begun = new Promise<void>(resolve => { started = resolve; });
	const h = await harness(t, true, { complete: () => async () => { started(); return new Promise(resolve => { release = resolve; }); } });
	const memory = await loadProjectMemory(h.directory, h.storageRoot);
	await writeFile(join(memory.directory, "topic.md"), "---\ndescription: useful\n---\ncontent");
	const event = { prompt: "recall preferences", systemPromptOptions: { sections: {} as Record<string, string> } };
	const pending = h.emit("before_agent_start", event);
	await begun;
	await h.emit("session_shutdown");
	const entriesBeforeRelease = h.entries.length;
	release(response([{ type: "text", text: '{"selected_memories":["topic.md"]}' }]));
	await pending;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(event.systemPromptOptions.sections.grok_recalled_memory, undefined);
	assert.equal(h.messages.length, 0);
	assert.equal(h.entries.length, entriesBeforeRelease);
});

test("consolidation reads bounded session prose, not tool output or symlinked files", async t => {
	const { directory } = await fixture(t);
	const path = join(directory, "session.jsonl");
	await writeFile(path, [
		JSON.stringify({ type: "message", message: { role: "user", content: "Correction worth remembering" } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", content: "private tool result" } }),
	].join("\n"));
	const sessions = await recentMemorySessions([{ id: "other", path, modified: new Date() }], 0, "current", signal());
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].text, "user: Correction worth remembering");
	if (await optionalFileSymlink(t, path, join(directory, "alias.jsonl"))) {
		assert.deepEqual(await recentMemorySessions([{ id: "alias", path: join(directory, "alias.jsonl"), modified: new Date() }], 0, "current", signal()), []);
	}
});
