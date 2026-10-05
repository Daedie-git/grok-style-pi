import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireOwner, OWNER_FILE, readOwner, releaseOwner } from "../src/steering/owner.ts";

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
