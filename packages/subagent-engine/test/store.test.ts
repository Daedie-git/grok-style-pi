import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentMeta, NoticeRecord } from "../src/types.ts";
import { InboxStore } from "../src/store/inbox.ts";
import { listMetas, readMeta, StoreCorruptionError, writeMeta } from "../src/store/meta.ts";
import { Outbox } from "../src/store/outbox.ts";
import { agentFiles, engineRoot, newAgentId, newRunId, sessionDir } from "../src/store/paths.ts";

function fixture(t: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-store-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function notice(): Omit<NoticeRecord, "key" | "sequence" | "state" | "createdAt"> {
	return {
		rootSessionId: "root", agentId: "agent", runId: "run", kind: "terminal_result", destination: "root", passive: false,
		payload: { agentId: "agent", description: "test", status: "completed", resultText: "result", resultTruncated: false, transcriptPath: "transcript", resumable: true },
	};
}

function meta(): AgentMeta {
	return {
		agentId: "agent", agentType: "worker", rootSessionId: "root", description: "test", spawnDepth: 1,
		cwd: "cwd", sessionFile: "session", taskListId: "tasks", backend: "in-process", stopGeneration: 0, runs: [],
		definition: { agentType: "worker", description: "test", prompt: "prompt", source: "user", skills: [], disallowedTools: [], diagnostics: [] },
	};
}

const message = { acceptanceKey: "call-1", from: "main", to: "agent", text: "continue" };

test("paths are canonical and generated identities have independent prefixes", () => {
	assert.equal(engineRoot("home"), join("home", "subagents"));
	assert.equal(sessionDir("home", "root"), join("home", "subagents", "root"));
	assert.deepEqual(agentFiles("home", "root", "agent"), {
		sessionFile: join("home", "subagents", "root", "agent-agent.jsonl"),
		metaFile: join("home", "subagents", "root", "agent-agent.meta.json"),
		inboxFile: join("home", "subagents", "root", "agent-agent.inbox.jsonl"),
	});
	assert.match(newAgentId(), /^a[0-9a-f]{16}$/);
	assert.match(newRunId(), /^r[0-9a-f]{16}$/);
	assert.equal(new Set(Array.from({ length: 100 }, newAgentId)).size, 100);
	for (const value of ["../outside", "..", "a\\b", "a:b", ""]) assert.throws(() => sessionDir("home", value));
});

test("metadata replaces existing files and omits absent optional fields", t => {
	const dir = fixture(t);
	const file = join(dir, "nested", "agent-agent.meta.json");
	assert.equal(readMeta(file), undefined);
	assert.deepEqual(listMetas(join(dir, "missing")), []);
	writeMeta(file, { ...meta(), name: "old", model: { effective: "model", requested: undefined } });
	assert.equal(Object.hasOwn(readMeta(file)!.model!, "requested"), false);
	writeMeta(file, { ...meta(), name: undefined });
	const loaded = readMeta(file)!;
	assert.deepEqual(loaded, meta());
	for (const key of ["name", "model", "isFork", "stoppedByUser", "worktree"]) assert.equal(Object.hasOwn(loaded, key), false);
	assert.deepEqual(listMetas(join(dir, "nested")), [meta()]);
	assert.deepEqual(readdirSync(join(dir, "nested")), ["agent-agent.meta.json"]);
	for (const text of ["{torn", "null", "{}", '{"agentId": 3}']) {
		writeFileSync(file, text);
		assert.throws(() => readMeta(file), StoreCorruptionError);
	}
});

test("outbox sequences identities once, retries preserve payload, later runs are new", t => {
	const outbox = new Outbox(join(fixture(t), "outbox.jsonl"));
	const first = outbox.create(notice());
	assert.equal(first.sequence, 1);
	assert.equal(first.key, "root:agent:run:terminal_result:1");
	assert.deepEqual(outbox.create({ ...notice(), payload: { ...notice().payload, resultText: "changed" } }), first);
	const interim = outbox.create({ ...notice(), kind: "interim_handback" });
	assert.equal(interim.sequence, 2);
	const later = outbox.create({ ...notice(), runId: "next-run" });
	assert.equal(later.sequence, 1);
	assert.notEqual(later.key, first.key);
	outbox.mark([first.key], "acknowledged");
	assert.equal(outbox.create(notice()).sequence, 3);
	first.payload.resultText = "caller mutation";
	assert.equal(outbox.get(first.key)!.payload.resultText, "result");
	assert.equal(outbox.pending("elsewhere").length, 0);
});

test("outbox recovers submitted only and observes persisted receipts without acknowledging", t => {
	const file = join(fixture(t), "outbox.jsonl");
	const first = new Outbox(file);
	const submitted = first.create(notice());
	const persisted = first.create({ ...notice(), kind: "interim_handback" });
	const acknowledged = first.create({ ...notice(), runId: "old-run" });
	first.mark([submitted.key], "submitted");
	assert.deepEqual(first.observePersisted([
		{ type: "custom_message", customType: "other", details: { noticeKeys: [submitted.key] } },
		{ type: "custom_message", customType: "subagent-notification", details: { noticeKeys: [persisted.key, persisted.key, "unknown", 4] } },
	]), [persisted.key]);
	first.mark([acknowledged.key], "acknowledged");
	const loaded = new Outbox(file);
	assert.equal(loaded.get(submitted.key)!.state, "pending");
	assert.equal(loaded.get(persisted.key)!.state, "persisted");
	assert.equal(loaded.get(acknowledged.key)!.state, "acknowledged");
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);
	loaded.mark([submitted.key], "submitted");
	loaded.mark([submitted.key], "pending");
	assert.equal(loaded.get(submitted.key)!.state, "pending");
	loaded.mark([submitted.key], "submitted");
	loaded.recover();
	assert.equal(loaded.get(submitted.key)!.state, "pending");
	loaded.mark([persisted.key], "submitted");
	assert.equal(loaded.get(persisted.key)!.state, "persisted");
	assert.deepEqual(new Outbox(file).pending().map(record => record.key), [submitted.key]);
});

test("inbox acceptance retries are durable and every payload field participates in conflicts", t => {
	const file = join(fixture(t), "inbox.jsonl");
	const inbox = new InboxStore(file);
	const accepted = inbox.accept({ ...message, noticeKey: "notice-1" });
	assert.ok("envelope" in accepted);
	assert.equal(accepted.duplicate, false);
	assert.equal(Object.hasOwn(accepted.envelope, "summary"), false);
	const loaded = new InboxStore(file);
	assert.deepEqual(loaded.accept({ ...message, noticeKey: "notice-1" }), { ...accepted, duplicate: true });
	for (const change of [{ text: "new" }, { from: "other" }, { to: "other" }, { summary: "new" }, { noticeKey: "notice-2" }, { noticeKey: undefined }]) {
		assert.deepEqual(loaded.accept({ ...message, noticeKey: "notice-1", ...change }), { conflict: true });
	}
	accepted.envelope.text = "caller mutation";
	assert.equal(loaded.all()[0].text, "continue");
});

test("inbox selection and persistence are not inclusion, and pending can be restored", t => {
	const file = join(fixture(t), "inbox.jsonl");
	const inbox = new InboxStore(file);
	const result = inbox.accept(message);
	assert.ok("envelope" in result);
	const id = result.envelope.id;
	for (const state of ["submitted", "persisted", "prepared"] as const) {
		inbox.setState(id, state, { runId: "run" });
		assert.equal(new InboxStore(file).undelivered()[0].state, state);
	}
	inbox.setState(id, "pending");
	assert.equal(Object.hasOwn(inbox.all()[0], "runId"), false);
	for (const state of ["included", "consumed", "refused"] as const) {
		inbox.setState(id, state, state === "refused" ? { refusedReason: "stopped" } : undefined);
		assert.deepEqual(new InboxStore(file).undelivered(), []);
	}
	assert.equal(new InboxStore(file).all()[0].refusedReason, "stopped");
	assert.throws(() => inbox.setState("missing", "pending"));
});

test("torn final lines are ignored and removed before subsequent appends", t => {
	const dir = fixture(t);
	const out = join(dir, "outbox.jsonl");
	const input = join(dir, "inbox.jsonl");
	const noticeRecord = new Outbox(out).create(notice());
	const accepted = new InboxStore(input).accept(message);
	assert.ok("envelope" in accepted);
	for (const file of [out, input]) appendFileSync(file, '{"state":"sub');
	const recoveredOut = new Outbox(out);
	const recoveredInbox = new InboxStore(input);
	assert.equal(recoveredOut.get(noticeRecord.key)!.sequence, 1);
	assert.equal(recoveredInbox.all()[0].id, accepted.envelope.id);
	recoveredOut.mark([noticeRecord.key], "persisted");
	recoveredInbox.setState(accepted.envelope.id, "included");
	assert.equal(new Outbox(out).get(noticeRecord.key)!.state, "persisted");
	assert.equal(new InboxStore(input).all()[0].state, "included");
	for (const file of [out, input]) writeFileSync(file, '{"bad":true}\n');
	assert.throws(() => new Outbox(out), StoreCorruptionError);
	assert.throws(() => new InboxStore(input), StoreCorruptionError);
});

test("public store APIs persist between independent caller processes", t => {
	const dir = fixture(t);
	const outboxUrl = new URL("../src/store/outbox.ts", import.meta.url).href;
	const inboxUrl = new URL("../src/store/inbox.ts", import.meta.url).href;
	const code = `import { Outbox } from ${JSON.stringify(outboxUrl)};
		import { InboxStore } from ${JSON.stringify(inboxUrl)};
		const outbox = new Outbox(${JSON.stringify(join(dir, "outbox.jsonl"))});
		const inbox = new InboxStore(${JSON.stringify(join(dir, "inbox.jsonl"))});
		const notice = outbox.create(${JSON.stringify(notice())});
		const accepted = inbox.accept(${JSON.stringify(message)});
		console.log(JSON.stringify({state: notice.state, sequence: notice.sequence, duplicate: accepted.duplicate}));
		outbox.mark([notice.key], "submitted");`;
	for (const duplicate of [false, true]) {
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout), { state: "pending", sequence: 1, duplicate });
	}
});
