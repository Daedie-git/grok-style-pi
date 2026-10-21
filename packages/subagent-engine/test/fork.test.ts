import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildForkEntries, writeForkSession, type ForkSnapshotInput } from "../src/context/fork.ts";

const now = () => "2026-10-21T12:00:00.000Z";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(ids: string[], names: string[] = ids.map(() => "read")): AssistantMessage {
	return { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
		content: ids.map((id, i) => ({ type: "toolCall", id, name: names[i], arguments: { path: "/repo/file" } })),
		usage: structuredClone(ZERO), stopReason: "toolUse", timestamp: 1 };
}
function user(manager: SessionManager, content: string): string {
	return manager.appendMessage({ role: "user", content, timestamp: 1 });
}
function result(manager: SessionManager, id: string, text: string, name = "read"): string {
	return manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 2 });
}
function parent(): SessionManager {
	return SessionManager.inMemory(process.cwd());
}
function input(manager: SessionManager, extra: Partial<ForkSnapshotInput> = {}): ForkSnapshotInput {
	return { branch: manager.getBranch(), spawningToolCallId: "spawn", directive: "Perform only the fork assignment.",
		childSessionId: "fork-test", cwd: process.cwd(), parentSessionFile: "/state/parent.jsonl", now, ...extra };
}
function temp(t: TestContext): string {
	const captures = resolve("captures");
	mkdirSync(captures, { recursive: true });
	const root = mkdtempSync(join(captures, "fork-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function validate(entries: SessionEntry[]): void {
	const ids = new Set<string>();
	entries.forEach((entry, i) => {
		assert.equal(entry.parentId, entries[i - 1]?.id ?? null);
		assert(!ids.has(entry.id));
		ids.add(entry.id);
	});
	const context = buildSessionContext(entries, entries.at(-1)?.id);
	const pending = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant" || message.role === "user") assert.equal(pending.size, 0, "a new turn cannot interrupt an unresolved tool group");
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") { assert(!pending.has(block.id)); pending.add(block.id); }
		} else if (message.role === "toolResult") {
			assert(pending.delete(message.toolCallId), `orphan/duplicate result ${message.toolCallId}`);
		}
	}
	assert.equal(pending.size, 0, "every tool call must have a result");
}
function persist(t: TestContext, built: ReturnType<typeof buildForkEntries>): SessionManager {
	const file = join(temp(t), "nested", "child.jsonl");
	writeForkSession(file, built);
	const opened = SessionManager.open(file);
	assert.deepEqual(opened.getEntries(), JSON.parse(JSON.stringify(built.entries)));
	assert.deepEqual(opened.buildSessionContext(), buildSessionContext(built.entries));
	validate(opened.getEntries());
	return opened;
}

test("finished sibling Read is partitioned and every spawning call gets exactly one placeholder", (t) => {
	const source = parent();
	user(source, "Original user task");
	const spawn = source.appendMessage(assistant(["sibling", "spawn"], ["read", "Agent"]));
	const sibling = result(source, "sibling", "REAL SIBLING OUTPUT MUST NOT LEAK");
	const snapshot = input(source);
	const original = { ...snapshot, branch: structuredClone(snapshot.branch) };
	const built = buildForkEntries(snapshot);
	assert.deepEqual(snapshot, original);
	assert(built.removed.includes(spawn));
	assert(built.removed.includes(sibling));
	assert(!JSON.stringify(built).includes("REAL SIBLING OUTPUT"));
	const callEntry = built.entries.find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
	assert.notEqual(callEntry.id, spawn);
	const messages = persist(t, built).buildSessionContext().messages;
	assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult", "user"]);
	const results = messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(results.map((message) => message.toolCallId), ["sibling", "spawn"]);
	for (const message of results) assert.deepEqual(message.details, { forkPlaceholder: true });
	assert.equal(built.header.version, 3);
	assert.equal(built.header.id, "fork-test");
	assert.equal(built.header.parentSession, "/state/parent.jsonl");
	assert.equal((messages.at(-1) as { content: string }).content, snapshot.directive);
});

test("a sequential batch keeps earlier completed groups and repairs the spawning group only", (t) => {
	const source = parent();
	user(source, "Find and inspect");
	const previous = source.appendMessage(assistant(["first", "second"], ["find", "read"]));
	result(source, "second", "Earlier read survives");
	result(source, "first", "Earlier find survives", "find");
	const spawn = source.appendMessage(assistant(["write-sibling", "spawn"], ["write", "Agent"]));
	const real = result(source, "write-sibling", "Write sibling real output", "write");
	const built = buildForkEntries(input(source));
	assert(!built.removed.includes(previous));
	assert(built.removed.includes(spawn));
	assert(built.removed.includes(real));
	const text = JSON.stringify(persist(t, built).buildSessionContext());
	assert(text.includes("Earlier read survives"));
	assert(text.includes("Earlier find survives"));
	assert(!text.includes("Write sibling real output"));
});

test("older incomplete assistants and all their partial results are removed, including orphan results", (t) => {
	const source = parent();
	user(source, "Task");
	const dangling = source.appendMessage(assistant(["done", "missing"]));
	const partial = result(source, "done", "Partial result that must disappear");
	user(source, "Continue after interruption");
	const orphan = result(source, "no-call", "Orphan result");
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source));
	for (const id of [dangling, partial, orphan]) assert(built.removed.includes(id));
	const text = JSON.stringify(persist(t, built).buildSessionContext());
	assert(!text.includes("Partial result that must disappear"));
	assert(!text.includes("Orphan result"));
});

test("surviving compaction anchors retain Pi's summary and kept range", (t) => {
	const source = parent();
	user(source, "Summarized old task");
	const kept = user(source, "Kept user context");
	const checkpoint = source.appendCompaction("Current summary", kept, 500);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source));
	const compaction = built.entries.find((entry) => entry.id === checkpoint);
	assert(compaction?.type === "compaction");
	assert.equal(compaction.firstKeptEntryId, kept);
	const text = JSON.stringify(persist(t, built).buildSessionContext());
	assert(text.includes("Current summary"));
	assert(text.includes("Kept user context"));
	assert(!text.includes("Summarized old task"));
});

test("missing latest compaction anchor rebases its summary without reviving an older checkpoint", (t) => {
	const source = parent();
	source.appendModelChange("anthropic", "claude-sonnet-4-5");
	source.appendThinkingLevelChange("high");
	const old = user(source, "Already summarized raw history");
	const obsolete = source.appendCompaction("Obsolete summary", old, 100);
	const dangling = source.appendMessage(assistant(["missing"]));
	user(source, "Surviving retained range");
	source.appendMessage({ role: "system", content: "Checkpoint system state", timestamp: 1 });
	const latest = source.appendCompaction("Newest summary", dangling, 1000);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source));
	assert.equal(built.entries[0].id, latest);
	assert(built.entries[0].type === "compaction");
	assert.equal(built.entries[0].firstKeptEntryId, latest);
	assert(built.removed.includes(obsolete));
	const context = persist(t, built).buildSessionContext();
	const text = JSON.stringify(context);
	assert(text.includes("Newest summary"));
	assert(text.includes("Surviving retained range"));
	assert(!text.includes("Obsolete summary"));
	assert(!text.includes("Already summarized raw history"));
	assert.equal(context.thinkingLevel, "high");
	assert.equal(context.messages.filter((message) => message.role === "system").length, 1, "pre-compaction system messages must stay folded into the checkpoint");
});

test("removing an older broken checkpoint also repairs newer checkpoints anchored to it", (t) => {
	const source = parent();
	user(source, "Old content");
	const missing = source.appendMessage(assistant(["lost-result"]));
	const oldCheckpoint = source.appendCompaction("Old checkpoint", missing, 100);
	user(source, "Still-retained context");
	const newest = source.appendCompaction("Newest checkpoint", oldCheckpoint, 200);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source));
	assert.equal(built.entries[0].id, newest);
	assert(built.removed.includes(oldCheckpoint));
	const text = JSON.stringify(persist(t, built).buildSessionContext());
	assert(text.includes("Newest checkpoint"));
	assert(text.includes("Still-retained context"));
	assert(!text.includes("Old checkpoint"));
});

test("context edits materialize latest replacements and omissions into independent copies", (t) => {
	const source = parent();
	const originalUser = user(source, "Original user content");
	const deletedAssistant = source.appendMessage(assistant(["deleted-call"]));
	const deletedResult = result(source, "deleted-call", "Deleted assistant result");
	source.appendMessage(assistant(["kept-call"]));
	const editedResult = result(source, "kept-call", "Original tool content");
	const custom = source.appendCustomMessageEntry("agent-message", "Original custom content", true);
	source.appendContextEdit(originalUser, { content: "First replacement" });
	source.appendContextEdit(originalUser, { content: "Latest user replacement" });
	source.appendContextEdit(editedResult, { content: "Edited result content" });
	source.appendContextEdit(custom, { content: "Edited custom content" });
	source.appendContextEdit(deletedAssistant, null);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const snapshot = input(source);
	const original = structuredClone(snapshot.branch);
	const built = buildForkEntries(snapshot);
	assert.deepEqual(snapshot.branch, original);
	assert(!built.entries.some((entry) => entry.type === "context_edit"));
	assert(built.removed.includes(deletedAssistant));
	assert(built.removed.includes(deletedResult));
	const text = JSON.stringify(persist(t, built).buildSessionContext());
	for (const keep of ["Latest user replacement", "Edited result content", "Edited custom content"]) assert(text.includes(keep));
	for (const omit of ["Original user content", "Original tool content", "Original custom content", "Deleted assistant result", "First replacement"]) assert(!text.includes(omit));
});

test("omitting a result through a context edit removes its now-dangling assistant too", (t) => {
	const source = parent();
	user(source, "Task");
	const previous = source.appendMessage(assistant(["edited-away"]));
	const tool = result(source, "edited-away", "Removed result");
	source.appendContextEdit(tool, null);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source));
	assert(built.removed.includes(previous));
	assert(built.removed.includes(tool));
	persist(t, built);
});

test("an edit that removes a compaction anchor triggers rebasing and preserves the system checkpoint", (t) => {
	const source = parent();
	source.appendMessage({ role: "system", content: "Inherited system", timestamp: 1 });
	user(source, "Summarized old content");
	const kept = user(source, "Anchor removed by edit");
	const checkpoint = source.appendCompaction("Summary kept after edit", kept, 500);
	source.appendContextEdit(kept, null);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source));
	assert.equal(built.entries[0].id, checkpoint);
	const context = persist(t, built).buildSessionContext();
	assert(context.messages.some((message) => message.role === "system" && message.content === "Inherited system"));
	assert(!JSON.stringify(context).includes("Anchor removed by edit"));
	assert(JSON.stringify(context).includes("Summary kept after edit"));
});

test("compaction boundaries cannot leave a tool result without its assistant in model context", (t) => {
	const source = parent();
	user(source, "Task");
	const previous = source.appendMessage(assistant(["cut"]));
	const cut = result(source, "cut", "Result before retained range");
	source.appendCompaction("Boundary summary", cut, 400);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source));
	assert(built.removed.includes(cut));
	assert(built.removed.includes(previous));
	assert(JSON.stringify(persist(t, built).buildSessionContext()).includes("Boundary summary"));
});

test("writer creates a canonical session that reopens and appends, without overwriting existing files", (t) => {
	const source = parent();
	user(source, "Parent task");
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	const built = buildForkEntries(input(source, { parentSessionFile: undefined }));
	assert(!Object.hasOwn(built.header, "parentSession"));
	const opened = persist(t, built);
	const file = opened.getSessionFile()!;
	const originalBytes = readFileSync(file, "utf8");
	assert.throws(() => writeForkSession(file, built), /EEXIST/);
	assert.equal(readFileSync(file, "utf8"), originalBytes);
	user(opened, "Persisted continuation");
	const reopened = SessionManager.open(file);
	assert.equal(reopened.getSessionId(), "fork-test");
	assert.equal(reopened.getEntries().length, built.entries.length + 1);
	validate(reopened.getEntries());
	assert(JSON.stringify(reopened.buildSessionContext()).includes("Persisted continuation"));
});

test("invalid or ambiguous snapshots fail before creating files", () => {
	const source = parent();
	user(source, "Task");
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	assert.throws(() => buildForkEntries(input(source, { childSessionId: "../bad" })), /session ID/);
	assert.throws(() => buildForkEntries(input(source, { now: () => "invalid" })), /timestamp/);
	assert.throws(() => buildForkEntries(input(source, { spawningToolCallId: "missing" })), /exactly one/);
	const disconnected = structuredClone(source.getBranch());
	disconnected[1].parentId = "missing";
	assert.throws(() => buildForkEntries(input(source, { branch: disconnected })), /root-to-leaf/);
	const duplicate = structuredClone(source.getBranch());
	duplicate[1].id = duplicate[0].id;
	assert.throws(() => buildForkEntries(input(source, { branch: duplicate })), /duplicate entry ID/);
	source.appendMessage(assistant(["spawn"], ["Agent"]));
	assert.throws(() => buildForkEntries(input(source)), /exactly one/);
});

test("real AgentSession.prompt consumes the repaired file and remains resumable after dispose", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const root = temp(t);
	const source = parent();
	user(source, "Inherited user task");
	source.appendMessage(assistant(["sibling", "spawn"], ["read", "Agent"]));
	result(source, "sibling", "REAL OUTPUT MUST NOT BE SENT");
	const built = buildForkEntries(input(source, { cwd: root }));
	const file = join(root, "fork.jsonl");
	writeForkSession(file, built);
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let requests = 0;
	for (const prompt of ["Execute the directive", "Continue the same fork after reopen"]) {
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
			model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager: settings, sessionManager: SessionManager.open(file), resourceLoader: loader, tools: [] });
		try {
			session.agent.streamFunction = (model, context) => {
				requests++;
				const serialized = JSON.stringify(context.messages);
				assert(serialized.includes("Fork snapshot placeholder"));
				assert(serialized.includes("Perform only the fork assignment"));
				assert(!serialized.includes("REAL OUTPUT MUST NOT BE SENT"));
				if (requests === 2) assert(serialized.includes("Fork result 1"));
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = { ...assistant([]), api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text", text: `Fork result ${requests}` }], stopReason: "stop" };
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
				return stream;
			};
			await session.prompt(prompt, { source: "extension" });
			assert.equal(session.getLastAssistantText(), `Fork result ${requests}`);
		} finally { session.dispose(); }
	}
	assert.equal(requests, 2);
	const reopened = SessionManager.open(file);
	validate(reopened.getEntries());
	assert(JSON.stringify(reopened.buildSessionContext()).includes("Fork result 2"));
});
