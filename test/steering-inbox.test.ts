import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { installSteeringInbox, steerRoot, STEER_TTL_MS } from "../src/steering/inbox.ts";

function fixture(t: TestContext, sessionId = "cc-test-3") {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const sent: { text: string; options: unknown }[] = [];
	const notices: string[] = [];
	let idle = false;
	installSteeringInbox({
		on: ((name: string, handler: any) => { handlers.set(name, handler); }) as any,
		sendUserMessage: ((text: string, options: unknown) => { sent.push({ text: text as string, options }); }) as any,
	}, { root, pollMs: 10 });
	const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => sessionId }, ui: { notify: (m: string) => notices.push(m) } };
	handlers.get("session_start")!({}, ctx);
	t.after(() => { handlers.get("session_shutdown")!({}, ctx); rmSync(root, { recursive: true, force: true }); });
	const dir = join(root, sessionId);
	const drop = (id: string, body: unknown) => {
		writeFileSync(join(dir, `${id}.tmp`), typeof body === "string" ? body : JSON.stringify(body));
		renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
	};
	const ack = async (id: string) => {
		for (let i = 0; i < 200 && !existsSync(join(dir, `${id}.ack`)); i++) await new Promise((r) => setTimeout(r, 10));
		return JSON.parse(readFileSync(join(dir, `${id}.ack`), "utf8"));
	};
	return { root, dir, sent, notices, drop, ack, setIdle: (v: boolean) => { idle = v; } };
}

test("a message dropped in the session inbox steers a working agent and is acknowledged", async (t) => {
	const f = fixture(t);
	f.drop("a", { text: "Stop refactoring; fix the test first.", from: "Claude Code", sentAt: Date.now() });
	assert.deepEqual(await f.ack("a"), { status: "delivered", delivery: "steer" });
	assert.deepEqual(f.sent, [{ text: "[Steering message from Claude Code]\nStop refactoring; fix the test first.", options: { deliverAs: "steer" } }]);
	assert.match(f.notices[0]!, /Steering message received from Claude Code/);
	assert.equal(existsSync(join(f.dir, "a.json")), false);
	assert.equal(existsSync(join(f.dir, "a.taken")), false);
});

test("an idle agent receives it as a normal prompt, in submission order, exactly once", async (t) => {
	const f = fixture(t);
	f.setIdle(true);
	f.drop("1", { text: "first" });
	f.drop("2", { text: "second" });
	assert.deepEqual(await f.ack("1"), { status: "delivered", delivery: "prompt" });
	await f.ack("2");
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(f.sent.map((m) => m.text), ["[Steering message from external sender]\nfirst", "[Steering message from external sender]\nsecond"]);
});

test("invalid, empty, and expired messages are rejected, never delivered", async (t) => {
	const f = fixture(t);
	f.drop("bad", "not json");
	f.drop("empty", { text: "  " });
	f.drop("old", { text: "late", sentAt: Date.now() - STEER_TTL_MS - 1000 });
	assert.equal((await f.ack("bad")).status, "rejected");
	assert.equal((await f.ack("empty")).status, "rejected");
	assert.match((await f.ack("old")).reason, /expired/);
	assert.deepEqual(f.sent, []);
});

test("only the session's own inbox is read, and unsafe session ids are ignored", async (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, "other"), { recursive: true });
	writeFileSync(join(f.root, "other", "x.json"), JSON.stringify({ text: "not yours" }));
	f.drop("mine", { text: "yours" });
	await f.ack("mine");
	assert.deepEqual(f.sent.map((m) => m.text.split("\n")[1]), ["yours"]);
	const unsafe = fixture(t, "../escape");
	assert.equal(existsSync(join(unsafe.root, "..", "escape")), false);
});

test("stale acknowledgements are removed when a session starts", (t) => {
	const root = mkdtempSync(join(tmpdir(), "steer-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "s1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "old.ack"), "{}");
	utimesSync(join(dir, "old.ack"), new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
	writeFileSync(join(dir, "new.ack"), "{}");
	let start: any;
	installSteeringInbox({ on: ((n: string, h: any) => { if (n === "session_start") start = h; }) as any, sendUserMessage: (() => {}) as any }, { root, pollMs: 1e6 });
	start({}, { isIdle: () => true, sessionManager: { getSessionId: () => "s1" }, ui: {} });
	assert.equal(existsSync(join(dir, "old.ack")), false);
	assert.equal(existsSync(join(dir, "new.ack")), true);
});

test("the inbox root honors GROK_STEER_DIR and XDG_STATE_HOME", () => {
	assert.equal(steerRoot({ GROK_STEER_DIR: "/x" }), "/x");
	assert.equal(steerRoot({ XDG_STATE_HOME: "/state" }), join("/state", "grok-style-pi", "steer"));
});
