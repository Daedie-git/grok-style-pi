import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export type Exec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
export interface WorktreeHandle { path: string; branch: string; baseCommit: string; repoRoot: string }

const execute: Exec = (cmd, args, opts) => new Promise((resolveResult, reject) => {
	const child = spawn(cmd, args, { ...opts, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
	child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
	child.on("error", reject);
	child.on("close", (code) => resolveResult({ stdout, stderr, code: code ?? -1 }));
});

async function git(exec: Exec, cwd: string, args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd });
	if (result.code !== 0) throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function createWorktree(input: { cwd: string; stateRoot: string; agentId: string; exec?: Exec }): Promise<WorktreeHandle> {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.agentId)) throw new Error("Invalid worktree agent id");
	const exec = input.exec ?? execute;
	const repoRoot = await realpath((await git(exec, input.cwd, ["rev-parse", "--show-toplevel"])).trim());
	const baseCommit = (await git(exec, input.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
	const path = resolve(input.stateRoot, "worktrees", input.agentId);
	const branch = `agent-${input.agentId}`;
	await mkdir(resolve(input.stateRoot, "worktrees"), { recursive: true });
	// Pin the recorded base, even if another actor moves HEAD during creation.
	await git(exec, repoRoot, ["worktree", "add", "-b", branch, path, baseCommit]);
	return { path, branch, baseCommit, repoRoot };
}

async function verifyIdentity(handle: WorktreeHandle, exec: Exec): Promise<string> {
	const path = await realpath(handle.path);
	const top = await realpath((await git(exec, path, ["rev-parse", "--show-toplevel"])).trim());
	if (path !== top) throw new Error("Worktree path is not the repository root");
	const common = await realpath((await git(exec, path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
	const expected = await realpath((await git(exec, handle.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
	if (common !== expected) throw new Error("Worktree belongs to a different repository");
	const branch = (await git(exec, path, ["symbolic-ref", "--quiet", "HEAD"])).trim();
	if (branch !== `refs/heads/${handle.branch}`) throw new Error("Worktree branch no longer matches its recorded branch");
	return (await git(exec, path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
}

async function inspect(handle: WorktreeHandle, exec: Exec) {
	const head = await verifyIdentity(handle, exec);
	// Include ignored files as well: cleanup must not silently discard local files.
	const dirty = (await git(exec, handle.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"])).length > 0;
	const commits = (await git(exec, handle.path, ["rev-list", `${handle.baseCommit}..HEAD`])).trim().split(/\r?\n/).filter(Boolean);
	return { changed: dirty || commits.length > 0 || head !== handle.baseCommit, dirty, commitsAhead: commits.length, commits };
}

export async function inspectWorktree(handle: WorktreeHandle, exec: Exec = execute): Promise<{ changed: boolean; dirty: boolean; commitsAhead: number; error?: string }> {
	try {
		const { changed, dirty, commitsAhead } = await inspect(handle, exec);
		return { changed, dirty, commitsAhead };
	} catch (error) {
		return { changed: true, dirty: false, commitsAhead: 0, error: message(error) };
	}
}

export async function cleanupWorktree(handle: WorktreeHandle, exec: Exec = execute): Promise<{ removed: boolean; kept: boolean; reason: string; commits: string[] }> {
	let commits: string[] = [];
	try {
		const state = await inspect(handle, exec);
		commits = state.commits;
		if (state.changed) return { removed: false, kept: true, reason: "Worktree has changes; files, index and branch were kept.", commits };
		// No --force: Git also rechecks dirty files, untracked files and worktree locks.
		await git(exec, handle.repoRoot, ["worktree", "remove", "--", handle.path]);
		try {
			// Compare-and-delete prevents deleting a branch advanced since inspection.
			await git(exec, handle.repoRoot, ["update-ref", "-d", `refs/heads/${handle.branch}`, handle.baseCommit]);
		} catch (error) {
			// Git has no transaction spanning worktree removal and ref deletion.
			// Restore the checkout if the second step failed, keeping the branch intact.
			try {
				await git(exec, handle.repoRoot, ["worktree", "add", handle.path, handle.branch]);
			} catch (restoreError) {
				throw new Error(`${message(error)}; worktree restoration also failed: ${message(restoreError)}. Branch retained; manual recovery required.`);
			}
			throw error;
		}
		return { removed: true, kept: false, reason: "Verified unchanged worktree and branch removed.", commits };
	} catch (error) {
		return { removed: false, kept: true, reason: `Cleanup stopped: ${message(error)}`, commits };
	}
}

export async function restoreWorktree(meta: { worktree?: WorktreeHandle; worktreeCleanlyRemoved?: boolean }, exec: Exec = execute): Promise<{ path: string } | { error: string }> {
	if (!meta.worktree) return { error: "No worktree metadata is available." };
	const handle = meta.worktree;
	try {
		let exists = true;
		try { await lstat(handle.path); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			exists = false;
		}
		if (!exists) {
			await git(exec, handle.repoRoot, ["show-ref", "--verify", `refs/heads/${handle.branch}`]);
			await mkdir(join(handle.path, ".."), { recursive: true });
			await git(exec, handle.repoRoot, ["worktree", "add", handle.path, handle.branch]);
		}
		await verifyIdentity(handle, exec);
		return { path: handle.path };
	} catch (error) {
		return { error: `Cannot restore worktree: ${message(error)}` };
	}
}

export function translationNote(inheritedRoot: string, childRoot: string): string | undefined {
	if (resolve(inheritedRoot) === resolve(childRoot)) return undefined;
	return `Inherited context refers to ${JSON.stringify(inheritedRoot)}. Your working root is ${JSON.stringify(childRoot)}; translate inherited repository paths to this root before using them. This worktree is not a sandbox.`;
}
