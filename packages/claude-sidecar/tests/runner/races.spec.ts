import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { HerdrClient } from "../../herdr-runner/src/client.ts";
import { EXIT, SidecarCli } from "../../src/cli.ts";
import { recordTranscript } from "../../src/session.ts";
import { acquireLock, SlotState } from "../../src/state.ts";
import { fixture } from "./fixture.ts";

// Child mode: hammer the lock and report any overlap through the exit code.
if (process.argv[2] === "lock-child") {
	const dir = process.argv[3];
	for (let i = 0; i < 40; i++) {
		const release = await acquireLock(join(dir, "slot.lock"), undefined, 1);
		try {
			try { mkdirSync(join(dir, "inside")); } catch { process.exit(7); }
			await new Promise((resolve) => setTimeout(resolve, 1));
			rmSync(join(dir, "inside"), { recursive: true });
		} finally { release(); }
	}
	process.exit(0);
}

test("the slot lock admits one holder across processes", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "sidecar-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const children = Array.from({ length: 8 }, () => fork(fileURLToPath(import.meta.url), ["lock-child", dir], {
		execArgv: ["--disable-warning=ExperimentalWarning"], stdio: "ignore",
	}));
	const codes = await Promise.all(children.map((child) => new Promise<number | null>((resolve) => child.on("exit", resolve))));
	assert.deepEqual(codes, Array(8).fill(0));
});

test("a live earlier launcher's lock, PID file or SQLite, still holds its slot", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "sidecar-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const now = new AbortController();
	now.abort();
	writeFileSync(join(dir, "slot.lock"), `${process.pid}\n`);
	await assert.rejects(acquireLock(join(dir, "slot.lock"), now.signal), /aborted/);
	writeFileSync(join(dir, "slot.lock"), "2147483646\n");
	(await acquireLock(join(dir, "slot.lock"), now.signal))();
	// A SQLite lock on the path itself.
	rmSync(join(dir, "slot.lock"));
	const { DatabaseSync } = await import("node:sqlite");
	const held = new DatabaseSync(join(dir, "slot.lock"));
	held.exec("BEGIN EXCLUSIVE");
	await assert.rejects(acquireLock(join(dir, "slot.lock"), now.signal), /aborted/);
	held.close();
	(await acquireLock(join(dir, "slot.lock"), now.signal))();
});

test("a request takes its owner from the transcript SessionStart recorded", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const transcript = join(f.root, "claude", "projects", "p", `${"0b0c0d0e-0000-4000-8000-00000000000a"}.jsonl`);
	recordTranscript(join(f.root, "state"), "sc-w1-p1", transcript);
	const result = await f.runWith({ env: { CLAUDE_CODE_SESSION_ID: undefined } }, "ask", "task");
	assert.equal(result.code, EXIT.report, result.stderr);
	assert.equal((await f.store()!.listAgents())[0].parentSessionFile, transcript);
});

test("two answers to one question deliver only the first", async (t) => {
	const f = fixture(t, (_prompt, n) => n === 1 ? { type: "needs-answer", result: "Apply the migration?" } : { type: "completed", result: "done" });
	assert.equal((await f.run("ask", "task")).code, EXIT.question);
	const codes = (await Promise.all([f.run("answer", "yes"), f.run("answer", "no")])).map((result) => result.code).sort();
	assert.deepEqual(codes, [EXIT.report, EXIT.failed]);
	assert.equal(f.prompts.length, 2);
});

test("stop --fresh waits for a finishing request, and a forced one stays forgotten", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "Status: done" }));
	spawnSync("git", ["init", "-q", f.root]);
	spawnSync("git", ["-C", f.root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-qm", "base"]);
	const marker = join(f.root, "checking");
	const asked = f.run("--role", "implementer", "ask", "--accept", `touch '${marker}'; while [ ! -e '${marker}.go' ]; do sleep 0.02; done`, "task");
	while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal((await f.run("stop", "--fresh")).code, EXIT.busy);
	assert.equal((await f.run("stop", "--fresh", "--force")).code, EXIT.report);
	writeFileSync(`${marker}.go`, "");
	assert.equal((await asked).code, EXIT.report);
	assert.equal((await f.run("status")).stdout, "no runner sidecars for this pane\n");
});

test("maintenance reopens the machines of the owner's remote slots", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "sidecar-maintain-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	new SlotState(join(root, "state"), "sc-w1-p1-2").write({ agentId: "a1@lappy", role: "reviewer", agent: "claude", machine: "lappy" });
	let opened = 0;
	const client = { listAgents: async () => [], listPanes: async () => [] } as unknown as HerdrClient;
	const cli = new SidecarCli({ stdout: () => {}, stderr: () => {}, stdin: async () => "" }, {
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", SIDECAR_STATE_DIR: join(root, "state") }, maintainMs: 200, pollMs: 20,
		parent: {
			client, root: join(root, "store"), agentDir: join(root, "agent"),
			listMachines: async () => [{ id: "m1", label: "lappy", target: "lappy", enabled: true }],
			machineChannel: async () => { opened++; throw new Error("offline"); },
		},
	});
	assert.equal(await cli.run(["maintain"]), EXIT.report);
	assert.ok(opened > 0);
});
