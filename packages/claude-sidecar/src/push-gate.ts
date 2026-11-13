// The PreToolUse hook: denies `git push` and PR/MR creation while files changed since this Claude pane's latest diff
// review of the repository the command publishes from. Repositories with no recorded review pass, as do commands
// that carry SIDECAR_REVIEW_SKIP=<why>.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { gitText } from "./git.ts";
import { latestReviewedFile, unreviewedSince } from "./review.ts";

interface Word { text: string; plain: boolean }

/**
 * The directory each publishing command in a shell command line runs in: `git [global options] push`, `gh pr create`,
 * `glab mr create`. Quotes, escapes, line continuations, `( ... )` subshell scope, `cd DIR` and `git -C DIR` are
 * followed. A directory it cannot resolve (an expansion, `cd -`, a missing path) leaves the previous one, so an
 * unknown `cd` never moves the check away from a repository. Heredocs are not followed.
 */
export function publishDirs(command: string, start: string, home: string): string[] {
	const items: Array<Word[] | "(" | ")"> = [];
	let words: Word[] = [];
	let word = "", has = false, raw = false, quote = "";
	const endWord = () => { if (has) words.push({ text: word, plain: !raw }); word = ""; has = false; raw = false; };
	const endSegment = () => { endWord(); if (words.length) items.push(words); words = []; };
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (c === "\\" && command[i + 1] === "\n" && quote !== "'") { i++; continue; }
		if (quote) {
			if (c === quote) quote = "";
			else if (c === "\\" && quote === "\"" && i + 1 < command.length) word += command[++i];
			else { if (c === "$" || c === "`") raw = true; word += c; }
		} else if (c === "'" || c === "\"") { quote = c; has = true; }
		else if (c === "\\" && i + 1 < command.length) { word += command[++i]; has = true; }
		else if (/\s/.test(c) && c !== "\n") endWord();
		else if (c === "(" || c === ")") { endSegment(); items.push(c); }
		else if (";&|\n".includes(c)) endSegment();
		else { if (c === "$" || c === "`" || (c === "~" && has)) raw = true; word += c; has = true; }
	}
	endSegment();
	const move = (dir: string, to: Word | undefined) => {
		if (to === undefined) return home;
		if (!to.plain || to.text === "-") return dir;
		const next = resolve(dir, to.text.replace(/^~(?=\/|$)/, home));
		return existsSync(next) ? next : dir;
	};
	const found: string[] = [];
	const stack: string[] = [];
	let dir = start;
	for (const item of items) {
		if (item === "(") { stack.push(dir); continue; }
		if (item === ")") { if (stack.length) dir = stack.pop()!; continue; }
		let words = item, skip = false;
		while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text) || ["env", "command", "builtin"].includes(words[0].text))) {
			if (words[0].text.startsWith("SIDECAR_REVIEW_SKIP=")) skip = true;
			words = words.slice(1);
		}
		const name = words[0]?.text, rest = words.slice(1);
		if (name === "cd" || name === "pushd") {
			let i = 0;
			while (i < rest.length && /^-[LPe@]*$/.test(rest[i].text) && rest[i].text !== "-") { const end = rest[i].text === "--"; i++; if (end) break; }
			dir = move(dir, rest[i]);
			continue;
		}
		if (skip) continue;
		if (name === "git") {
			let target = dir, i = 0;
			while (i < rest.length && rest[i].text.startsWith("-")) {
				if (rest[i].text === "-C") { target = move(target, rest[i + 1]); i += 2; }
				else if (["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(rest[i].text)) i += 2;
				else i++;
			}
			if (rest[i]?.text === "push") found.push(target);
		} else if ((name === "gh" && rest[0]?.text === "pr" && rest[1]?.text === "create") || (/^glab(-bot)?$/.test(name ?? "") && rest[0]?.text === "mr" && rest[1]?.text === "create")) {
			found.push(dir);
		}
	}
	return found;
}

/** The hook's JSON answer for hook INPUT, or undefined to let the command run. */
export function pushGate(input: string, env: { dir: string; owner: string; home: string; cwd: string }): string | undefined {
	let parsed: { tool_input?: { command?: unknown }; cwd?: unknown };
	try { parsed = JSON.parse(input); } catch { return undefined; }
	const command = typeof parsed.tool_input?.command === "string" ? parsed.tool_input.command : "";
	// A cheap filter first: this hook runs for every Bash call.
	if (!command.includes("push") && !command.includes("create")) return undefined;
	const start = typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : env.cwd;
	const reasons: string[] = [];
	for (const dir of publishDirs(command, start, env.home)) {
		if (!existsSync(dir)) continue;
		const repo = gitText(dir, ["rev-parse", "--show-toplevel"]);
		if (!repo) continue;
		const latest = latestReviewedFile(env.dir, env.owner, repo);
		if (!latest) continue;
		try {
			const result = unreviewedSince(repo, latest, env.dir);
			if (result.code) reasons.push(`${repo}: ${result.text}`);
		} catch (error) { reasons.push(`${repo}: sidecar: ${error instanceof Error ? error.message : String(error)}`); }
	}
	if (!reasons.length) return undefined;
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Sidecar review gate: ${reasons.join(" ")}. Run \`sidecar diff <base>\` over them first. Only if this push needs no review (tickets, docs), run it with SIDECAR_REVIEW_SKIP=<why> and tell the user.` } });
}
