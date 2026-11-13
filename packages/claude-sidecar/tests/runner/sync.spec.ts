import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapPath, remoteNodeCommand, syncOptions } from "../../src/sync.ts";

const PROGRAM = readFileSync(new URL("../../scripts/sync-machine.cjs", import.meta.url), "utf8");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

/** A machine home with a grok-style-pi clone of a local origin, and a seed that advances it. */
function machine(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "sidecar-sync-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const origin = join(root, "origin.git"), seed = join(root, "seed"), home = join(root, "home"), checkout = join(home, "git", "grok-style-pi");
	git(root, "init", "--bare", "--initial-branch=main", origin);
	mkdirSync(seed);
	git(seed, "init", "--initial-branch=main");
	writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "grok-style-pi" }));
	git(seed, "add", ".");
	git(seed, "commit", "-m", "initial");
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "-q", "-u", "origin", "main");
	mkdirSync(join(home, "git"), { recursive: true });
	git(root, "clone", "-q", origin, checkout);
	const advance = () => { writeFileSync(join(seed, "new.txt"), "new\n"); git(seed, "add", "."); git(seed, "commit", "-m", "advance"); git(seed, "push", "-q"); return git(seed, "rev-parse", "HEAD"); };
	// The command the launcher sends over SSH, run here by a POSIX shell as the remote would.
	const sync = (options: Record<string, unknown> = {}) => spawnSync("sh", ["-c", remoteNodeCommand('eval(fs.readFileSync(0,"utf8"));', [JSON.stringify({ tooling: {}, runtimeHome: null, workDir: null, timeoutMs: 30_000, ...options })])],
		{ input: PROGRAM, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "agent"), GIT_CONFIG_NOSYSTEM: "1" } });
	return { checkout, advance, sync };
}

test("sync-machine fast-forwards the machine's grok-style-pi checkout through the encoded remote command", (t) => {
	const m = machine(t);
	const target = m.advance();
	const result = m.sync();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^grok-style-pi: \w+ -> \w+/);
	assert.equal(git(m.checkout, "rev-parse", "HEAD"), target);
});

test("sync-machine refuses local changes and local commits without updating", (t) => {
	const m = machine(t);
	m.advance();
	writeFileSync(join(m.checkout, "dirty.txt"), "x");
	assert.match(m.sync().stderr, /has local changes .* nothing was updated/);
	rmSync(join(m.checkout, "dirty.txt"));
	writeFileSync(join(m.checkout, "mine.txt"), "x");
	git(m.checkout, "add", ".");
	git(m.checkout, "commit", "-m", "local");
	const before = git(m.checkout, "rev-parse", "HEAD");
	assert.match(m.sync().stderr, /has diverged from origin\/main/);
	assert.equal(git(m.checkout, "rev-parse", "HEAD"), before);
});

test("sync options map this checkout's path onto the machine and validate the timeout", () => {
	const options = syncOptions({ home: "C:/Users/me", paths: { "/home/me/git/": "C:/git", "/home/me": "C:/Users/me" } }, "/home/me/git/repo", {});
	assert.deepEqual(options, { tooling: {}, runtimeHome: "C:/Users/me", workDir: "C:/git/repo", timeoutMs: 60_000 });
	assert.throws(() => syncOptions({}, "/x", { SIDECAR_SYNC_TIMEOUT_S: "0" }), /positive integer/);
});

test("path mappings match native Windows directories", () => {
	assert.equal(mapPath({ paths: { "C:\\work\\": "D:/repos" } }, "C:\\work\\project"), "D:/repos/project");
	assert.equal(mapPath({ paths: { "/home/me/git": "C:/git" } }, "/home/me/gitx"), undefined);
	assert.equal(mapPath({ paths: { "/home/me/git": "/srv" } }, "/home/me/git/a\\b"), "/srv/a\\b");
});
