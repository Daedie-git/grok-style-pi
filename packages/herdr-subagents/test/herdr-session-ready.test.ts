import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { piSessionReady } from "../src/herdr/session-ready.ts";

const cwd = "/workspace";
const timestamp = "2026-10-24T00:00:00.000Z";
function session(entries: unknown[] = []) {
	const header = { type: "session", version: 3, id: "conversation", cwd, timestamp };
	return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
const identity = { cwd, sessionId: "conversation" };
const base = { type: "message", id: "message", parentId: null, timestamp };
const user = { ...base, message: { role: "user", content: "saved prompt", timestamp: 1 } };

test("Pi readiness rejects the reviewer's parseable message that the real loader cannot reconstruct", () => {
	const manager = SessionManager.inMemory(cwd, undefined, JSON.parse(`[${session([base]).trim().split("\n").join(",")}]`) as FileEntry[]);
	assert.throws(() => manager.buildSessionContext(), /role/);
	assert.equal(piSessionReady(session([base]), identity), false);
});

test("Pi readiness rejects malformed tree and message structures without hanging", () => {
	const invalid: unknown[][] = [
		[null], [42], [{}], [base], [{ ...user, message: null }], [{ ...user, message: { role: "assistant", content: "wrong shape", timestamp: 1 } }],
		[{ ...user, id: undefined }], [{ ...user, parentId: "message" }], [{ ...user, parentId: "missing-parent" }], [user, user],
		[{ ...user, timestamp: "not a date" }], [{ ...user, message: { ...user.message, content: [{ type: "text" }] } }],
		[{ ...base, type: "compaction", summary: 42, firstKeptEntryId: "message", tokensBefore: 10 }],
		[user, { ...base, id: "edit", type: "context_edit", parentId: "message", targetId: "message", replacement: {} }],
	];
	for (const entries of invalid) assert.equal(piSessionReady(session(entries), identity), false, JSON.stringify(entries));
	assert.equal(piSessionReady(session([user]) + "{truncated", identity), false);
	assert.equal(piSessionReady(session([user]), { ...identity, sessionId: "another" }), false);
});

test("Pi readiness accepts SDK-generated branching, compaction, custom data and edited context without rewriting it", () => {
	const manager = SessionManager.inMemory(cwd);
	manager.appendModelChange("provider", "model");
	manager.appendThinkingLevelChange("high");
	const userId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "remember this" }], timestamp: 1 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "remembered" }], api: "test", provider: "provider", model: "model", timestamp: 2,
		stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	manager.appendCustomEntry("test-state", { arbitrary: [null, 42] });
	manager.appendCustomMessageEntry("test-notice", "additional context", true);
	manager.appendContextEdit(userId, { content: "revised prompt" });
	manager.appendCompaction("retained summary", userId, 100);
	const text = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	assert.ok(manager.buildSessionContext().messages.length > 0);
	assert.equal(piSessionReady(text, { cwd, sessionId: manager.getSessionId() }), true);
	assert.equal(JSON.stringify(manager.getEntries()), JSON.stringify(JSON.parse(`[${text.trim().split("\n").slice(1).join(",")}]`)));
});
