import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ADMISSION_MS, installSteeringInbox, steerRoot, STEER_TTL_MS } from "../src/steering/inbox.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for Pi's asynchronous prompt admission: `sendUserMessage` returns nothing, samples whether a run is
 * active, and only after a preflight delay either starts the run (emitting `agent_start`), queues a steer, or - like
 * Pi - rejects the prompt when a run started meanwhile or compaction is in progress. Rejected texts are lost.
 */
function fakePi(preflightMs = 20) {
	const handlers = new Map<string, ((event: unknown, ctx: any) => void)[]>();
	const state = { active: false, compacting: false, delivered: [] as string[], lost: [] as string[], steered: [] as string[], notices: [] as string[], suppressStart: false };
	const ctx = { isIdle: () => !state.active && !state.compacting, sessionManager: { getSessionId: () => state.id }, ui: { notify: (m: string) => state.notices.push(m) } } as any;
	const emit = (name: string, event: unknown = {}) => { for (const h of handlers.get(name) ?? []) h(event, ctx); };
	const pi = {
		on: ((name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }) as any,
		sendUserMessage: ((text: string) => {
			const sawActive = state.active;
			setTimeout(() => {
				if (state.compacting) return void state.lost.push(text);
				if (sawActive) { state.steered.push(text); state.delivered.push(text); return; }
				if (state.active) return void state.lost.push(text);
				if (state.suppressStart) return void state.lost.push(text);
				state.active = true;
				state.delivered.push(text);
				emit("agent_start");
			}, preflightMs);
		}) as any,
	};
	return { pi, state: Object.assign(state, { id: "cc-test-3" }), ctx, emit, handlers };
}

function fixture(t: TestContext, sessionId = "cc-test-3", options: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	const fake = fakePi();
	fake.state.id = sessionId;
	installSteeringInbox(fake.pi, { root, pollMs: 10, ...options });
	fake.emit("session_start");
	t.after(() => { fake.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); });
	const dir = join(root, sessionId);
	const drop = (id: string, body: unknown) => {
		writeFileSync(join(dir, `${id}.tmp`), typeof body === "string" ? body : JSON.stringify(body));
		renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
	};
	const ack = async (id: string, waitMs = 2000) => {
		for (let i = 0; i < waitMs / 10 && !existsSync(join(dir, `${id}.ack`)); i++) await sleep(10);
		return JSON.parse(readFileSync(join(dir, `${id}.ack`), "utf8"));
	};
	return { root, dir, drop, ack, ...fake };
}

test("a message dropped in the session inbox steers a working agent and is acknowledged", async (t) => {
	const f = fixture(t);
	f.state.active = true;
	f.drop("a", { text: "Stop refactoring; fix the test first.", from: "Claude Code", sentAt: Date.now() });
	assert.deepEqual(await f.ack("a"), { status: "delivered", delivery: "steer" });
	await sleep(50);
	assert.deepEqual(f.state.steered, ["[Steering message from Claude Code]\nStop refactoring; fix the test first."]);
	assert.match(f.state.notices[0]!, /Steering message received from Claude Code/);
	assert.equal(existsSync(join(f.dir, "a.json")), false);
	assert.equal(existsSync(join(f.dir, "a.taken")), false);
});

test("an idle agent gets a prompt, acknowledged only once Pi starts a run", async (t) => {
	const f = fixture(t);
	f.drop("1", { text: "first" });
	await sleep(8);
	assert.equal(existsSync(join(f.dir, "1.ack")), false);
	assert.deepEqual(await f.ack("1"), { status: "delivered", delivery: "prompt" });
	assert.deepEqual(f.state.delivered, ["[Steering message from external sender]\nfirst"]);
});

test("a burst to an idle session loses nothing: one prompt starts the run and the rest steer it", async (t) => {
	const f = fixture(t);
	for (const id of ["1", "2", "3"]) f.drop(id, { text: `message ${id}` });
	const acks = [await f.ack("1"), await f.ack("2"), await f.ack("3")];
	assert.deepEqual(acks, [{ status: "delivered", delivery: "prompt" }, { status: "delivered", delivery: "steer" }, { status: "delivered", delivery: "steer" }]);
	await sleep(60);
	assert.deepEqual(f.state.lost, []);
	assert.deepEqual(f.state.delivered.map((m) => m.split("\n")[1]), ["message 1", "message 2", "message 3"]);
});

test("nothing is dispatched during compaction; queued messages are delivered after it", async (t) => {
	const f = fixture(t);
	f.emit("session_before_compact");
	f.state.compacting = true;
	f.drop("1", { text: "wait for compaction" });
	await sleep(120);
	assert.deepEqual(f.state.lost, []);
	assert.equal(existsSync(join(f.dir, "1.json")), true);
	assert.equal(existsSync(join(f.dir, "1.ack")), false);
	f.state.compacting = false;
	f.emit("session_compact");
	assert.deepEqual(await f.ack("1"), { status: "delivered", delivery: "prompt" });
	assert.deepEqual(f.state.lost, []);
});

test("a stale compaction flag heals once Pi reports idle", async (t) => {
	const f = fixture(t);
	f.emit("session_before_compact"); // the compaction was cancelled and no completion event followed
	f.drop("1", { text: "still delivered" });
	assert.equal((await f.ack("1")).status, "delivered");
});

test("a prompt Pi never starts is reported as rejected, not delivered", async (t) => {
	const f = fixture(t, "cc-test-3", { admissionMs: 100 });
	f.state.suppressStart = true;
	f.drop("1", { text: "doomed" });
	const ack = await f.ack("1");
	assert.equal(ack.status, "rejected");
	assert.match(ack.reason, /did not start a run/);
	f.state.suppressStart = false;
	f.drop("2", { text: "recovers" });
	assert.equal((await f.ack("2")).status, "delivered");
});

test("invalid, null, empty, and expired messages are rejected, never delivered", async (t) => {
	const f = fixture(t);
	f.drop("bad", "not json");
	f.drop("null", "null");
	f.drop("num", "42");
	f.drop("empty", { text: "  " });
	f.drop("old", { text: "late", sentAt: Date.now() - STEER_TTL_MS - 1000 });
	for (const id of ["bad", "null", "num", "empty"]) assert.equal((await f.ack(id)).status, "rejected", id);
	assert.match((await f.ack("old")).reason, /expired/);
	assert.deepEqual(f.state.delivered, []);
	assert.equal(existsSync(join(f.dir, "null.taken")), false);
});

test("only the session's own inbox is read, and unsafe session ids are ignored", async (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, "other"), { recursive: true });
	writeFileSync(join(f.root, "other", "x.json"), JSON.stringify({ text: "not yours" }));
	f.drop("mine", { text: "yours" });
	await f.ack("mine");
	assert.deepEqual(f.state.delivered.map((m) => m.split("\n")[1]), ["yours"]);
	const unsafe = fixture(t, "../escape");
	assert.equal(existsSync(join(unsafe.root, "..", "escape")), false);
});

test("a second live process for the same session id fails closed; a dead owner is replaced", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const first = fakePi();
	installSteeringInbox(first.pi, { root, pollMs: 10 });
	first.emit("session_start");
	t.after(() => first.emit("session_shutdown"));
	const dir = join(root, "cc-test-3");
	// Pretend the first watcher belongs to another live process.
	writeFileSync(join(dir, ".owner"), JSON.stringify({ pid: 4242 }));
	const second = fakePi();
	installSteeringInbox(second.pi, { root, pollMs: 10, isAlive: (pid) => pid === 4242 });
	second.emit("session_start");
	t.after(() => second.emit("session_shutdown"));
	assert.match(second.state.notices[0]!, /belongs to process 4242/);
	writeFileSync(join(dir, "m.json"), JSON.stringify({ text: "who gets it" }));
	await sleep(200);
	// Neither a failed-closed watcher nor the first one (whose ownership file was overwritten, not removed) is asked to race.
	assert.deepEqual(second.state.delivered, []);
	// The owner dies: a new watcher takes over and the first still-running pi's inbox is served by exactly one process.
	const third = fakePi();
	installSteeringInbox(third.pi, { root, pollMs: 10, isAlive: () => false });
	third.emit("session_start");
	t.after(() => third.emit("session_shutdown"));
	assert.equal(third.state.notices.length, 0);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, ".owner"), "utf8")), { pid: process.pid });
});

test("shutdown releases ownership so a reload can claim it again", (t) => {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fake = fakePi();
	installSteeringInbox(fake.pi, { root, pollMs: 1e6 });
	fake.emit("session_start");
	assert.equal(existsSync(join(root, "cc-test-3", ".owner")), true);
	fake.emit("session_shutdown");
	assert.equal(existsSync(join(root, "cc-test-3", ".owner")), false);
});

test("stale acknowledgements are removed when a session starts", (t) => {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "cc-test-3");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "old.ack"), "{}");
	utimesSync(join(dir, "old.ack"), new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
	writeFileSync(join(dir, "new.ack"), "{}");
	const fake = fakePi();
	installSteeringInbox(fake.pi, { root, pollMs: 1e6 });
	fake.emit("session_start");
	t.after(() => fake.emit("session_shutdown"));
	assert.equal(existsSync(join(dir, "old.ack")), false);
	assert.equal(existsSync(join(dir, "new.ack")), true);
});

test("the inbox root honors GROK_STEER_DIR and XDG_STATE_HOME", () => {
	assert.equal(steerRoot({ GROK_STEER_DIR: "/x" }), "/x");
	assert.equal(steerRoot({ XDG_STATE_HOME: "/state" }), join("/state", "grok-style-pi", "steer"));
	assert.ok(ADMISSION_MS > 0);
});
