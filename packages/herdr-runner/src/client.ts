import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface HerdrAgentRef {
	name?: string;
	tabId?: string;
	paneId?: string;
	workspaceId?: string;
	cwd?: string;
	/** Missing focus metadata must never be treated as proof that a pane is unfocused. */
	focused?: boolean;
	status?: string;
	/** Herdr's session identity for the agent, such as Pi's session file. */
	session?: string;
	/** Positive native shell evidence; absent means the occupant's classification is not established. */
	plainShell?: true;
}

/** A saved SSH machine from `herdr machine list --json`. */
export interface HerdrMachine {
	id: string;
	label: string;
	target: string;
	enabled: boolean;
	/** The remote Herdr session this profile connects to. */
	session?: string;
}

export interface HerdrPaneLayout {
	tabId: string;
	panes: { paneId: string; x: number; y: number; width: number; height: number }[];
}

/** Starts an agent program in a terminal of its own. */
export interface AgentLaunch {
	/** The agent's Herdr name, which later lookups use. */
	name: string;
	kind: "pi" | "claude";
	args: string[];
	cwd: string;
	/** Its subagent type, for the host's display. */
	role: string;
}

/**
 * One terminal host's commands: a herdr server (createHerdrCli), whose panes open before an agent starts in them, or the
 * Herdr app's hc (createHcCli in hc.ts), whose terminals start with their program through `launch`.
 */
export interface HerdrClient {
	/** The same commands against another session of this server's machine. */
	forSession?(session: string): HerdrClient;
	split(options: { paneId: string; direction: "right" | "down"; cwd: string }): Promise<{ paneId: string }>;
	startPi(options: { name: string; paneId: string; args: string[] }, signal?: AbortSignal): Promise<void>;
	startClaude?(options: { name: string; paneId: string; args: string[] }, signal?: AbortSignal): Promise<void>;
	/** Targets a live agent name or the pane ID hosting it. */
	promptAgent?(target: string, text: string, signal?: AbortSignal): Promise<void>;
	closePane(paneId: string): Promise<void>;
	isAlive(name: string): Promise<boolean>;
	/** The live agent holding this name, or undefined when none does. */
	/** `bounded` limits it like a listing, for a caller holding a lease; a timeout then rejects, leaving liveness unknown. */
	getAgent(name: string, signal?: AbortSignal, bounded?: boolean): Promise<HerdrAgentRef | undefined>;
	/** Resolves inherited pane aliases after a workspace move. */
	getPane?(paneId: string, signal?: AbortSignal): Promise<HerdrAgentRef | undefined>;
	showLabel(paneId: string, label: string): Promise<void>;
	listAgents(signal?: AbortSignal): Promise<HerdrAgentRef[]>;
	/** Live geometry for every pane in the target pane's tab. */
	paneLayout?(paneId: string, signal?: AbortSignal): Promise<HerdrPaneLayout>;
	/** Every physical pane, including shells whose agent has exited. */
	listPanes(options?: { workspaceId?: string; signal?: AbortSignal }): Promise<HerdrAgentRef[]>;
	createTab(options: { cwd: string; label?: string; workspaceId?: string }): Promise<{ tabId: string; paneId: string; workspaceId?: string }>;
	/** Opens a terminal running the agent, in place of placing a pane and starting it there. */
	launch?(options: AgentLaunch, signal?: AbortSignal): Promise<{ paneId: string }>;
	/** The permanent id of the host these commands reach, for hosts whose sessions the environment cannot name reliably. */
	hostId?(): Promise<string>;
	/** Records which conversation this process runs in its pane, for hosts that cannot see it; undefined withdraws it. */
	publishSession?(paneId: string, sessionFile: string | undefined): Promise<void>;
}

export function paneIdFromSplit(payload: unknown): string {
	const result = object(object(payload)?.result) ?? object(payload);
	const pane = object(result?.pane);
	const paneId = pane?.pane_id ?? result?.pane_id;
	if (typeof paneId !== "string" || !paneId) throw new Error("Herdr split did not return a pane id");
	return paneId;
}

export function tabFromCreate(payload: unknown): { tabId: string; paneId: string; workspaceId?: string } {
	const result = object(object(payload)?.result) ?? object(payload);
	const tabId = object(result?.tab)?.tab_id;
	const workspaceId = object(result?.tab)?.workspace_id;
	const paneId = object(result?.root_pane)?.pane_id;
	if (typeof tabId !== "string" || !tabId || typeof paneId !== "string" || !paneId) {
		throw new Error("Herdr tab create did not return a tab and root pane");
	}
	return { tabId, paneId, ...(typeof workspaceId === "string" ? { workspaceId } : {}) };
}

export function paneLayoutFromPayload(payload: unknown): HerdrPaneLayout {
	const result = object(object(payload)?.result) ?? object(payload);
	const layout = object(result?.layout);
	const tabId = layout?.tab_id;
	if (typeof tabId !== "string" || !tabId.trim() || !Array.isArray(layout?.panes) || !layout.panes.length) {
		throw new Error("Herdr pane layout did not return a tab and nonempty panes array");
	}
	const paneIds = new Set<string>();
	const panes = layout.panes.map((item: unknown) => {
		const pane = object(item);
		const paneId = pane?.pane_id;
		const rect = object(pane?.rect);
		const x = rect?.x;
		const y = rect?.y;
		const width = rect?.width;
		const height = rect?.height;
		if (typeof paneId !== "string" || !paneId.trim()
			|| typeof x !== "number" || !Number.isFinite(x)
			|| typeof y !== "number" || !Number.isFinite(y)
			|| typeof width !== "number" || !Number.isFinite(width) || width <= 0
			|| typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
			throw new Error("Herdr pane layout returned an invalid pane id or rectangle");
		}
		if (paneIds.has(paneId)) throw new Error("Herdr pane layout returned duplicate pane ids");
		paneIds.add(paneId);
		return { paneId, x, y, width, height };
	});
	return { tabId, panes };
}

export function agentsFromList(payload: unknown): HerdrAgentRef[] {
	return refsFromList(payload, "agents", "agent list");
}

export function panesFromList(payload: unknown): HerdrAgentRef[] {
	return refsFromList(payload, "panes", "pane list");
}

function refsFromList(payload: unknown, key: string, operation: string): HerdrAgentRef[] {
	const result = object(object(payload)?.result) ?? object(payload);
	const items = result?.[key];
	if (!Array.isArray(items)) throw new Error(`Herdr ${operation} did not return a ${key} array`);
	return items.map(agentRef);
}

export function agentRef(item: unknown): HerdrAgentRef {
	const record = object(item);
	const session = object(record?.agent_session)?.value;
	return {
		...(typeof record?.name === "string" ? { name: record.name } : {}),
		tabId: typeof record?.tab_id === "string" ? record.tab_id : undefined,
		paneId: typeof record?.pane_id === "string" ? record.pane_id : undefined,
		...(typeof record?.workspace_id === "string" ? { workspaceId: record.workspace_id } : {}),
		...(typeof record?.cwd === "string" ? { cwd: record.cwd } : {}),
		...(typeof record?.focused === "boolean" ? { focused: record.focused } : {}),
		...(typeof record?.agent_status === "string" ? { status: record.agent_status } : {}),
		...(typeof session === "string" ? { session } : {}),
		...(record && typeof record.pane_id === "string" && record.pane_id && record.agent_status === "unknown"
			&& !Object.hasOwn(record, "agent") && !Object.hasOwn(record, "agent_session") && !Object.hasOwn(record, "name")
			? { plainShell: true as const } : {}),
	};
}

export function machinesFromList(payload: unknown): HerdrMachine[] {
	if (!Array.isArray(payload)) throw new Error("Herdr machine list did not return an array");
	return payload.flatMap((item) => {
		const record = object(item);
		if (typeof record?.id !== "string" || typeof record.label !== "string" || typeof record.target !== "string") return [];
		return [{ id: record.id, label: record.label, target: record.target, enabled: record.enabled !== false, ...(typeof record.session === "string" ? { session: record.session } : {}) }];
	});
}

export const SAVED_MACHINES_UNSUPPORTED = "Remote subagents need Herdr 0.9.1 or later on both machines (herdr machine and herdr --machine); the local herdr does not support saved machines. Update Herdr, add the machine with herdr machine add <ssh-target>, then /reload. Do not work around this by starting agents over SSH yourself.";

export async function listHerdrMachines(env: NodeJS.ProcessEnv = process.env, timeout = 10_000): Promise<HerdrMachine[]> {
	try { return machinesFromList(await call(env.HERDR_BIN_PATH || "herdr", ["machine", "list", "--json"], env, timeout)); }
	catch (error) {
		// Herdr before 0.9 rejects the subcommand outright; say what to do instead of passing that through.
		if (error instanceof HerdrCliError && /unknown command: machine/.test(error.message)) throw new Error(SAVED_MACHINES_UNSUPPORTED);
		throw error;
	}
}

/** Selects a saved machine the way `herdr --machine` does: profile ID first, then a unique label. */
export function pickHerdrMachine(machines: HerdrMachine[], selector: string): HerdrMachine | undefined {
	const byLabel = machines.filter((machine) => machine.label === selector);
	return machines.find((machine) => machine.id === selector) ?? (byLabel.length === 1 ? byLabel[0] : undefined);
}

export async function findHerdrMachine(selector: string, env: NodeJS.ProcessEnv = process.env): Promise<HerdrMachine> {
	const machines = await listHerdrMachines(env);
	const machine = pickHerdrMachine(machines, selector);
	if (!machine && machines.some((item) => item.label === selector)) throw new Error(`Herdr machine label '${selector}' is ambiguous; use its profile ID.`);
	if (!machine) throw new Error(`Unknown Herdr machine '${selector}'. Add it with herdr machine add, then check herdr machine list.`);
	if (!machine.enabled) throw new Error(`Herdr machine '${selector}' is disabled.`);
	return machine;
}

/**
 * The session this process's Herdr commands reach. Panes receive the socket path, which also wins over an inherited
 * `HERDR_SESSION` in Herdr, and a named session keeps its socket in `sessions/<name>/`.
 */
export function herdrSessionName(env: NodeJS.ProcessEnv = process.env): string {
	const fromSocket = /[\\/]sessions[\\/]([^\\/]+)[\\/]herdr\.sock$/.exec(env.HERDR_SOCKET_PATH ?? "")?.[1];
	if (fromSocket) return fromSocket;
	return env.HERDR_SOCKET_PATH ? "default" : env.HERDR_SESSION?.trim() || "default";
}

/** With `machine`, every command is routed to that saved SSH machine's Herdr server. Pane IDs are then remote. */
const CALL_TIMEOUT_MS = 70_000;
/** A pane's shell and Pi can take over a minute to appear while a build holds every core. */
const START_TIMEOUT_MS = 120_000;

/** One Herdr command's raw outcome. */
export interface HerdrExecResult { code: number | null; stdout: string; stderr: string }
/** Runs Herdr on the client's machine without the CLI's own route. Undefined means that route is unavailable. */
export type HerdrExec = (args: string[], timeout: number, signal?: AbortSignal) => Promise<HerdrExecResult | undefined>;

export function createHerdrCli(env: NodeJS.ProcessEnv = process.env, timing = {
	now: () => Date.now(),
	sleep: (ms: number, signal?: AbortSignal): Promise<void> => delay(ms, undefined, { signal }),
}, machine?: string, session?: string, exec?: HerdrExec): HerdrClient {
	const bin = env.HERDR_BIN_PATH || "herdr";
	const prefix = machine ? ["--machine", machine] : session ? ["--session", session] : [];
	// Listings cross SSH when routed to a machine.
	const listTimeout = machine ? 10_000 : 2500;
	const routed = async (binary: string, args: string[], ...rest: CallOptions) => {
		const [, timeout = CALL_TIMEOUT_MS, signal] = rest;
		const result = await exec?.(args, timeout, signal);
		if (result) return herdrPayload(result, args);
		// That machine's worker cannot run Herdr, so this client stops asking.
		exec = undefined;
		return call(binary, [...prefix, ...args], ...rest);
	};
	const start = async (kind: "pi" | "claude", options: { name: string; paneId: string; args: string[] }, signal?: AbortSignal) => {
		const deadline = timing.now() + START_TIMEOUT_MS;
		for (;;) {
			signal?.throwIfAborted();
			try {
				await routed(bin, ["agent", "start", options.name, "--kind", kind, "--pane", options.paneId, "--timeout", String(START_TIMEOUT_MS), "--", ...options.args], env, START_TIMEOUT_MS + 10_000, signal);
				return;
			} catch (error) {
				if (!(error instanceof HerdrCliError) || error.message !== `agent target pane ${options.paneId} is not an available shell`) throw error;
				const remaining = deadline - timing.now();
				if (remaining <= 0) throw new Error(`Timed out after ${START_TIMEOUT_MS / 1000} seconds waiting for shell readiness in ${options.paneId}: ${error.message}`);
				await timing.sleep(Math.min(250, remaining), signal);
			}
		}
	};
	return {
		// Herdr rejects `--session` with `--machine`: a machine exposes only its saved profile's session.
		...(machine ? {} : { forSession: (name: string) => createHerdrCli(env, timing, undefined, name) }),
		async split(options) {
			const payload = await routed(bin, [
				"pane", "split", "--pane", options.paneId, "--direction", options.direction,
				"--cwd", options.cwd, "--no-focus",
			], env);
			return { paneId: paneIdFromSplit(payload) };
		},
		startPi: (options, signal) => start("pi", options, signal),
		startClaude: (options, signal) => start("claude", options, signal),
		async promptAgent(target, text, signal) {
			// Submission only; completion comes from run-scoped Claude hooks, not terminal detection.
			await routed(bin, ["agent", "prompt", target, text], env, 10_000, signal);
		},
		async closePane(paneId) {
			await routed(bin, ["pane", "close", paneId], env);
		},
		async isAlive(name) {
			try {
				await routed(bin, ["agent", "get", name], env);
				return true;
			} catch (error) {
				if (error instanceof HerdrCliError && error.code === "agent_not_found") return false;
				throw error;
			}
		},
		async getAgent(name, signal, bounded) {
			try {
				const payload = await routed(bin, ["agent", "get", name], env, bounded ? listTimeout : undefined, signal);
				const result = object(object(payload)?.result) ?? object(payload);
				return agentRef(result?.agent);
			} catch (error) {
				if (error instanceof HerdrCliError && error.code === "agent_not_found") return undefined;
				throw error;
			}
		},
		async getPane(paneId, signal) {
			try {
				const payload = await routed(bin, ["pane", "get", paneId], env, listTimeout, signal);
				const result = object(object(payload)?.result) ?? object(payload);
				const pane = agentRef(result?.pane);
				if (!pane.paneId) throw new Error("Herdr pane get did not return a pane id");
				return pane;
			} catch (error) {
				if (error instanceof HerdrCliError && error.code === "pane_not_found") return undefined;
				throw error;
			}
		},
		async showLabel(paneId, label) {
			await routed(bin, [
				"pane", "report-metadata", paneId,
				"--source", "custom:grok-style-pi",
				"--agent", "pi",
				"--display-agent", label,
			], env);
		},
		async listAgents(signal) {
			return agentsFromList(await routed(bin, ["agent", "list"], env, listTimeout, signal));
		},
		async paneLayout(paneId, signal) {
			return paneLayoutFromPayload(await routed(bin, ["pane", "layout", "--pane", paneId], env, listTimeout, signal));
		},
		async listPanes(options = {}) {
			const args = ["pane", "list"];
			if (options.workspaceId) args.push("--workspace", options.workspaceId);
			return panesFromList(await routed(bin, args, env, listTimeout, options.signal));
		},
		async createTab(options) {
			const args = ["tab", "create", "--cwd", options.cwd, "--no-focus"];
			if (options.workspaceId) args.push("--workspace", options.workspaceId);
			if (options.label) args.push("--label", options.label);
			return tabFromCreate(await routed(bin, args, env));
		},
	};
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function parsePayload(stdout: string): unknown {
	const text = stdout.trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		const start = text.lastIndexOf("\n{");
		if (start >= 0) return JSON.parse(text.slice(start + 1));
		const brace = text.indexOf("{");
		if (brace >= 0) return JSON.parse(text.slice(brace));
		return undefined;
	}
}

export class HerdrCliError extends Error {
	code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

/** The session's server is not running. A handoff shows this briefly too, so it is not proof on its own. */
export function herdrServerDown(error: unknown): boolean {
	return error instanceof HerdrCliError && error.code === "server_not_running";
}

/** Only explicit pre-effect validation failures prove that no pane was created. */
export function paneCreationRejected(error: unknown): boolean {
	return error instanceof HerdrCliError && ["workspace_not_found", "tab_not_found", "pane_not_found", "invalid_params", "invalid_request", "machine_unknown", "invalid_template"].includes(error.code ?? "");
}

function errorPayload(text: string): Record<string, unknown> | undefined {
	try { return object(object(parsePayload(text))?.error); }
	catch { return undefined; } // Preserve plain or malformed CLI diagnostics instead of masking them with a parse error.
}

type CallOptions = [env: NodeJS.ProcessEnv, timeout?: number, signal?: AbortSignal];

function herdrPayload({ code, stdout, stderr }: HerdrExecResult, args: string[]): unknown {
	const payload = code === 0 ? parsePayload(stdout) : undefined;
	// Herdr sends structured failures to stderr. Older versions may use stdout.
	const error = code === 0 ? object(object(payload)?.error) : errorPayload(stderr) ?? errorPayload(stdout);
	if (code !== 0 || error) throw new HerdrCliError(
		typeof error?.message === "string" ? error.message : stderr.trim() || stdout.trim() || `herdr ${args.join(" ")} exited ${code}`,
		typeof error?.code === "string" ? error.code : undefined,
	);
	return payload;
}

function call(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout = CALL_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { env, timeout, signal, killSignal: "SIGKILL" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			try { resolve(herdrPayload({ code, stdout, stderr }, args)); }
			catch (error) { reject(error); }
		});
	});
}
