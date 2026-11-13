// Plan and diff reviews, and the record of what a diff review covered (read by `unreviewed` and the push gate).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeManifest, git, gitText, toplevel, untrackedDiff, type Manifest } from "./git.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
// Bash hashed the path with its newline; the digest names the record, so it stays.
const repoKey = (root: string) => sha256(`${root}\n`).slice(0, 12);
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planPrompt(file: string, context: string | undefined): string {
	return `# Plan review

Review the plan in \`${file}\` before implementation starts.


Look for: wrong assumptions about the existing code, missing steps or cases, ownership/lifecycle/concurrency problems, conflicts with ADRs and documented contracts, ordering mistakes, and simpler alternatives that would clearly be better. Verify claims against the repository.

Flag every claim about performance, cost or frequency (a speedup, frame time, memory, "hot path", "rarely happens") that cites no measurement, profile or capture, and name the measurement that would settle it.

## Context from Claude
${context || "(none)"}`;
}

export interface PreparedDiff {
	prompt: string;
	/** Records what the review covered; call once its report was delivered. */
	record(): string | undefined;
}

export interface DiffOptions {
	cwd: string;
	base: string;
	context: string | undefined;
	/** The slot's name, which keys the review record. */
	slot: string;
	slotNumber: string;
	dir: string;
	/** Rejections the reviewer has not withdrawn, as list lines. */
	rejected: string;
	warn(text: string): void;
}

/** Writes the diff file and builds the request. Throws Error with the launcher's message when the base is unusable. */
export function prepareDiff(options: DiffOptions): PreparedDiff {
	const { cwd, slot, dir } = options;
	let base = options.base;
	if (base.includes("..")) throw new Error(`diff takes a single base ref, not a range (${base}). Use: sidecar --slot ${options.slotNumber} diff ${base.split("..")[0]} CONTEXT; it reviews that base through the working tree`);
	if (!git(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).ok) throw new Error(`unknown base: ${base}`);
	let label = base;
	// A base that moved past the work (origin/main after a fetch) would show its new commits as removals.
	if (!git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
		const fork = gitText(cwd, ["merge-base", base, "HEAD"]);
		if (!fork) throw new Error(`${base} and HEAD share no history`);
		options.warn(`sidecar: ${base} is not an ancestor of HEAD; reviewing changes since their merge-base ${fork.slice(0, 12)}\n`);
		label = `${base} (merge-base ${fork.slice(0, 12)})`;
		base = fork;
	}
	const root = toplevel(cwd);
	if (!root) throw new Error("not a git repository");
	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	mkdirSync(join(dir, "requests"), { recursive: true });
	const diffPath = join(dir, "requests", `${stamp.slice(0, 8)}-${stamp.slice(8)}-${slot}.${randomUUID().slice(0, 6)}.diff`);
	writeFileSync(diffPath, Buffer.concat([
		Buffer.from(`# Commits since ${base}\n`), git(cwd, ["log", "--oneline", `${base}..HEAD`]).stdout,
		Buffer.from(`\n# Diff: ${base}..working tree\n`), git(cwd, ["-c", "diff.relative=false", "diff", base]).stdout,
		Buffer.from("\n# Untracked files\n"), untrackedDiff(root, dir),
	]));
	// An unfingerprintable tree is still reviewed, but never recorded as covered.
	const manifest = changeManifest(cwd, base, dir);
	const sha = gitText(cwd, ["rev-parse", `${base}^{commit}`])!;
	const rejected = options.rejected
		? `\n## Findings Claude rejected earlier\nRe-check each against the current code. Report one that still holds as a finding again. Add a section \`## Rejected findings re-check\` with one line per entry: \`R<n>: withdrawn\` or \`R<n>: stands\`, and the reason.\n${options.rejected}\n`
		: "";
	const prompt = `# Adversarial implementation review

Find bugs in the change in \`${diffPath}\` (repository: \`${root}\`, base \`${label}\`, commit \`${sha}\`).

The change is exactly what the diff shows. Code that exists only on a newer upstream branch is not part of it, and the change does not remove it.

Read the diff, then read the surrounding code it touches and its callers. Hunt for real defects: logic errors, broken invariants, lifecycle and ownership mistakes, races, missed error paths, edge inputs, stale callers, and behaviour that contradicts the intent below or earlier agreed decisions. Give each finding a concrete failure scenario. Skip style.

Reproduce each finding before you report it: run the existing tests or a short script that triggers it, and quote the command and its output in the finding. Mark a finding you could not reproduce \`unverified\` and say why.

Give each finding an origin: \`introduced\` when the change adds or exposes it, \`pre-existing\` when the same defect exists at the base (check with \`git show ${sha}:<path>\`). Put pre-existing findings last, under \`## Pre-existing (not blocking)\`, and only when the change makes them more reachable or they defeat its intent.
${rejected}

## Intent and context from Claude
${options.context || "(none)"}`;
	return {
		prompt,
		record() {
			// An empty manifest is recorded as unfingerprintable, as the Bash launcher does.
			if (!manifest?.lines.length) {
				rmSync(reviewedFile(dir, slot, root), { force: true });
				options.warn("sidecar: could not fingerprint the working tree; this review is not recorded as covering it\n");
				return undefined;
			}
			const file = reviewedFile(dir, slot, root);
			writeFileSync(file, `base=${sha}\n${manifest.lines.join("\n")}\n`);
			return file;
		},
	};
}

/** What the last diff review of a repository covered, per slot. */
export function reviewedFile(dir: string, slot: string, root: string): string {
	return join(dir, `${slot}.reviewed.${repoKey(root)}`);
}

/** The newest diff review of a repository from any slot of this Claude pane. */
export function latestReviewedFile(dir: string, owner: string, root: string): string | undefined {
	const pattern = new RegExp(`^${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-.*)?\\.reviewed\\.${repoKey(root)}$`);
	let latest: { file: string; time: number } | undefined;
	let names: string[] = [];
	try { names = readdirSync(dir); } catch {}
	for (const name of names) {
		if (!pattern.test(name)) continue;
		const file = join(dir, name);
		const stat = statSync(file);
		if (stat.size > 0 && (!latest || stat.mtimeMs > latest.time)) latest = { file, time: stat.mtimeMs };
	}
	return latest?.file;
}

export interface Unreviewed { text: string; code: 0 | 1 }

/** Compares the working tree with a review record; throws Error with the launcher's message when it cannot. */
export function unreviewedSince(cwd: string, file: string | undefined, tmp: string): Unreviewed {
	const manifest = (base: string): Manifest => {
		const result = changeManifest(cwd, base, tmp);
		if (!result) throw new Error("could not fingerprint the working tree");
		return result;
	};
	const recorded = file && existsSync(file) ? readFileSync(file, "utf8") : "";
	if (!recorded) {
		const now = manifest("HEAD");
		if (!now.lines.length) return { text: "no changes, and no diff review recorded", code: 0 };
		return { text: `no diff review recorded for this repository; changed: ${now.lines.map((line) => line.split("\t")[0]).join(" ")}`, code: 1 };
	}
	const lines = recorded.split("\n");
	const base = lines[0].replace(/^base=/, "");
	if (!git(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).ok) throw new Error(`reviewed base ${base} no longer exists`);
	const before = new Set(lines.slice(1).filter(Boolean));
	const now = new Set(manifest(base).lines);
	const changed = new Set<string>();
	for (const line of before) if (!now.has(line)) changed.add(line.split("\t")[0]);
	for (const line of now) if (!before.has(line)) changed.add(line.split("\t")[0]);
	if (!changed.size) return { text: "nothing changed since the last diff review", code: 0 };
	return { text: `changed since the last diff review: ${[...changed].sort(byBytes).join(" ")}`, code: 1 };
}
