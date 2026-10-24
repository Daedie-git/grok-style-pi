import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrStore, type HerdrTask } from "../src/herdr/store.ts";

async function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "herdr-lifecycle-store-"));
	const store = new HerdrStore(root);
	t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
	const sessionFile = await store.createSession({ type: "session", version: 3, id: "conversation", cwd: root });
	const task: HerdrTask = { id: "child", herdrName: "child", paneId: "w1:p2", type: "test", description: "test", prompt: "first", depth: 1, createdAt: new Date().toISOString(), cwd: root };
	const ref = (await store.reserveAgent(task, sessionFile, "owner", 1))!;
	await store.publish(ref, "first", true, 2);
	const binding = (await store.attach(task.paneId, sessionFile, "conversation"))!;
	return { root, store, sessionFile, task, ref, binding };
}

test("parking preserves the completed run and acknowledgement and fences the old child", async (t) => {
	const { store, ref, binding, task } = await fixture(t);
	await store.claimNextCommand(task.id, binding.token, false);
	await store.recordExecutionEvent(ref, binding.token, { type: "live" }, 3);
	await store.recordExecutionEvent(ref, binding.token, { type: "completed", result: "remember me" }, 3);
	assert.equal((await store.lifecycleCandidates())[0].acknowledged, false);
	await store.acknowledgeNotice(ref.runId);
	assert.equal((await store.lifecycleCandidates())[0].acknowledged, true);
	assert.equal(await store.parkAgent(ref, task.paneId, 4), true);
	assert.equal((await store.findAgent(task.id))?.paneState, "parked");
	assert.equal(await store.attach(task.paneId, binding.agent.sessionFile, "conversation"), undefined);
	assert.equal((await store.read(ref)).result, "remember me");
	assert.equal(await store.claimNextCommand(task.id, binding.token, false), undefined);
	await store.rebindPane(task.id, ref.runId, "w1:p3", "child");
	const next = await store.beginRun(task.id, ref.runId, "second", true, 5);
	assert.notEqual(next.runId, ref.runId);
	assert.equal((await store.findAgent(task.id))?.paneState, undefined);
	assert.equal(await store.parkAgent(ref, "w1:p3", 6), false);
});

test("cold resume readiness fails closed for missing or corrupt sessions", async (t) => {
	const { store, root, task, sessionFile } = await fixture(t);
	assert.equal(await store.coldResumeReady(task.id), true);
	writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 999, id: "conversation", cwd: root }) + "\n");
	assert.equal(await store.coldResumeReady(task.id), false);
	writeFileSync(sessionFile, "{bad json}");
	assert.equal(await store.coldResumeReady(task.id), false);
	rmSync(sessionFile);
	assert.equal(await store.coldResumeReady(task.id), false);
});

test("a parseable but unloadable Pi conversation cannot authorize a destructive close", async (t) => {
	const { store, ref, binding, task, sessionFile } = await fixture(t);
	await store.claimNextCommand(task.id, binding.token, false);
	await store.recordExecutionEvent(ref, binding.token, { type: "live" }, 3);
	await store.recordExecutionEvent(ref, binding.token, { type: "completed", result: "saved" }, 4);
	await store.acknowledgeNotice(ref.runId);
	const original = readFileSync(sessionFile, "utf8");
	const damaged = original + JSON.stringify({ type: "message", id: "broken", parentId: null, timestamp: new Date().toISOString() }) + "\n";
	writeFileSync(sessionFile, damaged);
	assert.equal(await store.coldResumeReady(task.id), false);
	assert.equal(await store.preparePaneClose(ref, task.paneId, false, 1_000_000), false);
	assert.equal((await store.findAgent(task.id))?.paneClose, undefined);
	assert.equal((await store.findAgent(task.id))?.paneState, undefined);
	assert.equal(readFileSync(sessionFile, "utf8"), damaged, "readiness must never rewrite the child's session");
});

test("owner closure stops an active run while an unexpected pane death fails it", async (t) => {
	const { store, ref, task } = await fixture(t);
	await store.closeOwnedAgent(ref, task.paneId, 3);
	assert.equal((await store.read(ref)).phase, "stopped");
	assert.equal((await store.findAgent(task.id))?.paneState, "parked");
	await store.rebindPane(task.id, ref.runId, "w1:p3", task.id);
	const next = await store.beginRun(task.id, ref.runId, "second", true, 4);
	await store.recordPaneClosed(next, 5);
	assert.equal((await store.read(next)).phase, "failed");
});

test("Claude readiness requires an intact transcript containing its own saved conversation", async (t) => {
	const { store, root, task, sessionFile } = await fixture(t);
	const claude = { ...task, id: "claude", herdrName: "claude", paneId: "w1:p4", runtime: "claude-code" as const };
	const ref = (await store.reserveAgent(claude, sessionFile, "owner", 1))!;
	await store.publish(ref, "first", true, 2);
	await store.attach(claude.paneId, sessionFile, "claude-conversation");
	const transcript = join(root, "claude-conversation.jsonl");
	await store.claudeHook(claude.id, { session_id: "claude-conversation", hook_event_name: "SessionEnd", transcript_path: transcript }, 3);
	const message = { sessionId: "claude-conversation", cwd: root, uuid: "message", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "saved response" }] } };
	for (const invalid of ["NOT JSON; damaged transcript", "{}\n", JSON.stringify({ ...message, sessionId: "someone-else" }), JSON.stringify({ ...message, isSidechain: true }), JSON.stringify(message) + "\n{truncated"]) {
		writeFileSync(transcript, invalid);
		assert.equal(await store.coldResumeReady(claude.id), false);
	}
	writeFileSync(transcript, JSON.stringify(message) + "\n");
	assert.equal(await store.coldResumeReady(claude.id), true);
	await store.requestCancellation(ref, 4);
	assert.equal(await store.coldResumeReady(claude.id), false);
});
