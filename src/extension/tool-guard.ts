import type { BashSpawnContext, ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Commands that may name /tmp: they read, print, measure or remove, never store. */
const TMP_READERS = new Set(["ls", "du", "df", "stat", "cat", "head", "tail", "file", "wc", "grep", "rg", "find", "rm", "rmdir", "test", "[", "echo", "printf", "realpath", "readlink", "diff", "cmp", "sha256sum", "md5sum", "tree"]);
const TMP_PATH = /(^|[\s'"=:(>])\/tmp(?=\/|$|[\s'";&|)<>])/;
const REDIRECT_TO_TMP = /\d*(?:>>?|&>)\s*['"]?\/tmp(?=\/|$|[\s'";&|)])/;
const FIND_WRITES = /\s-(?:fprint0?|fprintf|fls|exec|execdir|ok|okdir)(?=\s|$)/;
const TEST_RUNNER = /(^|[\s(])(ctest|pytest|(?:npm|pnpm|yarn)\s+(?:run\s+)?test\S*|cargo\s+test|go\s+test|node\s+--test|just\s+test\S*|\S*[_-]tests?)(?=$|[\s)])/;
const HAS_TIMEOUT = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*timeout\s|\s--(?:test-)?timeout(?:[=\s]|$)/;

export type ToolGuardOptions = { testTimeoutS?: number; platform?: NodeJS.Platform };

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

/** Drops heredoc bodies, then splits at unquoted `;`, `&&`, `||`, `|`, `&` and newlines. */
export function segments(command: string): string[] {
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		kept.push(lines[i]);
		for (const match of lines[i].matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
			while (i + 1 < lines.length && lines[i + 1].replace(/^\t+/, "") !== match[2]) i++;
			i++;
		}
	}
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;
	const text = kept.join("\n");
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\\" && quote === '"') { current += c + (text[++i] ?? ""); continue; }
			if (c === quote) quote = undefined;
			current += c;
		} else if (c === "\\") {
			current += c + (text[++i] ?? "");
		} else if (c === "'" || c === '"') {
			quote = c;
			current += c;
		} else if (c === ";" || c === "\n" || c === "|" || (c === "&" && text[i - 1] !== ">" && text[i + 1] !== ">")) {
			if (text[i + 1] === c) i++;
			parts.push(current);
			current = "";
		} else {
			current += c;
		}
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

function program(segment: string): string {
	const words = segment.split(/\s+/);
	let index = 0;
	while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || ["sudo", "env", "nice", "ionice", "command", "exec", "time", "("].includes(words[index]))) index++;
	return (words[index] ?? "").replace(/^\(/, "").replace(/^.*\//, "");
}

/** Why a shell command would store something under /tmp, or undefined when it does not. */
export function tmpWriteReason(command: string): string | undefined {
	for (const segment of segments(command)) {
		if (!TMP_PATH.test(segment)) continue;
		if (REDIRECT_TO_TMP.test(segment)) return "redirects output into /tmp";
		if (/(^|\s)(?:export\s+)?TMPDIR=['"]?\/tmp/.test(segment)) return "points TMPDIR at /tmp";
		const name = program(segment);
		if (name === "find" && FIND_WRITES.test(segment)) return "runs `find` with an action that writes or executes on a /tmp path";
		if (!TMP_READERS.has(name)) return `runs \`${name}\` on a /tmp path`;
	}
	return undefined;
}

/** True when some test-runner invocation in the command has no timeout of its own. */
export function needsTestTimeout(command: string): boolean {
	return segments(command).some((segment) => TEST_RUNNER.test(segment) && !HAS_TIMEOUT.test(segment));
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
