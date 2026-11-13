import { spawn } from "node:child_process";
import { HerdrCliError, type HerdrAgentRef, type HerdrClient, type HerdrMachine } from "./client.ts";

/**
 * The Herdr app's terminals as a HerdrClient. A subagent's terminal is a child of its parent's terminal, started together
 * with its program, so it has no placement; the app lists it under the parent. Pane IDs are terminal addresses on the
 * runner's machine (`t7`); a machine client adds and strips `machine/`.
 */

/**
 * Runner session tag for records of one hc core, by its permanent id. Cores on one machine share its store but not
 * terminals, and their addresses repeat. The `@` keeps herdr runners away from them.
 */
export function hcSessionTag(coreId: string): string {
	return `@hc:${coreId}`;
}

export function isHcSessionTag(tag: string): boolean {
	return tag.startsWith("@hc:");
}

/** The permanent id of the core these calls reach, however hc routes them; env names alone could point elsewhere. */
export async function hcCoreId(call: HcCall): Promise<string> {
	const id = record(record(await call("server.status", {}, { timeout: LIST_TIMEOUT_MS }))?.core)?.id;
	if (typeof id !== "string" || !id) throw new HcError("hc server status did not name its core");
	return id;
}

/** Finds a subagent's terminal: hc cannot rename, so its name is only for the app's list. */
export const HC_AGENT_LABEL = "herdr-subagents.agent";
/** `<pid>:<session file name>`, written by the Pi that runs in the terminal. */
export const HC_SESSION_LABEL = "herdr-subagents.session";

const CALL_TIMEOUT_MS = 70_000;
/** hc answers a listing only after every connected machine does, so even local calls can wait on SSH. */
const LIST_TIMEOUT_MS = 10_000;

/** One hc API call. `anonymous` drops the caller's terminal identity, which hc would otherwise wrap sent text with. */
export type HcCall = (method: string, params: Record<string, unknown>, options?: { timeout?: number; signal?: AbortSignal; anonymous?: boolean }) => Promise<unknown>;

export class HcError extends HerdrCliError {}

interface HcTerminal {
	address: string;
	state?: string;
	name?: string | null;
	pid?: number | null;
	argv?: string[];
	cwd?: string;
	labels?: Record<string, string>;
	foreground?: { pid?: number; name?: string; argv?: string[]; cwd?: string } | null;
	status?: { app?: string; state?: string } | null;
}

/** Calls the hc API through `hc connect`, one request per process. */
export function hcConnect(env: NodeJS.ProcessEnv = process.env): HcCall {
	const bin = env.HC_BIN_PATH || "hc";
	return (method, params, options = {}) => new Promise((resolve, reject) => {
		const childEnv = options.anonymous ? { ...env, HC_TERMINAL_ID: undefined, HC_SCOPE: undefined } : env;
		const child = spawn(bin, ["connect"], { env: childEnv, signal: options.signal, killSignal: "SIGKILL", windowsHide: true });
		// Spawn's own timeout outlives a failed start, holding the event loop.
		const timeout = options.timeout ?? CALL_TIMEOUT_MS;
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
		let stdout = "";
		let stderr = "";
		// On Windows, hc connect exits when its input closes, even before a slower reply (terminal.label) is written.
		// Keep the input open until the reply arrives.
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.split("\n").some((line) => { try { return JSON.parse(line)?.id === 1; } catch { return false; } })) child.stdin.end();
		});
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			let reply: { result?: unknown; error?: { message?: string; data?: { kind?: string } } } | undefined;
			for (const line of stdout.split("\n")) {
				try {
					const parsed = JSON.parse(line);
					if (parsed?.id === 1) reply = parsed;
				} catch {}
			}
			if (reply?.error) reject(new HcError(reply.error.message ?? `hc ${method} failed`, reply.error.data?.kind));
			else if (reply && "result" in reply) resolve(reply.result);
			else if (timedOut) reject(new HcError(`hc ${method} timed out after ${timeout}ms`, "timeout"));
			else reject(new HcError(stderr.trim() || `hc connect ${signal ? `terminated by ${signal}` : `exited ${code}`} without answering ${method}`));
		});
		child.stdin.on("error", () => undefined);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
	});
}

/** The terminal the app shows focused: undefined when unknown, null when no window has one. */
export type HcFocus = () => Promise<string | null | undefined>;

export function herdrAppFocus(env: NodeJS.ProcessEnv = process.env): HcFocus {
	return () => new Promise((resolve) => {
		const child = spawn(env.HERDR_APP_BIN_PATH || "herdr-app", ["status"], { env, timeout: 2500, killSignal: "SIGKILL", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => {
			try { resolve(code === 0 ? JSON.parse(stdout).agent ?? null : undefined); }
			catch { resolve(undefined); }
		});
	});
}

/** Saved hc machines in Herdr's shape. hc addresses a machine by its name, which becomes the label. */
export async function listHcMachines(call: HcCall, timeout = LIST_TIMEOUT_MS): Promise<HerdrMachine[]> {
	const machines = record(await call("machine.list", {}, { timeout }))?.machines;
	if (!Array.isArray(machines)) throw new Error("hc machine list did not return a machines array");
	return machines.flatMap((item) => {
		const machine = record(item);
		if (typeof machine?.id !== "string" || typeof machine.name !== "string" || typeof machine.target !== "string") return [];
		// The id is that machine's core's permanent id.
		return [{ id: machine.id, label: machine.name, target: machine.target, enabled: true }];
	});
}

/** The app's row for a subagent: machine when remote, then role; unique among live terminals, at most 32 of a-z 0-9 - _. */
export function hcTerminalName(role: string, machine?: string): string {
	const slug = [machine, role].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return (slug || "agent").slice(0, 28).replace(/-+$/g, "");
}

/** Positive evidence of the conversation a terminal runs, or undefined. */
export function hcSession(terminal: HcTerminal): string | undefined {
	if (terminal.state !== "live" || typeof terminal.foreground?.pid !== "number") return undefined;
	const published = terminal.labels?.[HC_SESSION_LABEL];
	if (published) {
		const colon = published.indexOf(":");
		const pid = Number(published.slice(0, colon));
		const session = published.slice(colon + 1);
		if (colon <= 0 || !Number.isSafeInteger(pid) || pid <= 0 || !session) return undefined;
		// Pi retitles itself, so its argv cannot tell; its PID ties the label to the process that wrote it.
		if (pid === terminal.foreground.pid) return session;
		// Windows reports the dedicated pi.cmd launcher's PID, not its Node child. Its one-shot command and
		// unchanged root PID prove only the original launch session, never a label left by another conversation.
		const launched = launchSession(terminal);
		return launched && session === launched.split(/[\\/]/).pop() && windowsPiLauncher(terminal) ? session : undefined;
	}
	// A subagent's launched program, still in the foreground, runs the session it was started with.
	if (!terminal.labels?.[HC_AGENT_LABEL] || terminal.foreground.pid !== terminal.pid) return undefined;
	return launchSession(terminal);
}

function launchSession(terminal: HcTerminal): string | undefined {
	const argv = terminal.argv ?? [];
	for (const flag of ["--session", "--session-id", "--resume"]) {
		const index = argv.indexOf(flag);
		if (index >= 0 && argv[index + 1]) return argv[index + 1];
	}
	return undefined;
}

function windowsPiLauncher(terminal: HcTerminal): boolean {
	const foreground = terminal.foreground;
	if (!terminal.labels?.[HC_AGENT_LABEL] || terminal.status?.app !== "pi" || foreground?.pid !== terminal.pid
		|| !/^(?:.*[\\/])?cmd\.exe$/i.test(foreground?.name ?? "") || !/^(?:.*[\\/])?pi(?:\.cmd)?$/i.test(terminal.argv?.[0] ?? "")) return false;
	const argv = foreground?.argv ?? [];
	const index = argv.findIndex(arg => arg.toLowerCase() === "/c");
	const command = index >= 0 && index === argv.length - 2 ? argv[index + 1] : "";
	const parsed = windowsLauncherArgs(command);
	if (!parsed || !/^(?:.*[\\/])?pi\.cmd$/i.test(parsed[0] ?? "")) return false;
	const expected = (terminal.argv ?? []).slice(1);
	// Match the entire original argv, not flag-looking text inside a quoted prompt, and refuse ambiguous selectors.
	return parsed.length === expected.length + 1 && expected.every((arg, i) => parsed[i + 1] === arg)
		&& expected.filter(arg => /^--(?:session(?:-id)?|resume)(?:=|$)/.test(arg)).length === 1;
}

/** Only the launcher's unexpanded words and whole-argument quotes are supported; ambiguous cmd syntax fails closed. */
function windowsLauncherArgs(command: string): string[] | undefined {
	const args: string[] = [];
	let word = "";
	let started = false;
	let quoted = false;
	let closed = false;
	for (const char of command) {
		if (/[\r\n%!]/.test(char)) return undefined; // Expansion can change even quoted arguments.
		if (char === '"') {
			if (!started) { started = true; quoted = true; }
			else if (quoted && !word.endsWith("\\")) { quoted = false; closed = true; }
			else return undefined;
		} else if (!quoted && /\s/.test(char)) {
			if (started) { args.push(word); word = ""; started = false; closed = false; }
		} else {
			if (closed || (!quoted && /[&|<>^()]/.test(char))) return undefined;
			word += char;
			started = true;
		}
	}
	if (quoted) return undefined;
	if (started) args.push(word);
	return args;
}

const AGENT_PROGRAM = /^(pi|claude|node|bun)(\.cmd|\.exe)?$/i;

export function hcRef(terminal: HcTerminal, paneId: string, focus?: string | null): HerdrAgentRef {
	const live = terminal.state === "live";
	const session = hcSession(terminal);
	const program = (terminal.foreground?.name ?? terminal.foreground?.argv?.[0] ?? "").split(/[\\/]/).pop() ?? "";
	// Finished, or a live program that is neither an agent nor reports as one: nothing there can hold a conversation.
	const plainShell = !session && (!live || (!!terminal.foreground && !terminal.status?.app && !AGENT_PROGRAM.test(program)));
	const name = live ? terminal.labels?.[HC_AGENT_LABEL] : undefined;
	const cwd = terminal.foreground?.cwd ?? terminal.cwd;
	return {
		...(name ? { name } : {}),
		paneId,
		...(cwd ? { cwd } : {}),
		...(focus !== undefined ? { focused: focus === terminal.address } : {}),
		...(live ? { status: terminal.status?.state ?? "unknown" } : {}),
		...(session ? { session } : {}),
		...(plainShell ? { plainShell: true as const } : {}),
	};
}

export interface HcOptions {
	/** Saved hc machine name; its terminals are `machine/tN`. */
	machine?: string;
	call?: HcCall;
	focus?: HcFocus;
}

export function createHcCli(env: NodeJS.ProcessEnv = process.env, options: HcOptions = {}): HerdrClient {
	const call = options.call ?? hcConnect(env);
	const focus = options.focus ?? herdrAppFocus(env);
	const machine = options.machine;
	const prefix = machine ? `${machine}/` : "";
	const address = (paneId: string) => `${prefix}${paneId}`;
	// Listings span every connected machine; this client sees only its own.
	const ours = (terminal: HcTerminal) => machine ? terminal.address.startsWith(prefix) : !terminal.address.includes("/");
	const paneOf = (terminal: HcTerminal) => terminal.address.slice(prefix.length);
	const list = async (params: Record<string, unknown>, signal?: AbortSignal, timeout = LIST_TIMEOUT_MS): Promise<HcTerminal[]> => {
		const listing = record(await call("terminal.list", params, { timeout, signal }));
		const terminals = listing?.terminals;
		if (!Array.isArray(terminals)) throw new HcError("hc terminal list did not return a terminals array");
		// hc leaves out the terminals of a machine it cannot reach, which proves nothing about them.
		if (machine) {
			const line = Array.isArray(listing?.machines) ? listing.machines.map(record).find((item) => item?.name === machine) : undefined;
			if (line?.state !== "connected") throw new HcError(`hc machine ${machine} is ${typeof line?.state === "string" ? line.state : "not listed"}`, "unavailable");
		}
		return terminals.filter((item): item is HcTerminal => typeof record(item)?.address === "string").filter(ours);
	};
	// Only terminals of this package's Pis and subagents can hold a conversation it tracks.
	const tracked = (terminal: HcTerminal) => !!terminal.labels?.[HC_AGENT_LABEL] || !!terminal.labels?.[HC_SESSION_LABEL];
	const named = async (name: string, signal?: AbortSignal, timeout?: number) =>
		(await list({ labels: { [HC_AGENT_LABEL]: name } }, signal, timeout)).find((terminal) => terminal.state === "live");
	let hostId: Promise<string> | undefined;
	const unsupported = (operation: string) => async (): Promise<never> => {
		throw new Error(`hc terminals start with their program; ${operation} is not available. Use launch.`);
	};
	return {
		// Asked through this client's own route; a failure is not cached.
		hostId: () => hostId ??= (async () => {
			if (!machine) return hcCoreId(call);
			const found = (await listHcMachines(call)).find((item) => item.label === machine);
			if (!found) throw new HcError(`hc machine ${machine} is not listed`, "machine_unknown");
			return found.id;
		})().catch((error) => { hostId = undefined; throw error; }),
		split: unsupported("split"),
		createTab: unsupported("tab create"),
		startPi: unsupported("starting Pi in a pane"),
		startClaude: unsupported("starting Claude Code in a pane"),
		async launch(launch, signal) {
			const base = hcTerminalName(launch.role, machine);
			// Another parent's subagent may hold a name. Only that refusal proves nothing started; any other failure may hide a
			// started terminal, which a retry would duplicate on the same session.
			for (const name of [base, ...Array.from({ length: 8 }, (_, index) => `${base}-${index + 2}`), undefined]) {
				try {
					const started = record(await call("terminal.run", {
						argv: [launch.kind, ...launch.args], cwd: launch.cwd, labels: { [HC_AGENT_LABEL]: launch.name },
						// The default parent is the caller, also with `on`; an explicit parent would be resolved on that machine.
						...(env.HC_TERMINAL_ID ? { caller: env.HC_TERMINAL_ID } : {}),
						...(machine ? { on: machine } : {}), ...(name ? { name } : {}),
						// The runner decides when a subagent ends, as with Herdr panes.
						outlive_parent: true, no_notify: true,
					}, { signal }));
					if (typeof started?.address !== "string" || !started.address.startsWith(prefix)) throw new HcError("hc run did not return this machine's terminal address");
					return { paneId: started.address.slice(prefix.length) };
				} catch (error) {
					if (error instanceof HcError && error.code === "name_taken" && name) continue;
					throw error;
				}
			}
			throw new HcError("hc run found no free name");
		},
		async promptAgent(target, text, signal) {
			// Anonymous: from a terminal, hc wraps text as <hc from=...>, which turns a slash command into chat text.
			await call("terminal.send", { terminal: address(target), text }, { timeout: 30_000, signal, anonymous: true });
		},
		async closePane(paneId) {
			try { await call("terminal.kill", { terminal: address(paneId) }); }
			catch (error) {
				if (!(error instanceof HcError && error.code === "not_found")) throw error;
				return;
			}
			// A finished terminal stays listed in the app until removed.
			await call("terminal.rm", { terminal: address(paneId) }).catch(() => undefined);
		},
		async isAlive(name) { return !!(await named(name)); },
		async getAgent(name, signal, bounded) {
			const terminal = await named(name, signal, bounded ? LIST_TIMEOUT_MS : CALL_TIMEOUT_MS);
			return terminal && hcRef(terminal, paneOf(terminal));
		},
		async getPane(paneId, signal) {
			let terminal: HcTerminal | undefined;
			try { terminal = record(await call("terminal.get", { terminal: address(paneId) }, { timeout: LIST_TIMEOUT_MS, signal })) as HcTerminal | undefined; }
			catch (error) {
				if (error instanceof HcError && error.code === "not_found") return undefined;
				throw error;
			}
			if (typeof terminal?.address !== "string") throw new HcError("hc get did not return a terminal");
			return hcRef(terminal, paneId, await focus());
		},
		async showLabel() {
			// The app shows the name given at launch; hc cannot rename.
		},
		async listAgents(signal) {
			return (await list({}, signal)).filter((terminal) => terminal.state === "live" && tracked(terminal)).map((terminal) => hcRef(terminal, paneOf(terminal)));
		},
		async listPanes(options = {}) {
			const terminals = (await list({ all: true }, options.signal)).filter(tracked);
			const focused = await focus();
			return terminals.map((terminal) => hcRef(terminal, paneOf(terminal), focused));
		},
		async publishSession(paneId, sessionFile, pid = process.pid) {
			const value = sessionFile ? `${pid}:${sessionFile.split(/[\\/]/).pop()}` : "";
			await call("terminal.label", { terminal: address(paneId), labels: { [HC_SESSION_LABEL]: value } }, { timeout: 5000 });
		},
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
