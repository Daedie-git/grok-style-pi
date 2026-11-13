// Git views the launcher records and compares: the change manifest and the untracked-file diff.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

const MAX_BUFFER = 1 << 30;

export interface GitResult { ok: boolean; stdout: Buffer; stderr: string }

export function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {}): GitResult {
	const result = spawnSync("git", args, { cwd, env: { ...process.env, ...options.env }, input: options.input, maxBuffer: MAX_BUFFER });
	return { ok: result.status === 0, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr?.toString() ?? String(result.error ?? "") };
}

/** Trimmed stdout of a git command that must succeed, else undefined. */
export function gitText(cwd: string, args: string[]): string | undefined {
	const result = git(cwd, args);
	return result.ok ? result.stdout.toString().trim() : undefined;
}

export const toplevel = (cwd: string) => gitText(cwd, ["rev-parse", "--show-toplevel"]);

/** A scratch copy of the repository's index, so staging never touches the real one. */
function scratchIndex(root: string, tmp: string): { index: string; dispose(): void } {
	mkdirSync(tmp, { recursive: true });
	const dir = mkdtempSync(join(tmp, "index-"));
	const index = join(dir, "index");
	const real = gitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
	try {
		if (real) {
			copyFileSync(real, index);
			// The index timestamp lets Git notice same-size edits made right after a commit.
			const stat = statSync(real);
			utimesSync(index, stat.atime, stat.mtime);
		}
	} catch {}
	return { index, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Bash's `printf %q` in the C locale, so manifests match the Bash launcher's. Takes a latin1 string of the path's bytes. */
export function bashQuote(bytes: string): string {
	if (!bytes) return "''";
	if (/[\x00-\x1f\x7f-\xff]/.test(bytes)) {
		const named: Record<string, string> = { "\x07": "\\a", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\v": "\\v", "\f": "\\f", "\r": "\\r", "\x1b": "\\E", "'": "\\'", "\\": "\\\\" };
		return `$'${[...bytes].map((c) => named[c] ?? (c < " " || c >= "\x7f" ? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}` : c)).join("")}'`;
	}
	return bytes.replace(/[ !"$&'()*,;<>?[\\\]^`{|}]/g, "\\$&").replace(/^[~#]/, "\\$&");
}

export interface Manifest {
	/** `<escaped name>\t<mode> <old id> <new id> <status>` per differing path, in Git's order. */
	lines: string[];
	/** Escaped name to the real path. */
	names: Map<string, string>;
}

/**
 * Every path that differs from BASE: its escaped name, mode, object ids and status. Everything is staged into a scratch
 * index first, so untracked files, deletions, symlinks (by link text), executable bits and submodule commits are
 * compared as Git sees them. Undefined when Git cannot fingerprint the tree.
 */
export function changeManifest(cwd: string, base: string, tmp: string): Manifest | undefined {
	const root = toplevel(cwd);
	if (!root) return undefined;
	const scratch = scratchIndex(root, tmp);
	try {
		const env = { GIT_INDEX_FILE: scratch.index };
		// --sparse: a tracked path outside the sparse cone can reappear and change.
		if (!git(root, ["add", "-A", "--sparse"], { env }).ok) return undefined;
		const raw = git(root, ["-c", "diff.relative=false", "diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-abbrev", base], { env });
		if (!raw.ok) return undefined;
		const fields = raw.stdout.toString("latin1").split("\0");
		const manifest: Manifest = { lines: [], names: new Map() };
		for (let i = 0; i + 1 < fields.length; i += 2) {
			const key = bashQuote(fields[i + 1]);
			manifest.lines.push(`${key}\t${fields[i].replace(/^:\S+ /, "")}`);
			manifest.names.set(key, Buffer.from(fields[i + 1], "latin1").toString("utf8"));
		}
		return manifest;
	} finally { scratch.dispose(); }
}

/** Untracked files as new-file diffs, from one git run: they are added intent-to-add to a scratch index. */
export function untrackedDiff(root: string, tmp: string): Buffer {
	const scratch = scratchIndex(root, tmp);
	try {
		const listed = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout;
		const env = { GIT_INDEX_FILE: scratch.index };
		// Literal pathspecs: an untracked name such as `:(exclude)x` is a file. No renames: a moved tracked file's new
		// name must still show as an addition.
		if (git(root, ["--literal-pathspecs", "add", "--intent-to-add", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: listed }).ok) {
			const diff = git(root, ["-c", "diff.relative=false", "diff", "--no-ext-diff", "--no-renames", "--diff-filter=A"], { env });
			if (diff.ok) return diff.stdout;
		}
		// One unindexable entry (a nested repository without commits) fails the batch; keep every other file.
		return Buffer.concat(listed.toString("latin1").split("\0").filter(Boolean)
			.map((file) => git(root, ["diff", "--no-index", "--", "/dev/null", Buffer.from(file, "latin1").toString("utf8")]).stdout));
	} finally { scratch.dispose(); }
}
