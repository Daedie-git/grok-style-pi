import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { HerdrClient } from "../src/herdr/client.ts";
import { HerdrRunner } from "../src/herdr/runner.ts";
import { HerdrStore, type AgentRecord, type RunSnapshot } from "../src/herdr/store.ts";

const execute = promisify(execFile);
const confirmation = "all-old-workers-stopped";
const ref = { agentId: "legacy-child", runId: "legacy-run" };
const token = "legacy-binding";
const pane = "w1:p2";

async function legacyWorker(root: string) {
	const worker = new Worker(new URL("./fixtures/legacy-control-worker.mjs", import.meta.url), {
		workerData: { root }, execArgv: ["--disable-warning=ExperimentalWarning"],
	});
	let closed = false;
	let sequence = 0;
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	const ready = new Promise<void>((resolve, reject) => {
		worker.on("message", (reply: { ready?: boolean; id: number; value?: unknown; error?: string }) => {
			if (reply.ready) { resolve(); return; }
			const request = pending.get(reply.id);
			pending.delete(reply.id);
			if (reply.error) request?.reject(new Error(reply.error));
			else request?.resolve(reply.value);
		});
		worker.on("error", (error) => { reject(error); for (const request of pending.values()) request.reject(error); pending.clear(); });
		worker.on("exit", () => { for (const request of pending.values()) request.reject(new Error("Legacy worker exited")); pending.clear(); });
	});
	await ready;
	function request<T = unknown>(message: Record<string, unknown>): Promise<T> {
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			worker.postMessage({ id, ...message });
		});
	}
	return {
		request,
		sql: <T = unknown>(sql: string, args: unknown[] = [], method = "run") => request<T>({ operation: "sql", sql, args, method }),
		close: async () => { if (!closed) { closed = true; await request({ operation: "close" }); } },
		terminate: () => worker.terminate(),
	};
}

async function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "herdr-upgrade-"));
	// Teardown is ordered explicitly so no worker can keep the SQLite files open during removal.
	const old = await legacyWorker(root);
	const sessionFile = join(root, "legacy-session.jsonl");
	writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "legacy-conversation", cwd: root }) + "\n");
	const agent: AgentRecord = {
		id: ref.agentId, currentRunId: ref.runId, paneId: pane, sessionFile, sessionId: "legacy-conversation",
		herdrName: ref.agentId, type: "test", description: "legacy child", prompt: "first", depth: 1,
		createdAt: "2000-01-01T00:00:00.000Z", cwd: root,
	};
	const run: RunSnapshot = { ...ref, phase: "running", accepted: true, cancelRequested: false, deadline: 100, turns: 1, updatedAt: 1 };
	await old.sql("INSERT INTO agents(id,pane,session_file,binding,data) VALUES(?,?,?,?,?)", [agent.id, pane, sessionFile, token, JSON.stringify(agent)]);
	await old.sql("INSERT INTO runs(id,agent,data) VALUES(?,?,?)", [ref.runId, ref.agentId, JSON.stringify(run)]);
	const store = new HerdrStore(root);
	t.after(async () => { await store.close(); await old.close(); await old.terminate(); rmSync(root, { recursive: true, force: true }); });
	return { root, old, store, agent, run };
}

async function assertPaused(store: HerdrStore) {
	assert.equal(await store.lifecycleAllowed(), false);
	const status = await store.lifecycleStatus();
	assert.equal(status.allowed, false);
	assert.equal(typeof status.reason, "string");
	assert.ok(status.reason.length > 0);
}

test("an already-open schema2 worker remains usable but lifecycle never enables from quiet time or new workers", async (t) => {
	const { root, old, store, agent } = await fixture(t);
	await assertPaused(store);
	assert.equal(await store.preparePaneClose(ref, pane, true, 1_000_000_000_000), false);
	await store.closeOwnedAgent(ref, pane, 1_000_000_000_000);
	assert.equal((await store.read(ref)).phase, "running");
	assert.deepEqual(await store.findAgent(ref.agentId), agent);
	assert.equal(await old.sql<{ binding: string }>("SELECT binding FROM agents WHERE id=?", [ref.agentId], "get").then((row) => row.binding), token);

	// Ordinary commands and execution results keep crossing the version boundary while quarantined.
	await store.steer(ref, "continue normally");
	const command = await old.sql<{ id: string; data: string }>("SELECT id,data FROM commands WHERE run=?", [ref.runId], "get");
	assert.equal(JSON.parse(command.data).text, "continue normally");
	await old.sql("UPDATE commands SET data=json_set(data,'$.state','delivered') WHERE id=?", [command.id]);
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed','$.result','legacy result','$.updatedAt',2) WHERE id=?", [ref.runId]);
	assert.equal((await store.read(ref)).result, "legacy result");
	assert.equal(await store.preparePaneClose(ref, pane, false, 9_000_000_000_000), false);
	assert.equal((await store.findAgent(ref.agentId))?.paneState, undefined);

	// Arbitrarily old timestamps, expired leases, and opening only new workers are not a drain attestation.
	await old.sql("UPDATE maintenance SET expires=0,next_at=0 WHERE id=1");
	await store.notePaneActivity(ref, 9_000_000_000_000);
	const another = new HerdrStore(root);
	try { await assertPaused(another); } finally { await another.close(); }
	await store.close();
	const reopened = new HerdrStore(root);
	try { await assertPaused(reopened); } finally { await reopened.close(); }
});

test("ownership and follow-up publication share the CAS against an independent legacy worker", async (t) => {
	const { old, store, agent } = await fixture(t);
	await assertPaused(store);
	const ownerA = { parentPaneId: "w1:p1", parentSessionFile: "/owner-a.jsonl", parentTabId: "w1:t1" };
	const ownerB = { parentPaneId: "w2:p99", parentSessionFile: "/owner-b.jsonl", parentWorkspaceId: "w2" };
	await old.sql("UPDATE agents SET data=? WHERE id=?", [JSON.stringify({ ...agent, ...ownerA }), agent.id]);
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed','$.result','first') WHERE id=?", [ref.runId]);
	const accepted = await old.request<{ agentId: string; runId: string }>({ operation: "beginRun", ref, prompt: "old caller wins", notify: true, now: 20 });
	const before = await store.findAgent(agent.id);
	await assert.rejects(store.beginRun(agent.id, ref.runId, "new caller loses", true, 21, ownerB), /already being resumed/);
	assert.deepEqual(await store.findAgent(agent.id), before, "losing CAS must not commit any ownership change");
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed','$.result','accepted old result') WHERE id=?", [accepted.runId]);
	assert.deepEqual((await store.notices(ownerA.parentPaneId)).map((notice) => notice.runId), [accepted.runId]);
	assert.deepEqual(await store.notices(ownerB.parentPaneId), []);
	await store.acknowledgeNotice(accepted.runId);
	const next = await store.beginRun(agent.id, accepted.runId, "new caller wins", true, 22, ownerB);
	const owned = (await store.findAgent(agent.id))!;
	assert.equal(owned.currentRunId, next.runId);
	assert.equal(owned.parentPaneId, ownerB.parentPaneId);
	assert.equal(owned.parentSessionFile, ownerB.parentSessionFile);
	assert.equal(owned.parentTabId, undefined, "old ownership fields clear in the same transaction");
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed','$.result','accepted new result') WHERE id=?", [next.runId]);
	assert.deepEqual(await store.notices(ownerA.parentPaneId), []);
	assert.deepEqual((await store.notices(ownerB.parentPaneId)).map((notice) => notice.runId), [next.runId]);
	assert.equal(await store.lifecycleAllowed(), false, "ordinary warm continuations remain usable during quarantine");
});

test("failed follow-up publication rolls ownership and run creation back together", async (t) => {
	const { old, store, agent } = await fixture(t);
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed') WHERE id=?", [ref.runId]);
	await store.adoptAgent(agent.id, ref.runId, { parentPaneId: "w1:p1", parentSessionFile: "/owner-a.jsonl" }, 20);
	const before = await store.findAgent(agent.id);
	await old.sql("CREATE TRIGGER reject_test_notice BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT,'injected notice failure'); END");
	await assert.rejects(store.beginRun(agent.id, ref.runId, "failed publication", true, 21,
		{ parentPaneId: "w2:p99", parentSessionFile: "/owner-b.jsonl" }), /injected notice failure/);
	assert.deepEqual(await store.findAgent(agent.id), before);
	const rows = await old.sql<{ count: number }>("SELECT count(*) AS count FROM runs WHERE agent=?", [agent.id], "get");
	assert.equal(rows.count, 1, "failed publication must not retain a new run");
	assert.deepEqual(await store.notices("w2:p99"), []);
});

test("old missing-pane maintenance ignores pending close intent without errors or losing the late result", async (t) => {
	const { old, store, agent } = await fixture(t);
	await assertPaused(store);
	const intent = { runId: ref.runId, paneId: pane, ownerGone: true };
	await old.sql("UPDATE agents SET data=? WHERE id=?", [JSON.stringify({ ...agent, paneClose: intent }), agent.id]);
	assert.equal(await old.request({ operation: "claimMaintenance", token: "old-maintenance", now: 10 }), true);
	assert.equal(await old.request({ operation: "finishMaintenance", token: "old-maintenance", now: 11, ref }), true);
	assert.equal((await store.read(ref)).phase, "running");
	assert.equal(await old.sql<{ binding: string }>("SELECT binding FROM agents WHERE id=?", [agent.id], "get").then((row) => row.binding), token);
	assert.deepEqual((await store.findAgent(agent.id))?.paneClose, intent);
	// Refusal may be an explicit error or a no-op; neither may settle a quarantined intent.
	await store.abortPaneClose(ref, pane).catch(() => undefined);
	assert.deepEqual((await store.findAgent(agent.id))?.paneClose, intent);
	await store.closeOwnedAgent(ref, pane, 12);
	assert.equal((await store.read(ref)).phase, "running");
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed','$.result','late completion','$.updatedAt',13) WHERE id=?", [ref.runId]);
	assert.equal((await store.read(ref)).phase, "completed");
	assert.equal((await store.read(ref)).result, "late completion");
	assert.equal(await store.parkAgent(ref, pane, 14), false);
	assert.deepEqual((await store.findAgent(agent.id))?.paneClose, intent);
});

test("explicit upgrade clears only stale intents left by an old warm follow-up and permits same-pane resume", async (t) => {
	const { root, old, store, agent, run } = await fixture(t);
	await assertPaused(store);
	const staleIntent = { runId: ref.runId, paneId: pane, ownerGone: true };
	await old.sql("UPDATE agents SET data=? WHERE id=?", [JSON.stringify({ ...agent, paneClose: staleIntent }), agent.id]);
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed','$.result','first result') WHERE id=?", [ref.runId]);
	const warm = await old.request<{ agentId: string; runId: string }>({ operation: "beginRun", ref, prompt: "legacy warm follow-up", now: 20 });
	assert.notEqual(warm.runId, ref.runId);
	await old.sql("UPDATE runs SET data=json_set(data,'$.phase','completed','$.accepted',json('true'),'$.result','warm result','$.updatedAt',21) WHERE id=?", [warm.runId]);
	await assertPaused(store);
	const before = (await store.findAgent(agent.id))!;
	const beforeRun = await store.read(warm);
	assert.equal(before.currentRunId, warm.runId);
	assert.deepEqual(before.paneClose, staleIntent, "old beginRun must retain its unknown paneClose property");
	const beforeBinding = await old.sql<{ binding: string }>("SELECT binding FROM agents WHERE id=?", [agent.id], "get");

	// A matching current intent must survive the same explicit cleanup transaction.
	const validRef = { agentId: "valid-intent-child", runId: "valid-intent-run" };
	const validAgent = { ...agent, id: validRef.agentId, currentRunId: validRef.runId, paneId: "w1:p3", paneClose: { runId: validRef.runId, paneId: "w1:p3", ownerGone: false } };
	const validRun = { ...run, ...validRef, phase: "completed" as const, result: "valid saved result" };
	await old.sql("INSERT INTO agents(id,pane,session_file,binding,data) VALUES(?,?,?,?,?)", [validAgent.id, validAgent.paneId, validAgent.sessionFile, "valid-binding", JSON.stringify(validAgent)]);
	await old.sql("INSERT INTO runs(id,agent,data) VALUES(?,?,?)", [validRef.runId, validRef.agentId, JSON.stringify(validRun)]);
	await old.close();
	assert.equal((await store.confirmLifecycleUpgrade(confirmation)).allowed, true);
	const { paneClose: _stale, ...withoutIntent } = before;
	assert.deepEqual(await store.findAgent(agent.id), withoutIntent, "cleanup may remove only the stale intent, not pane state or ownership");
	assert.deepEqual(await store.read(warm), beforeRun, "cleanup must preserve phase, cancellation and result");
	assert.deepEqual(await store.findAgent(validRef.agentId), validAgent);
	assert.deepEqual(await store.read(validRef), validRun);
	const reader = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
	try {
		assert.equal(reader.prepare("SELECT binding FROM agents WHERE id=?").get(agent.id)?.binding, beforeBinding.binding);
		assert.equal(reader.prepare("SELECT binding FROM agents WHERE id=?").get(validRef.agentId)?.binding, "valid-binding");
	} finally { reader.close(); }

	const unexpected = async () => { throw new Error("Warm resume must not create, close or restart a pane"); };
	let observedAlive = false;
	const client: HerdrClient = {
		split: unexpected, createTab: unexpected, startPi: unexpected, closePane: unexpected,
		isAlive: async () => true,
		getAgent: async (name) => { assert.equal(name, agent.herdrName); observedAlive = true; return { name, paneId: pane, session: agent.sessionFile, focused: false, status: "idle" }; },
		showLabel: unexpected, listAgents: unexpected, listPanes: unexpected,
	};
	const runner = new HerdrRunner({ root, client, now: () => 30 });
	try {
		const next = await runner.resume(agent.id, "new-code follow-up");
		assert.equal(observedAlive, true);
		assert.notEqual(next.runId, warm.runId);
		assert.equal((await runner.read(next)).phase, "queued");
		assert.equal((await runner.resolve(agent.id)).paneId, pane);
		assert.equal((await runner.resolve(agent.id)).sessionFile, agent.sessionFile);
	} finally { await runner.close(); }
});

test("unmarked legacy INSERT, UPDATE and DELETE immediately re-pause an explicitly enabled gate", async (t) => {
	const { old, store, agent, run } = await fixture(t);
	await assertPaused(store);
	const writes: [string, unknown[]][] = [
		["INSERT INTO agents(id,pane,session_file,data) VALUES(?,?,?,?)", ["other-agent", "w1:p3", agent.sessionFile, JSON.stringify({ ...agent, id: "other-agent" })]],
		["DELETE FROM agents WHERE id=?", ["other-agent"]],
		["INSERT INTO runs(id,agent,data) VALUES(?,?,?)", ["other-run", ref.agentId, JSON.stringify({ ...run, runId: "other-run" })]],
		["DELETE FROM runs WHERE id=?", ["other-run"]],
		["UPDATE agents SET data=json_set(data,'$.lastActivityAt',4) WHERE id=?", [ref.agentId]],
		["UPDATE runs SET data=json_set(data,'$.updatedAt',5) WHERE id=?", [ref.runId]],
		["INSERT INTO commands(id,run,data) VALUES(?,?,?)", ["legacy-command", ref.runId, JSON.stringify({ ...ref, id: "legacy-command", type: "steer", text: "old", state: "queued" })]],
		["UPDATE commands SET data=json_set(data,'$.state','delivered') WHERE id=?", ["legacy-command"]],
		["DELETE FROM commands WHERE id=?", ["legacy-command"]],
		["UPDATE maintenance SET token='old',expires=10 WHERE id=1", []],
	];
	for (const [sql, args] of writes) {
		// Deliberately false attestation simulates an overlooked old worker; its next write must revoke permission.
		assert.equal((await store.confirmLifecycleUpgrade(confirmation)).allowed, true);
		assert.equal(await store.lifecycleAllowed(), true);
		await old.sql(sql, args);
		await assertPaused(store);
	}
});

test("a pristine database permits lifecycle and current-worker transactions do not taint its gate", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-fresh-upgrade-"));
	const store = new HerdrStore(root);
	t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
	assert.equal(await store.lifecycleAllowed(), true);
	const session = await store.createSession({ type: "session", version: 3, id: "fresh", cwd: root });
	const task = { id: "fresh-child", herdrName: "fresh", paneId: pane, type: "test", description: "fresh", prompt: "first", depth: 1, cwd: root, createdAt: new Date().toISOString() };
	const fresh = (await store.reserveAgent(task, session, "owner", 1))!;
	await store.publish(fresh, "first", true, 2);
	const binding = (await store.attach(pane, session, "fresh"))!;
	await store.claimNextCommand(task.id, binding.token, false);
	await store.recordExecutionEvent(fresh, binding.token, { type: "live" }, 3);
	await store.steer(fresh, "keep going");
	assert.equal(await store.claimMaintenance("new-maintenance", 10), true);
	await store.finishMaintenance("new-maintenance", [{ ref: fresh, alive: true }], 11);
	await store.recordExecutionEvent(fresh, binding.token, { type: "completed", result: "new result" }, 12);
	await store.acknowledgeNotice(fresh.runId);
	assert.equal((await store.lifecycleStatus()).allowed, true);
	assert.equal(await store.preparePaneClose(fresh, pane, false, 13), true);
	await store.abortPaneClose(fresh, pane);
	assert.equal(await store.parkAgent(fresh, pane, 14), true);
	assert.equal(await store.lifecycleAllowed(), true);
	await store.close();
	const reopened = new HerdrStore(root);
	try { assert.equal(await reopened.lifecycleAllowed(), true); } finally { await reopened.close(); }
});

test("an old worker opening a fresh current database re-pauses it even when maintenance INSERT is ignored", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-old-opens-fresh-"));
	const store = new HerdrStore(root);
	let old: Awaited<ReturnType<typeof legacyWorker>> | undefined;
	t.after(async () => { await store.close(); await old?.close(); await old?.terminate(); rmSync(root, { recursive: true, force: true }); });
	assert.equal(await store.lifecycleAllowed(), true);
	old = await legacyWorker(root);
	await assertPaused(store);
	const maintenance = await old.sql<{ count: number }>("SELECT count(*) AS count FROM maintenance", [], "get");
	assert.equal(maintenance.count, 1, "the ignored old INSERT must revoke permission without inserting another row");
});

test("upgrade needs the exact explicit confirmation and survives a worker restart", async (t) => {
	const { root, old, store } = await fixture(t);
	await assertPaused(store);
	for (const invalid of ["", "yes", "all-old-workers-stopped "]) {
		await store.confirmLifecycleUpgrade(invalid).catch(() => undefined);
		await assertPaused(store);
	}
	await old.close();
	assert.equal((await store.confirmLifecycleUpgrade(confirmation)).allowed, true);
	await store.close();
	const reopened = new HerdrStore(root);
	try { assert.equal(await reopened.lifecycleAllowed(), true); } finally { await reopened.close(); }
});

test("lifecycle-upgrade CLI status never creates a missing database or root", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "herdr-status-missing-"));
	t.after(() => { rmSync(parent, { recursive: true, force: true }); });
	const cli = fileURLToPath(new URL("../src/herdr/lifecycle-upgrade.mjs", import.meta.url));
	for (const root of [parent, join(parent, "missing-root")]) {
		const { stdout } = await execute(process.execPath, [cli, "--root", root, "--status"]);
		const status = JSON.parse(stdout) as { database: string; allowed: boolean; reason: string };
		assert.equal(status.database, join(root, "control.sqlite"));
		assert.equal(status.allowed, false);
		assert.equal(typeof status.reason, "string");
		assert.ok(status.reason.length > 0);
		assert.equal(existsSync(join(root, "control.sqlite")), false);
	}
	assert.deepEqual(readdirSync(parent), [], "--status must not create database files or the missing root");
});

test("lifecycle-upgrade CLI status is read-only and explicit confirmation enables an isolated old database", async (t) => {
	const { root, old, store } = await fixture(t);
	await assertPaused(store);
	await old.close();
	await store.close();
	const cli = fileURLToPath(new URL("../src/herdr/lifecycle-upgrade.mjs", import.meta.url));
	const status = async () => {
		const { stdout } = await execute(process.execPath, [cli, "--root", root, "--status"]);
		return JSON.parse(stdout) as { allowed: boolean; reason: string };
	};
	const beforeStatus = readFileSync(join(root, "control.sqlite"));
	assert.equal((await status()).allowed, false);
	assert.equal((await status()).allowed, false, "status must never acknowledge a legacy worker drain");
	assert.deepEqual(readFileSync(join(root, "control.sqlite")), beforeStatus, "--status must not write the control database");
	await assert.rejects(execute(process.execPath, [cli, "--root", root]), "a missing confirmation must not enable lifecycle");
	assert.equal((await status()).allowed, false);
	await execute(process.execPath, [cli, "--root", root, "--confirm-old-workers-stopped"]);
	const enabled = await status();
	assert.equal(enabled.allowed, true);
	assert.equal(typeof enabled.reason, "string");
	const reopened = new HerdrStore(root);
	try { assert.equal(await reopened.lifecycleAllowed(), true); } finally { await reopened.close(); }
});
