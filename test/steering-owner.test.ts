import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireOwner, acquireOwnerWithBackoff, LOCK_FILE, OWNER_FILE, readOwner, releaseOwner } from "../src/steering/owner.ts";

const CHILD = fileURLToPath(new URL("./fixtures/steer-owner.ts", import.meta.url));

type Child = { process: ChildProcessWithoutNullStreams; report: Promise<{ pid: number; owned: boolean; token?: string }> };
function child(dir: string, mode = "hold", stalePid = ""): Child {
	const p = spawn(process.execPath, [CHILD, dir, mode, stalePid], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
	const report = new Promise<any>((resolve) => p.stdout.once("data", (d) => resolve(JSON.parse(String(d).split("\n")[0]!))));
	return { process: p, report };
}
const stopAll = async (children: Child[]) => {
	await Promise.all(children.map((c) => new Promise((r) => { c.process.once("exit", r); c.process.stdin.end(); })));
};

test("racing processes: exactly one acquires a fresh inbox, every round", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "owner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (let round = 0; round < 4; round++) {
		const dir = join(root, `r${round}`);
		mkdirSync(dir);
		const children = Array.from({ length: 8 }, () => child(dir));
		const reports = await Promise.all(children.map((c) => c.report));
		assert.equal(reports.filter((r) => r.owned).length, 1, JSON.stringify(reports));
		const winner = reports.find((r) => r.owned)!;
		assert.equal(readOwner(dir)?.token, winner.token);
		assert.equal(readOwner(dir)?.pid, winner.pid);
		await stopAll(children);
		assert.equal(existsSync(join(dir, OWNER_FILE)), false, "the owner releases its own record on exit");
		assert.deepEqual(readdirSync(dir), []);
	}
});

test("racing replacers of a dead owner: one wins, and a loser's release never removes the winner's record", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "owner-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// A record left by a process that no longer exists (any pid the children treat as dead).
	writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: 999999, token: "old", sessionFile: null, startedAt: "x" }));
	const children = Array.from({ length: 6 }, () => child(dir, "hold", "999999"));
	const reports = await Promise.all(children.map((c) => c.report));
	assert.equal(reports.filter((r) => r.owned).length, 1, JSON.stringify(reports));
	const winner = reports.find((r) => r.owned)!;
	// Stopping every loser must leave the winner's record in place.
	await stopAll(children.filter((c, i) => !reports[i]!.owned));
	assert.equal(readOwner(dir)?.token, winner.token);
	await stopAll(children.filter((c, i) => reports[i]!.owned));
	assert.equal(readOwner(dir), undefined);
});

test("an owner record is never visible half-written", () => {
	const dir = mkdtempSync(join(tmpdir(), "owner-"));
	try {
		for (let i = 0; i < 200; i++) {
			const claim = acquireOwner(dir, "/s.jsonl", () => false);
			assert.ok(claim.owned);
			const record = readOwner(dir);
			assert.equal(record?.token, claim.token);
			releaseOwner(dir, claim.token);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release only removes the instance's own record, and a live owner keeps the inbox", () => {
	const dir = mkdtempSync(join(tmpdir(), "owner-"));
	try {
		const first = acquireOwner(dir, "/a.jsonl", () => false);
		assert.ok(first.owned);
		// Another process takes over after the first's liveness lapsed.
		writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: 4242, token: "other", sessionFile: "/b.jsonl", startedAt: "x" }));
		releaseOwner(dir, first.token);
		assert.equal(readOwner(dir)?.token, "other");
		const blocked = acquireOwner(dir, "/c.jsonl", (pid) => pid === 4242);
		assert.equal(blocked.owned, false);
		assert.equal(readOwner(dir)?.token, "other");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the owner record names the pi session file senders verify", () => {
	const dir = mkdtempSync(join(tmpdir(), "owner-"));
	try {
		const claim = acquireOwner(dir, "/home/u/.pi/agent/sessions/x_cc-1-3.jsonl");
		assert.ok(claim.owned);
		assert.deepEqual(Object.keys(readOwner(dir)!).sort(), ["pid", "sessionFile", "startedAt", "token"]);
		assert.equal(readOwner(dir)!.sessionFile, "/home/u/.pi/agent/sessions/x_cc-1-3.jsonl");
		releaseOwner(dir, claim.token);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A live process that stands in for a paused or stalled lock holder. */
function liveProcess() {
	const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	return { pid: p.pid!, stop: () => p.kill("SIGKILL") };
}
async function deadPid() {
	const p = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
	await new Promise((r) => p.once("exit", r));
	return p.pid!;
}

test("a paused live mutex holder keeps the mutex however old it is; acquisition reports busy", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "owner-"));
	const holder = liveProcess();
	t.after(() => { holder.stop(); rmSync(dir, { recursive: true, force: true }); });
	writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: holder.pid, token: "paused" }));
	const longAgo = new Date(Date.now() - 3600_000);
	utimesSync(join(dir, LOCK_FILE), longAgo, longAgo);
	const claim = acquireOwner(dir, "/s.jsonl");
	assert.deepEqual([claim.owned, (claim as { busy?: boolean }).busy], [false, true]);
	assert.equal(readOwner(dir), undefined, "no owner was published behind the holder's back");
	// It resumes and finishes: the mutex is still its own.
	assert.equal(JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")).token, "paused");
	// Releasing as another instance neither removes the live holder's mutex nor an owner record that is not ours.
	releaseOwner(dir, "not-held");
	assert.equal(existsSync(join(dir, LOCK_FILE)), true);
});

test("a crashed mutex holder is recovered at once, even if its mutex is brand new", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "owner-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: await deadPid(), token: "crashed" }));
	const claim = acquireOwner(dir, "/s.jsonl");
	assert.equal(claim.owned, true);
	assert.equal(existsSync(join(dir, LOCK_FILE)), false, "own mutex released after acquiring");
});

test("startup retries a busy mutex with backoff and acquires as soon as it frees, without blocking", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "owner-"));
	const holder = liveProcess();
	t.after(() => { holder.stop(); rmSync(dir, { recursive: true, force: true }); });
	writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: holder.pid, token: "busy" }));
	let ticks = 0;
	const interval = setInterval(() => ticks++, 10);
	setTimeout(() => rmSync(join(dir, LOCK_FILE)), 250);
	const claim = await acquireOwnerWithBackoff(dir, "/s.jsonl", { withinMs: 5000 });
	clearInterval(interval);
	assert.equal(claim.owned, true);
	assert.ok(ticks > 10, "the event loop kept running while waiting");
	writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: holder.pid, token: "busy-forever" }));
	const busy = await acquireOwnerWithBackoff(dir, "/s.jsonl", { withinMs: 300 });
	assert.deepEqual([busy.owned, (busy as { busy?: boolean }).busy], [false, true]);
});
