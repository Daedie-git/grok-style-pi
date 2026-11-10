import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { installAutomaticMemory } from "../src/extension/automatic-memory.ts";
import { consolidationChunks, memoryChunk } from "../src/extension/memory-context.ts";
import { createRecallState, MEMORY_RECALL_BYTES, recallMemory, runMemoryPass } from "../src/extension/memory-worker.ts";
import { MemoryStore } from "../src/extension/memory-store.ts";
import { loadProjectMemory } from "../src/extension/project-memory.ts";
import { recentMemorySessions } from "../src/extension/memory-history.ts";

const signal = () => new AbortController().signal;
function reply(text = "Nothing to save.", stopReason = "stop"): any { return { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: 0 } }, stopReason, timestamp: Date.now() }; }
async function fixture(t: TestContext) {
	await mkdir(resolve("captures"), { recursive: true });
	const directory = await mkdtemp(resolve("captures/memory-review-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}
async function harness(t: TestContext, extra: Record<string, unknown> = {}) {
	const directory = await fixture(t);
	const entries: any[] = [];
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const requests: any[] = [];
	const ctx = { cwd: directory, hasUI: true, isIdle: () => true, getSystemPrompt: () => "inherited instructions", waitForIdle: async () => {},
		ui: { notify: (text: string) => notices.push(text), confirm: async () => true },
		sessionManager: { getBranch: () => entries, getSessionId: () => "current" } };
	const settingsPath = join(directory, "settings.json");
	const root = join(directory, "store");
	installAutomaticMemory({
		on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (name: string, value: unknown) => commands.set(name, value),
		getActiveTools: () => ["read", "write", "edit"], appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", id: `custom-${entries.length}`, customType, data: structuredClone(data) }),
	} as any, { enabled: true, storageRoot: root, settingsPath, queue: async (_path, run) => run(),
		complete: () => async request => { requests.push(request); return reply(); }, ...extra });
	const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const command = (args: string) => commands.get("memory").handler(args, ctx);
	await emit("session_start");
	t.after(() => emit("session_shutdown"));
	return { directory, root, settingsPath, entries, requests, notices, ctx, emit, command };
}

test("background filesystem access fails closed and revocation is rechecked before mutation", async t => {
	const directory = await fixture(t);
	await writeFile(join(directory, "topic.md"), "private");
	let authorized = false;
	const store = new MemoryStore(directory, async (_path, run) => run(), async () => { if (!authorized) throw new Error("not authorized"); });
	await assert.rejects(store.candidates(), /not authorized/);
	await assert.rejects(store.read("topic.md"), /not authorized/);
	authorized = true;
	assert.equal(await store.read("topic.md"), "private");
	authorized = false;
	await assert.rejects(store.mutate("topic.md", "overwrite", "private"), /not authorized/);
	assert.equal(await readFile(join(directory, "topic.md"), "utf8"), "private");
});

test("a separate explicit directory grant is required; headless or declined confirmation never grants access", async t => {
	const h = await harness(t);
	h.entries.push({ type: "message", id: "user", message: { role: "user", content: "Remember my preference" } });
	await h.command("extract");
	assert.equal(h.requests.length, 0);
	assert.match(h.notices.at(-1)!, /authorize/);
	h.ctx.hasUI = false;
	await h.command("authorize");
	await assert.rejects(readFile(h.settingsPath), { code: "ENOENT" });
	h.ctx.hasUI = true;
	h.ctx.ui.confirm = async () => false;
	await h.command("authorize");
	await assert.rejects(readFile(h.settingsPath), { code: "ENOENT" });
	h.ctx.ui.confirm = async () => true;
	await h.command("authorize");
	const memory = await loadProjectMemory(h.directory, h.root);
	assert.deepEqual(JSON.parse(await readFile(h.settingsPath, "utf8")).automaticMemory.authorizedDirectories, [memory.directory]);
	await h.command("dream off");
	assert.deepEqual(JSON.parse(await readFile(h.settingsPath, "utf8")).automaticMemory.authorizedDirectories, [memory.directory]);
	await h.command("extract");
	assert.equal(h.requests.length, 1);
	await h.command("revoke");
	h.entries.push({ type: "message", id: "next-user", message: { role: "user", content: "Another correction" } });
	await h.command("extract");
	assert.equal(h.requests.length, 1);
});

test("long messages and multi-message backlogs are processed oldest-first with exact partial cursors", async t => {
	const h = await harness(t, { authorize: async () => true });
	const first = "REMEMBER_FIRST " + "😀".repeat(45_000) + " FORGET_LAST";
	h.entries.push({ type: "message", id: "long-user", message: { role: "user", content: first } });
	for (let index = 0; index < 6; index++) h.entries.push({ type: "message", id: `answer-${index}`, message: { role: "assistant", content: `ANSWER_${index} ` + "x".repeat(16_000) } });
	await h.command("extract");
	assert.match(JSON.parse(h.requests[0].messages[0].content).recentConversation, /^user: REMEMBER_FIRST/);
	const initial = h.entries.filter(entry => entry.customType === "grok-memory-cursor").at(-1).data;
	assert.equal(initial.entryId, "long-user");
	assert.ok(initial.offset > 0 && initial.offset < first.length);
	await h.emit("session_start");
	await h.command("extract");
	await h.command("extract");
	const all = h.requests.map(request => JSON.parse(request.messages[0].content).recentConversation).join("\n");
	assert.ok(all.includes("FORGET_LAST"));
	for (let index = 0; index < 6; index++) assert.ok(all.includes(`ANSWER_${index}`));
	assert.equal((all.match(/😀/gu) ?? []).length, 45_000);
	assert.ok(h.requests.every(request => JSON.parse(request.messages[0].content).recentConversation.length <= 80_000));
});

test("chunk cursors never skip an oversized entry or split a surrogate pair", () => {
	const entries = [{ id: "one", type: "message", message: { role: "user", content: "a😀".repeat(100) } }];
	let cursor = {};
	let text = "";
	for (;;) {
		const chunk = memoryChunk(entries, cursor, 100);
		assert.doesNotMatch(chunk.text, /[\ud800-\udbff]$/u);
		text += chunk.text.replace(/^user(?: \(continued\))?: /, "");
		cursor = chunk.cursor;
		if (!chunk.pending) break;
	}
	assert.equal(text, entries[0].message.content);
});

test("consolidation preserves every newest-first session with identifiers and timestamps", () => {
	const sessions = Array.from({ length: 5 }, (_, index) => ({ id: `SESSION_${index}`, modified: 1000 + index, text: `CORRECTION_${index} ` + "x".repeat(30_000) }));
	const chunks = consolidationChunks(sessions);
	assert.equal(chunks.length, 5);
	assert.match(chunks[0], /SESSION_4/);
	assert.match(chunks[0], /1970-01-01T/);
	for (let index = 0; index < 5; index++) assert.ok(chunks.some(chunk => chunk.includes(`CORRECTION_${index}`)));
	assert.ok(chunks.every(chunk => chunk.length <= 80_000));
});

test("consolidation saves snapshot progress, not completion time, so concurrent corrections remain eligible", async t => {
	let snapshot = Date.now() - 1000;
	const h = await harness(t, { authorize: async () => true, recentSessions: async () => [{ id: "other", modified: snapshot, text: "newest correction" }] });
	await h.command("consolidate");
	const memory = await loadProjectMemory(h.directory, h.root);
	const processed = JSON.parse(await readFile(join(memory.directory, ".consolidation-progress"), "utf8"));
	assert.equal(processed.other, snapshot);
	snapshot++;
	await h.command("consolidate");
	assert.equal(h.requests.length, 2);
	assert.match(JSON.parse(h.requests[0].messages[0].content).recentConversation, /Session "other", modified/);
});

test("recent-session caps filter processed snapshots before choosing the next batch", async t => {
	const directory = await fixture(t);
	const sessions = [];
	const processed: Record<string, number> = {};
	for (let index = 0; index < 12; index++) {
		const path = join(directory, `session-${index}.jsonl`);
		await writeFile(path, JSON.stringify({ type: "message", message: { role: "user", content: `feedback ${index}` } }));
		sessions.push({ id: `session-${index}`, path, modified: new Date(1000 + index) });
		if (index >= 2) processed[`session-${index}`] = 1000 + index;
	}
	const next = await recentMemorySessions(sessions, 0, "current", signal(), processed);
	assert.deepEqual(next.map(session => session.id), ["session-1", "session-0"]);
});

test("token-exhausted output never advances extraction or consolidation progress", async t => {
	const h = await harness(t, { authorize: async () => true, complete: () => async () => reply("unfinished", "length"),
		recentSessions: async () => [{ id: "other", modified: Date.now(), text: "feedback" }] });
	h.entries.push({ id: "user", type: "message", message: { role: "user", content: "Remember this" } });
	await h.command("extract");
	assert.equal(h.entries.some(entry => entry.customType === "grok-memory-cursor"), false);
	await h.command("consolidate");
	const memory = await loadProjectMemory(h.directory, h.root);
	await assert.rejects(readFile(join(memory.directory, ".last-consolidated")), { code: "ENOENT" });
	await assert.rejects(readFile(join(memory.directory, ".consolidation-progress")), { code: "ENOENT" });
});

test("recall deduplicates across calls, skips foreground reads, and enforces the cumulative context budget", async t => {
	const directory = await fixture(t);
	for (let index = 0; index < 20; index++) await writeFile(join(directory, `${index}.md`), `---\ndescription: ${index}\n---\n${"x".repeat(5000)}`);
	const store = new MemoryStore(directory);
	const state = createRecallState();
	state.read.push("19.md");
	let calls = 0;
	const complete = async (request: any) => {
		calls++;
		const question = JSON.parse(request.messages.at(-1).content);
		assert.ok(question.candidates.every((candidate: any) => !state.read.includes(candidate.name) && !state.surfaced.includes(candidate.name)));
		return reply(JSON.stringify({ selected_memories: question.candidates.slice(0, 5).map((candidate: any) => candidate.name) }));
	};
	await recallMemory(store, "preferences", complete, signal(), undefined, state);
	assert.equal(state.surfaced.length, 5);
	for (let index = 0; index < 5; index++) await recallMemory(store, `question ${index}`, complete, signal(), undefined, state);
	assert.ok(state.bytes <= MEMORY_RECALL_BYTES);
	assert.equal(new Set(state.surfaced).size, state.surfaced.length);
	const before = calls;
	await recallMemory(store, "question 4", complete, signal(), undefined, state);
	assert.equal(calls, before);
});

test("recall state survives resume, follows branch snapshots and resets on compaction", async t => {
	let calls = 0;
	const h = await harness(t, { authorize: async () => true, complete: () => async () => { calls++; return reply('{"selected_memories":["topic.md"]}'); } });
	const memory = await loadProjectMemory(h.directory, h.root);
	await writeFile(join(memory.directory, "topic.md"), "---\ndescription: preference\n---\nuseful note");
	const event = () => ({ prompt: "Which preferences apply?", systemPromptOptions: { sections: {} as Record<string, string> } });
	await h.emit("before_agent_start", event());
	assert.equal(calls, 1);
	await h.emit("session_start");
	const resumed = event();
	await h.emit("before_agent_start", resumed);
	assert.equal(calls, 1);
	assert.match(resumed.systemPromptOptions.sections.grok_recalled_memory, /useful note/);
	await h.emit("session_compact");
	await h.emit("before_agent_start", event());
	assert.equal(calls, 2);
	h.entries.splice(0);
	await h.emit("session_tree");
	await h.emit("before_agent_start", event());
	assert.equal(calls, 3);
});

test("foreground topic reads are remembered while recall is off and before background authorization", async t => {
	let calls = 0;
	const h = await harness(t, { options: { recall: false }, complete: () => async () => { calls++; return reply('{"selected_memories":["topic.md"]}'); } });
	const memory = await loadProjectMemory(h.directory, h.root);
	const path = join(memory.directory, "topic.md");
	await writeFile(path, "---\ndescription: preference\n---\nAlready read in the foreground");
	await h.emit("tool_result", { toolName: "read", input: { path }, isError: false });
	const saved = h.entries.filter(entry => entry.customType === "grok-memory-recall").at(-1);
	assert.deepEqual(saved.data.state.read, ["topic.md"]);
	await h.command("authorize");
	await h.command("recall on");
	await h.emit("session_start");
	await h.emit("before_agent_start", { prompt: "Recall preferences", systemPromptOptions: { sections: {} } });
	assert.equal(calls, 0, "already-read topics must not be selected again after enabling recall");
});

test("oversized worker inputs fail rather than silently cutting away unreviewed prose", async t => {
	const directory = await fixture(t);
	await assert.rejects(runMemoryPass({ store: new MemoryStore(directory), signal: signal(), policy: "policy", conversation: "x".repeat(80_001), mode: "extract", complete: async () => reply() }), /chunked/);
});
