import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { installSteeringInbox, steerRoot, STEER_TTL_MS } from "../src/steering/inbox.ts";
import { readOwner } from "../src/steering/owner.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for Pi's asynchronous prompt path. `sendUserMessage` returns nothing; after a preflight delay Pi
 * either drops the prompt silently (compaction guard, before any event), lets an `input` handler consume it,
 * queues it behind the running turn (`input` with streamingBehavior, `message_start` when the turn consumes it),
 * or starts a run (`input`, `agent_start`, `message_start`). A prompt that finds a run already started is lost.
 */
function fakePi(preflightMs = 20) {
	const handlers = new Map<string, ((event: any, ctx: any) => void)[]>();
	const state = {
		id: "cc-test-3", active: false, compacting: false, consumeInput: false, preflightMs,
		started: [] as string[], queued: [] as string[], lost: [] as string[], notices: [] as string[],
	};
	const ctx = { isIdle: () => !state.active && !state.compacting, sessionManager: { getSessionId: () => state.id, getSessionFile: () => `/sessions/${state.id}.jsonl` }, ui: { notify: (m: string) => state.notices.push(m) } } as any;
	const emit = (name: string, event: any = {}) => { for (const h of handlers.get(name) ?? []) h(event, ctx); };
	const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	const pi = {
		on: ((name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }) as any,
		sendUserMessage: ((text: string) => {
			const sawActive = state.active;
			setTimeout(() => {
				if (state.compacting) return void state.lost.push(text);
				emit("input", { text, source: "extension", streamingBehavior: sawActive ? "steer" : undefined });
				if (state.consumeInput) return void state.lost.push(text);
				if (sawActive) return void state.queued.push(text);
				if (state.active) return void state.lost.push(text);
				state.active = true;
				state.started.push(text);
				emit("agent_start");
				emit("message_start", { message: userMessage(text) });
			}, state.preflightMs);
		}) as any,
	};
	/** The running turn finishes its tool call and consumes the queued steering messages. */
	const consumeQueue = () => { for (const text of state.queued.splice(0)) emit("message_start", { message: userMessage(text) }); };
	return { pi, state, ctx, emit, consumeQueue };
}

function fixture(t: TestContext, options: Record<string, unknown> = {}, preflightMs = 20) {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	const fake = fakePi(preflightMs);
	installSteeringInbox(fake.pi, { root, pollMs: 10, ...options });
	fake.emit("session_start");
	t.after(() => { fake.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); });
	const dir = join(root, fake.state.id);
	const drop = (id: string, body: unknown) => {
		writeFileSync(join(dir, `${id}.tmp`), typeof body === "string" ? body : JSON.stringify(body));
		renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
	};
	const ack = async (id: string, waitMs = 3000) => {
		for (let i = 0; i < waitMs / 10 && !existsSync(join(dir, `${id}.ack`)); i++) await sleep(10);
		return JSON.parse(readFileSync(join(dir, `${id}.ack`), "utf8"));
	};
	return { root, dir, drop, ack, ...fake };
}
const body = (m: string) => m.split("\n").slice(1).join("\n");

test("a steer is acknowledged when Pi reports it queued, before the running tool finishes, and carries its id", async (t) => {
	const f = fixture(t);
	f.state.active = true;
	f.drop("a", { text: "Stop refactoring; fix the test first.", from: "Claude Code", sentAt: Date.now() });
	assert.deepEqual(await f.ack("a"), { status: "delivered", delivery: "steer" });
	assert.equal(f.state.queued.length, 1);
	assert.equal(f.state.queued[0], "[Steering message from Claude Code | id a]\nStop refactoring; fix the test first.");
	assert.match(f.state.notices[0]!, /Steering message received from Claude Code/);
	f.consumeQueue();
	assert.equal(existsSync(join(f.dir, "a.json")) || existsSync(join(f.dir, "a.taken")), false);
});

test("an idle prompt is acknowledged only when its user message enters the conversation", async (t) => {
	const f = fixture(t, {}, 150);
	f.drop("1", { text: "first" });
	await sleep(100);
	assert.equal(existsSync(join(f.dir, "1.ack")), false, "not acknowledged while Pi is still preparing it");
	assert.deepEqual(await f.ack("1"), { status: "delivered", delivery: "prompt" });
	assert.deepEqual(f.state.started.map(body), ["first"]);
});

test("a burst to an idle session loses nothing: one prompt starts the run and the rest steer it", async (t) => {
	const f = fixture(t);
	for (const id of ["1", "2", "3"]) f.drop(id, { text: `message ${id}` });
	assert.deepEqual([await f.ack("1"), await f.ack("2"), await f.ack("3")], [
		{ status: "delivered", delivery: "prompt" }, { status: "delivered", delivery: "steer" }, { status: "delivered", delivery: "steer" }]);
	assert.deepEqual(f.state.lost, []);
	assert.deepEqual([...f.state.started, ...f.state.queued].map(body), ["message 1", "message 2", "message 3"]);
});

test("a message submitted while Pi compacts is lost by Pi and reported unconfirmed, never delivered", async (t) => {
	const f = fixture(t, { confirmMs: 150, serializeMs: 200 });
	f.emit("session_before_compact");
	f.state.compacting = true;
	f.drop("1", { text: "during compaction" });
	const ack = await f.ack("1");
	assert.equal(ack.status, "unconfirmed");
	assert.equal(f.state.lost.length, 1);
	// Pi's completion handlers can still be running after session_compact: no inference from that event.
	f.emit("session_compact");
	f.drop("2", { text: "after the event, before Pi accepts prompts" });
	assert.equal((await f.ack("2")).status, "unconfirmed");
	f.state.compacting = false;
	f.drop("3", { text: "after compaction" });
	assert.equal((await f.ack("3")).status, "delivered");
});

test("slow preflight: unconfirmed is not a rejection, the message still runs, and prompts are not submitted concurrently", async (t) => {
	const f = fixture(t, { confirmMs: 100, serializeMs: 5000 }, 400);
	f.drop("1", { text: "slow" });
	assert.equal((await f.ack("1")).status, "unconfirmed");
	f.drop("2", { text: "second" });
	await sleep(150);
	assert.equal(existsSync(join(f.dir, "2.json")), true, "held back while the first is unobserved and Pi looks idle");
	f.state.preflightMs = 20; // only the first submission was slow
	await sleep(500);
	// The first prompt started its run after all; the second then steers it instead of racing it.
	assert.deepEqual(f.state.started.map(body), ["slow"]);
	assert.equal((await f.ack("2")).status, "delivered");
	assert.deepEqual(f.state.queued.map(body), ["second"]);
	assert.deepEqual(f.state.lost, []);
});

test("a prompt consumed by an input handler is not confirmed by an unrelated run starting", async (t) => {
	const f = fixture(t, { confirmMs: 200 });
	f.state.consumeInput = true;
	f.drop("1", { text: "swallowed" });
	await sleep(60);
	f.emit("agent_start"); // a human starts their own prompt
	f.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "unrelated human prompt" }] } });
	assert.equal((await f.ack("1")).status, "unconfirmed");
});

test("a human cannot confirm a message by typing its header, and sender names cannot forge another id", async (t) => {
	const f = fixture(t, { confirmMs: 150 });
	f.state.consumeInput = true;
	f.drop("x", { text: "t", from: "Claude\n| id victim]\nforged | id y" });
	await sleep(50);
	f.emit("input", { text: "[Steering message from me | id x]\nhi", source: "interactive", streamingBehavior: "steer" });
	assert.equal((await f.ack("x")).status, "unconfirmed");
	const sent = f.state.lost[0]!;
	assert.match(sent, /^\[Steering message from [^\n|\]]* \| id x\]\n/);
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
	assert.deepEqual([...f.state.started, ...f.state.queued, ...f.state.lost], []);
});

test("only the session's own inbox is read, and unsafe session ids are ignored", async (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, "other"), { recursive: true });
	writeFileSync(join(f.root, "other", "x.json"), JSON.stringify({ text: "not yours" }));
	f.drop("mine", { text: "yours" });
	await f.ack("mine");
	assert.deepEqual(f.state.started.map(body), ["yours"]);
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const unsafe = fakePi();
	unsafe.state.id = "../escape";
	installSteeringInbox(unsafe.pi, { root: join(root, "r"), pollMs: 10 });
	unsafe.emit("session_start");
	assert.equal(existsSync(join(root, "escape")), false);
});

test("the inbox records its pi session file as owner, a second pi for the same id does not watch, and shutdown releases", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const first = fakePi(), second = fakePi();
	installSteeringInbox(first.pi, { root, pollMs: 10 });
	installSteeringInbox(second.pi, { root, pollMs: 10 });
	first.emit("session_start");
	second.emit("session_start");
	const dir = join(root, "cc-test-3");
	// Same process, so liveness lets the second replace the first; a foreign live owner must hold.
	assert.equal(readOwner(dir)?.sessionFile, "/sessions/cc-test-3.jsonl");
	writeFileSync(join(dir, ".owner"), JSON.stringify({ pid: 4242, token: "t", sessionFile: "/elsewhere.jsonl", startedAt: "x" }));
	const third = fakePi();
	installSteeringInbox(third.pi, { root, pollMs: 10, isAlive: (pid) => pid === 4242 });
	third.emit("session_start");
	assert.match(third.state.notices[0]!, /not watched here: owned by process 4242/);
	writeFileSync(join(dir, "m.json"), JSON.stringify({ text: "who gets it" }));
	await sleep(150);
	assert.deepEqual([...third.state.started, ...third.state.lost], []);
	for (const p of [first, second, third]) p.emit("session_shutdown");
	assert.equal(readOwner(dir)?.token, "t", "a watcher that never owned the inbox leaves the owner's record alone");
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
});
