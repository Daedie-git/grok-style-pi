import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { cleanupWorktree, createWorktree, inspectWorktree, restoreWorktree, translationNote } from "../src/worktree.ts";
import type { Exec } from "../src/worktree.ts";

const exec: Exec = (cmd, args, opts) => new Promise((done, reject) => {
	const child = spawn(cmd, args, { ...opts, shell: false, windowsHide: true });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
	child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
	child.on("error", reject);
	child.on("close", code => done({ stdout, stderr, code: code ?? -1 }));
});
async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd });
	assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}
async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}
async function fixture(t: TestContext) {
	const captures = resolve(import.meta.dirname, "../../../captures");
	await mkdir(captures, { recursive: true });
	const root = await mkdtemp(join(captures, "worktree-test-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	const repo = join(root, "repo with spaces");
	await mkdir(repo);
	await git(repo, "init");
	await git(repo, "config", "user.name", "Engine Test");
	await git(repo, "config", "user.email", "engine-test@example.invalid");
	await git(repo, "config", "commit.gpgsign", "false");
	await writeFile(join(repo, "tracked.txt"), "base\n");
	await git(repo, "add", "tracked.txt");
	await git(repo, "commit", "-m", "base");
	const handle = await createWorktree({ cwd: repo, stateRoot: join(root, "state with spaces"), agentId: "a123" });
	return { root, repo, handle };
}

test("real Git: creates a branch at the recorded base and removes unchanged worktree", async t => {
	const { repo, handle } = await fixture(t);
	assert.equal(handle.branch, "agent-a123");
	assert.equal(await git(handle.path, "rev-parse", "HEAD"), handle.baseCommit);
	assert.equal(await git(handle.path, "branch", "--show-current"), handle.branch);
	assert.deepEqual(await inspectWorktree(handle), { changed: false, dirty: false, commitsAhead: 0 });
	const result = await cleanupWorktree(handle);
	assert.deepEqual({ removed: result.removed, kept: result.kept, commits: result.commits }, { removed: true, kept: false, commits: [] });
	assert.equal(await exists(handle.path), false);
	assert.equal((await exec("git", ["show-ref", "--verify", `refs/heads/${handle.branch}`], { cwd: repo })).code, 128);
});

for (const staged of [false, true]) {
	test(`real Git: ${staged ? "staged" : "unstaged"} changes are kept without a commit`, async t => {
		const { repo, handle } = await fixture(t);
		await writeFile(join(handle.path, "tracked.txt"), "child edit\n");
		if (staged) await git(handle.path, "add", "tracked.txt");
		const before = await git(handle.path, "status", "--porcelain=v1");
		assert.deepEqual(await inspectWorktree(handle), { changed: true, dirty: true, commitsAhead: 0 });
		const result = await cleanupWorktree(handle);
		assert.equal(result.kept, true);
		assert.equal(result.removed, false);
		assert.equal(await readFile(join(handle.path, "tracked.txt"), "utf8"), "child edit\n");
		assert.equal(await git(handle.path, "status", "--porcelain=v1"), before);
		assert.equal(await git(handle.path, "rev-parse", "HEAD"), handle.baseCommit);
		assert.equal(await git(repo, "rev-parse", handle.branch), handle.baseCommit);
	});
}

test("real Git: untracked files are kept, including under untracked directories", async t => {
	const { handle } = await fixture(t);
	await mkdir(join(handle.path, "new directory"));
	await writeFile(join(handle.path, "new directory", "new.txt"), "untracked");
	const result = await cleanupWorktree(handle);
	assert.equal(result.kept, true);
	assert.equal(await readFile(join(handle.path, "new directory", "new.txt"), "utf8"), "untracked");
	assert.equal(await git(handle.path, "rev-parse", "HEAD"), handle.baseCommit);
});

test("real Git: ignored local files are conservatively kept", async t => {
	const { repo, handle } = await fixture(t);
	await writeFile(join(repo, ".git", "info", "exclude"), "scratch.log\n");
	await writeFile(join(handle.path, "scratch.log"), "local output");
	assert.equal(await git(handle.path, "status", "--porcelain"), "");
	assert.equal((await cleanupWorktree(handle)).kept, true);
	assert.equal(await readFile(join(handle.path, "scratch.log"), "utf8"), "local output");
});

test("real Git: clean committed-only work and its branch are kept exactly", async t => {
	const { repo, handle } = await fixture(t);
	await writeFile(join(handle.path, "tracked.txt"), "committed edit\n");
	await git(handle.path, "add", "tracked.txt");
	await git(handle.path, "commit", "-m", "child change");
	const childCommit = await git(handle.path, "rev-parse", "HEAD");
	assert.deepEqual(await inspectWorktree(handle), { changed: true, dirty: false, commitsAhead: 1 });
	const result = await cleanupWorktree(handle);
	assert.equal(result.kept, true);
	assert.deepEqual(result.commits, [childCommit]);
	assert.equal(await git(repo, "rev-parse", handle.branch), childCommit);
	assert.equal(await git(handle.path, "rev-parse", "HEAD"), childCommit);
	assert.equal(await git(handle.path, "status", "--porcelain"), "");
});

test("real Git: an empty commit still counts as committed work", async t => {
	const { handle } = await fixture(t);
	await git(handle.path, "commit", "--allow-empty", "-m", "child empty commit");
	assert.equal((await cleanupWorktree(handle)).kept, true);
	assert.equal((await inspectWorktree(handle)).commitsAhead, 1);
});

test("inspection failures preserve worktree and branch and never run removal", async t => {
	const { repo, handle } = await fixture(t);
	const calls: string[][] = [];
	const failing: Exec = async (cmd, args, opts) => {
		calls.push(args);
		return args[0] === "status" ? { stdout: "", stderr: "inspection denied", code: 1 } : exec(cmd, args, opts);
	};
	assert.match((await inspectWorktree(handle, failing)).error!, /inspection denied/);
	const result = await cleanupWorktree(handle, failing);
	assert.equal(result.kept, true);
	assert.match(result.reason, /inspection denied/);
	assert.equal(calls.some(args => args[0] === "worktree" || args[0] === "update-ref"), false);
	assert.equal(await exists(handle.path), true);
	assert.equal(await git(repo, "rev-parse", handle.branch), handle.baseCommit);
});

test("thrown execution errors preserve worktrees", async t => {
	const { handle } = await fixture(t);
	const result = await cleanupWorktree(handle, async () => { throw new Error("spawn failed"); });
	assert.equal(result.kept, true);
	assert.match(result.reason, /spawn failed/);
	assert.equal(await exists(handle.path), true);
});

test("real Git: locked worktree removal fails without deleting its branch", async t => {
	const { repo, handle } = await fixture(t);
	await git(repo, "worktree", "lock", handle.path);
	const result = await cleanupWorktree(handle);
	assert.equal(result.kept, true);
	assert.equal(result.removed, false);
	assert.equal(await exists(handle.path), true);
	assert.equal(await git(repo, "rev-parse", handle.branch), handle.baseCommit);
});

test("branch deletion failure restores the unchanged worktree", async t => {
	const { repo, handle } = await fixture(t);
	const failing: Exec = (cmd, args, opts) => args[0] === "update-ref"
		? Promise.resolve({ stdout: "", stderr: "ref deletion denied", code: 1 }) : exec(cmd, args, opts);
	const result = await cleanupWorktree(handle, failing);
	assert.equal(result.kept, true);
	assert.equal(result.removed, false);
	assert.match(result.reason, /ref deletion denied/);
	assert.equal(await exists(handle.path), true);
	assert.equal(await git(repo, "rev-parse", handle.branch), handle.baseCommit);
	assert.equal(await git(handle.path, "branch", "--show-current"), handle.branch);
});

test("a commit made after inspection is retained when compare-and-delete fails", async t => {
	const { repo, handle } = await fixture(t);
	let childCommit = "";
	const racing: Exec = async (cmd, args, opts) => {
		if (args[0] === "worktree" && args[1] === "remove") {
			await git(handle.path, "commit", "--allow-empty", "-m", "late child commit");
			childCommit = await git(handle.path, "rev-parse", "HEAD");
		}
		return exec(cmd, args, opts);
	};
	const result = await cleanupWorktree(handle, racing);
	assert.equal(result.kept, true);
	assert.equal(result.removed, false);
	assert.equal(await git(repo, "rev-parse", handle.branch), childCommit);
	assert.equal(await git(handle.path, "rev-parse", "HEAD"), childCommit);
});

test("failed commit inspection is not mistaken for an unchanged worktree", async t => {
	const { handle } = await fixture(t);
	const failing: Exec = (cmd, args, opts) => args[0] === "rev-list"
		? Promise.resolve({ stdout: "", stderr: "history unavailable", code: 1 }) : exec(cmd, args, opts);
	const result = await cleanupWorktree(handle, failing);
	assert.equal(result.kept, true);
	assert.match(result.reason, /history unavailable/);
	assert.equal(await exists(handle.path), true);
});

test("missing paths and wrong branch identities are not treated as unchanged", async t => {
	const { handle } = await fixture(t);
	const missing = await cleanupWorktree({ ...handle, path: join(handle.path, "missing") });
	assert.equal(missing.kept, true);
	await git(handle.path, "checkout", "--detach");
	assert.equal((await cleanupWorktree(handle)).kept, true);
	assert.equal(await exists(handle.path), true);
});

test("real Git: restores an externally removed worktree from its surviving branch", async t => {
	const { repo, handle } = await fixture(t);
	await git(repo, "worktree", "remove", handle.path);
	assert.equal(await exists(handle.path), false);
	assert.deepEqual(await restoreWorktree({ worktree: handle }), { path: handle.path });
	assert.equal(await git(handle.path, "rev-parse", "HEAD"), handle.baseCommit);
	assert.deepEqual(await restoreWorktree({ worktree: handle }), { path: handle.path });
});

test("restoration refuses missing metadata, deleted branch and unrelated existing directory", async t => {
	const { handle } = await fixture(t);
	assert.ok("error" in await restoreWorktree({}));
	await cleanupWorktree(handle);
	assert.ok("error" in await restoreWorktree({ worktree: handle, worktreeCleanlyRemoved: true }));
	assert.equal(await exists(handle.path), false);
	await mkdir(handle.path);
	await writeFile(join(handle.path, "keep.txt"), "do not replace");
	assert.ok("error" in await restoreWorktree({ worktree: handle }));
	assert.equal(await readFile(join(handle.path, "keep.txt"), "utf8"), "do not replace");
});

test("creation rejects unsafe agent IDs without executing Git", async () => {
	for (const agentId of ["../escape", "a/b", "a\\b", "", "-option"]) {
		await assert.rejects(createWorktree({ cwd: ".", stateRoot: ".", agentId, exec: async () => { throw new Error("should not execute"); } }), /Invalid worktree agent id/);
	}
});

test("translation notes identify both roots only when paths differ", () => {
	assert.equal(translationNote(".", resolve(".")), undefined);
	const note = translationNote("parent root", "child root");
	assert.match(note!, /parent root/);
	assert.match(note!, /child root/);
	assert.match(note!, /not a sandbox/);
});
