import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { HookCommand } from "../types.ts";

export interface HookRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	missingScript: boolean;
	json?: Record<string, unknown>;
	jsonError?: string;
}

const mapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_OUTPUT = 1_048_576;

function parseOutput(result: HookRunResult): HookRunResult {
	if (result.jsonError) return result;
	const text = result.stdout.replace(/^\uFEFF/, "").trim();
	// Ordinary stdout is successful output, not a request for a model turn.
	if (!text || !/^[{["\d-]|^(?:true|false|null)(?:\s|$)/.test(text)) return result;
	try {
		const value: unknown = JSON.parse(text);
		if (!mapping(value)) throw new Error("Hook JSON must be an object");
		if ((value.continue !== undefined && typeof value.continue !== "boolean")
			|| (value.decision !== undefined && value.decision !== "block" && value.decision !== "approve")
			|| (value.reason !== undefined && typeof value.reason !== "string")
			|| (value.stopReason !== undefined && typeof value.stopReason !== "string")
			|| (value.hookSpecificOutput !== undefined && (!mapping(value.hookSpecificOutput)
				|| (value.hookSpecificOutput.additionalContext !== undefined && typeof value.hookSpecificOutput.additionalContext !== "string")))) {
			throw new Error("Invalid hook output schema");
		}
		result.json = value;
	} catch (error) { result.jsonError = error instanceof Error ? error.message : String(error); }
	return result;
}

function missingScriptError(command: HookCommand, stderr: string): boolean {
	if (!/not found|no such file|cannot find|can't open file/i.test(stderr)) return false;
	if (/can't open file|cannot find module/i.test(stderr)) return true;
	const candidates = command.args?.length
		? command.args.filter((arg) => /\.(?:[cm]?js|ts|py|sh|ps1|bat|cmd)$/i.test(arg))
		: [command.command];
	return candidates.some((path) => stderr.includes(path) || stderr.includes(basename(path)));
}

/** Execute one trusted command. `args: []` still selects exec form; omission selects shell form. */
export async function runHook(command: HookCommand, input: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal; env?: Record<string, string> }): Promise<HookRunResult> {
	const result: HookRunResult = { exitCode: null, stdout: "", stderr: "", timedOut: false, missingScript: false };
	if (options.signal?.aborted) return { ...result, stderr: "Hook cancelled before execution" };
	let payload: string;
	try { payload = JSON.stringify(input) + "\n"; }
	catch (error) { return { ...result, stderr: `Cannot serialize hook input: ${String(error)}` }; }
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command.command, command.args ?? [], {
				cwd: options.cwd, env: { ...process.env, ...options.env }, shell: command.args === undefined,
				windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) { result.stderr = `Cannot start hook: ${String(error)}`; resolve(result); return; }
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let terminating = false;
		let spawnFailed = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			result.missingScript ||= result.exitCode === 127 || (result.exitCode === 2 && missingScriptError(command, result.stderr));
			resolve(parseOutput(result));
		};
		const terminate = () => {
			if (terminating || settled) return;
			terminating = true;
			if (child.pid) {
				if (process.platform === "win32") {
					// Killing the shell alone can leave its script holding our output pipes open.
					const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
					killer.on("error", () => { child.kill("SIGKILL"); });
					killer.on("exit", (code) => { if (code !== 0) child.kill("SIGKILL"); });
				} else {
					try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
				}
			}
			killTimer = setTimeout(() => {
				child.kill("SIGKILL");
				child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
				finish();
			}, 1000);
		};
		const abort = () => { result.stderr += "\nHook cancelled"; terminate(); };
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		for (const [stream, key] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
			stream?.on("data", (chunk: string) => {
				if (result[key].length + chunk.length > MAX_OUTPUT) {
					result[key] = (result[key] + chunk).slice(0, MAX_OUTPUT);
					result.jsonError = "Hook output exceeded the 1 MiB character limit";
					terminate();
				} else result[key] += chunk;
			});
		}
		child.on("error", (error: NodeJS.ErrnoException) => {
			spawnFailed = true;
			result.stderr += `\nCannot execute hook: ${error.message}`;
			result.missingScript = error.code === "ENOENT";
		});
		child.on("close", (code) => { result.exitCode = spawnFailed ? null : code; finish(); });
		// Early-exiting scripts may close stdin without reading the supplied input.
		child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") result.stderr += `\nHook stdin: ${error.message}`;
		});
		child.stdin?.end(payload);
		const timeoutMs = command.timeout !== undefined && Number.isFinite(command.timeout) && command.timeout > 0 ? command.timeout * 1000 : 60_000;
		timer = setTimeout(() => { result.timedOut = true; result.stderr += "\nHook timed out"; terminate(); }, Math.min(timeoutMs, 2_147_483_647));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}
