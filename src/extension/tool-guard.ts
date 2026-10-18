import type { BashSpawnContext, ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Commands that may name /tmp: they read, print, measure or remove, never store. */
const TMP_READERS = new Set(["ls", "du", "df", "stat", "cat", "head", "tail", "file", "wc", "grep", "rg", "find", "rm", "rmdir", "test", "[", "echo", "printf", "realpath", "readlink", "diff", "cmp", "sha256sum", "md5sum", "tree"]);
/** A word that names /tmp: the whole word, an option value, or a path quoted inside a script argument. */
const TMP_IN_WORD = /(^|["'=(,:])\/tmp(\/|$)/;
const FIND_WRITES = new Set(["-fprint", "-fprint0", "-fprintf", "-fls", "-exec", "-execdir", "-ok", "-okdir"]);
const PREFIXES = new Set(["sudo", "env", "nice", "ionice", "command", "exec", "time", "nohup"]);
const TEST_RUNNER = /^(ctest|pytest|(?:npm|pnpm|yarn) (?:run )?test\S*|cargo test|go test|node --test|just test\S*|\S*[_-]tests?)( |$)/;

export type ToolGuardOptions = { testTimeoutS?: number; platform?: NodeJS.Platform };

/** One simple command: its words without quotes, and the targets of its output redirections. */
export type Segment = { words: string[]; outputs: string[] };

/** Where scratch files go instead of /tmp. */
export function scratchDir(): string {
	return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-tmp");
}

/**
 * Bash spawn hook: commands get a TMPDIR on disk when theirs is unset or under /tmp. Pi's own process keeps its TMPDIR,
 * because desktop helpers that never see Pi's environment rendezvous with it there.
 */
export function scratchTmpdir(context: BashSpawnContext): BashSpawnContext {
	if (process.platform === "win32" || (context.env.TMPDIR && !/^\/tmp(\/|$)/.test(context.env.TMPDIR))) return context;
	const dir = scratchDir();
	mkdirSync(dir, { recursive: true });
	return { ...context, env: { ...context.env, TMPDIR: dir } };
}

/** Index just past the `)` closing a substitution whose body starts at `start`, honouring quotes and nesting. */
function closingParen(text: string, start: number): number {
	let depth = 1;
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = "";
		} else if (c === "\\") i++;
		else if (c === "'" || c === '"') quote = c;
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i + 1;
	}
	return text.length;
}

/**
 * Splits a Bash command line into simple commands. Quotes and escapes are honoured; command and process substitutions
 * (also inside double quotes and expanding heredocs) become commands of their own; heredoc bodies are data.
 */
export function parseShell(text: string): Segment[] {
	const out: Segment[] = [];
	let segment: Segment = { words: [], outputs: [] };
	let word = "";
	let has = false;
	let quotedWord = false;
	let pending: "output" | "input" | "heredoc" | undefined;
	const heredocs: { delimiter: string; expand: boolean }[] = [];
	const nested = (body: string) => out.push(...parseShell(body));
	const substitution = (i: number): number => {
		const end = closingParen(text, i);
		nested(text.slice(i, end - 1));
		return end;
	};
	const endWord = () => {
		if (has) {
			if (pending === "output") segment.outputs.push(word);
			else if (pending === "heredoc") heredocs.push({ delimiter: word, expand: !quotedWord });
			else if (pending !== "input") segment.words.push(word);
			pending = undefined;
		}
		word = "";
		has = false;
		quotedWord = false;
	};
	const endSegment = () => {
		endWord();
		if (segment.words.length || segment.outputs.length) out.push(segment);
		segment = { words: [], outputs: [] };
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			if (text[i + 1] !== "\n") { word += text[i + 1] ?? ""; has = true; }
			i++;
		} else if (c === "'" || (c === "$" && text[i + 1] === "'")) {
			const ansi = c === "$";
			let j = i + (ansi ? 2 : 1);
			while (j < text.length && text[j] !== "'") { if (ansi && text[j] === "\\") j++; j++; }
			word += text.slice(i + (ansi ? 2 : 1), j);
			has = quotedWord = true;
			i = j;
		} else if (c === '"') {
			let j = i + 1;
			for (; j < text.length && text[j] !== '"'; j++) {
				if (text[j] === "\\") { word += text[++j] ?? ""; continue; }
				if (text[j] === "$" && text[j + 1] === "(") { j = substitution(j + 2) - 1; continue; }
				if (text[j] === "`") { const end = text.indexOf("`", j + 1); nested(text.slice(j + 1, end < 0 ? text.length : end)); j = end < 0 ? text.length : end; continue; }
				word += text[j];
			}
			has = quotedWord = true;
			i = j;
		} else if ((c === "$" || c === "<" || c === ">") && text[i + 1] === "(" && (c === "$" || !has)) {
			i = substitution(i + 2) - 1;
			has = true;
		} else if (c === "`") {
			const end = text.indexOf("`", i + 1);
			nested(text.slice(i + 1, end < 0 ? text.length : end));
			i = end < 0 ? text.length : end;
			has = true;
		} else if (c === "#" && !has) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
		} else if (c === "\n") {
			endSegment();
			// Heredoc bodies start on the next line. Expanding ones still run their substitutions.
			for (const { delimiter, expand } of heredocs.splice(0)) {
				const start = i + 1;
				let end = start;
				while (end < text.length) {
					const next = text.indexOf("\n", end);
					const line = text.slice(end, next < 0 ? text.length : next);
					if (line.replace(/^\t+/, "") === delimiter) { i = next < 0 ? text.length : next; break; }
					end = next < 0 ? text.length : next + 1;
					i = end - 1;
				}
				if (expand) for (const match of text.slice(start, end).matchAll(/\$\(|`/g)) {
					const at = start + match.index!;
					if (match[0] === "`") { const close = text.indexOf("`", at + 1); nested(text.slice(at + 1, close < 0 ? end : close)); }
					else nested(text.slice(at + 2, closingParen(text, at + 2) - 1));
				}
			}
		} else if (c === ">" || c === "<" || (c === "&" && text[i + 1] === ">")) {
			if (/^\d+$/.test(word) && !quotedWord) { word = ""; has = false; }
			endWord();
			let op = c;
			while (i + 1 < text.length && "<>&|-".includes(text[i + 1]) && op.length < 3) op += text[++i];
			if (op.startsWith("<<<")) pending = "input";
			else if (op.startsWith("<<")) pending = "heredoc";
			else if (op === "<" || op === "<&" || op === "<>") pending = "input";
			else if (/^(>&|<&)$/.test(op) && /\d/.test(text[i + 1] ?? "")) pending = "input";
			else pending = "output";
		} else if (";&|()".includes(c)) {
			endSegment();
		} else if (/\s/.test(c)) {
			endWord();
		} else {
			word += c;
			has = true;
		}
	}
	endSegment();
	return out;
}

/** The command a segment runs, after environment assignments and wrappers such as `sudo` or `nice`. */
function command(words: string[]): { name: string; args: string[]; assignments: string[] } {
	let i = 0;
	const assignments: string[] = [];
	while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || PREFIXES.has(words[i]))) {
		if (words[i].includes("=")) assignments.push(words[i]);
		i++;
	}
	if (words[i] === "export") { assignments.push(...words.slice(i + 1)); i = words.length; }
	return { name: (words[i] ?? "").replace(/^.*\//, ""), args: words.slice(i + 1), assignments };
}

/** Why a shell command would store something under /tmp, or undefined when it does not. */
export function tmpWriteReason(text: string): string | undefined {
	for (const segment of parseShell(text)) {
		if (segment.outputs.some((target) => /^\/tmp(\/|$)/.test(target))) return "redirects output into /tmp";
		const { name, args, assignments } = command(segment.words);
		if (assignments.some((word) => /^TMPDIR=\/tmp(\/|$)/.test(word))) return "points TMPDIR at /tmp";
		if (!name || !args.some((word) => TMP_IN_WORD.test(word))) continue;
		if (name === "find" && args.some((word) => FIND_WRITES.has(word))) return "runs `find` with an action that writes or executes on a /tmp path";
		if (!TMP_READERS.has(name)) return `runs \`${name}\` on a /tmp path`;
	}
	return undefined;
}

/** True when some test-runner invocation in the command has no timeout of its own. */
export function needsTestTimeout(text: string): boolean {
	return parseShell(text).some((segment) => {
		const { name, args } = command(segment.words);
		if (name === "timeout") return false;
		return TEST_RUNNER.test([name, ...args].join(" ")) && !args.some((word) => /^--(?:test-)?timeout(=|$)/.test(word));
	});
}

/**
 * Enforces two standing rules in the tools instead of the prompt: nothing is stored in /tmp (a small shared tmpfs), and
 * test runs cannot hang forever while they hold a build or GPU lock.
 */
export function installToolGuard(pi: ExtensionAPI, options: ToolGuardOptions = {}) {
	if ((options.platform ?? process.platform) === "win32") return;
	const testTimeoutS = options.testTimeoutS ?? (Number(process.env.PI_TEST_TIMEOUT_S) || 1800);
	const advice = `Store scratch files in the project's captures/ directory or in ${scratchDir()}, never in /tmp.`;
	pi.on("tool_call", (event: ToolCallEvent, ctx): ToolCallEventResult | undefined => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = resolve(ctx.cwd, (event.input as { path: string }).path.replace(/^~(?=\/)/, homedir()));
			if (/^\/tmp(\/|$)/.test(path)) return { block: true, reason: `Blocked: ${event.toolName} into ${path}. ${advice}` };
			return undefined;
		}
		if (event.toolName !== "bash") return undefined;
		const input = event.input as { command: string; timeout?: number };
		const why = tmpWriteReason(input.command);
		if (why) return { block: true, reason: `Blocked: the command ${why}. ${advice}` };
		if (input.timeout === undefined && needsTestTimeout(input.command)) input.timeout = testTimeoutS;
		return undefined;
	});
}
