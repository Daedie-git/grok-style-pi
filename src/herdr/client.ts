import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface HerdrAgentRef {
	name?: string;
	tabId?: string;
	paneId?: string;
	workspaceId?: string;
	cwd?: string;
}

/** A saved SSH machine from `herdr machine list --json`. */
export interface HerdrMachine {
	id: string;
	label: string;
	target: string;
	enabled: boolean;
}

export interface HerdrClient {
	split(options: { paneId: string; direction: "right" | "down"; cwd: string }): Promise<{ paneId: string }>;
	startPi(options: { name: string; paneId: string; args: string[] }, signal?: AbortSignal): Promise<void>;
	closePane(paneId: string): Promise<void>;
	isAlive(name: string): Promise<boolean>;
	showLabel(paneId: string, label: string): Promise<void>;
	listAgents(signal?: AbortSignal): Promise<HerdrAgentRef[]>;
	/** Every physical pane, including shells whose agent has exited. */
	listPanes(options?: { workspaceId?: string; signal?: AbortSignal }): Promise<HerdrAgentRef[]>;
	createTab(options: { cwd: string; label?: string; workspaceId?: string }): Promise<{ tabId: string; paneId: string; workspaceId?: string }>;
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
	return items.map((item) => {
		const record = object(item);
		return {
			...(typeof record?.name === "string" ? { name: record.name } : {}),
			tabId: typeof record?.tab_id === "string" ? record.tab_id : undefined,
			paneId: typeof record?.pane_id === "string" ? record.pane_id : undefined,
			...(typeof record?.workspace_id === "string" ? { workspaceId: record.workspace_id } : {}),
			...(typeof record?.cwd === "string" ? { cwd: record.cwd } : {}),
		};
	});
}

export function machinesFromList(payload: unknown): HerdrMachine[] {
	if (!Array.isArray(payload)) throw new Error("Herdr machine list did not return an array");
	return payload.flatMap((item) => {
		const record = object(item);
		if (typeof record?.id !== "string" || typeof record.label !== "string" || typeof record.target !== "string") return [];
		return [{ id: record.id, label: record.label, target: record.target, enabled: record.enabled !== false }];
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

/** Resolves a saved machine the way `herdr --machine` does: profile ID first, then a unique label. */
export async function findHerdrMachine(selector: string, env: NodeJS.ProcessEnv = process.env): Promise<HerdrMachine> {
	const machines = await listHerdrMachines(env);
	const byId = machines.find((machine) => machine.id === selector);
	const byLabel = machines.filter((machine) => machine.label === selector);
	if (!byId && byLabel.length > 1) throw new Error(`Herdr machine label '${selector}' is ambiguous; use its profile ID.`);
	const machine = byId ?? byLabel[0];
	if (!machine) throw new Error(`Unknown Herdr machine '${selector}'. Add it with herdr machine add, then check herdr machine list.`);
	if (!machine.enabled) throw new Error(`Herdr machine '${selector}' is disabled.`);
	return machine;
}

/** With `machine`, every command is routed to that saved SSH machine's Herdr server. Pane IDs are then remote. */
export function createHerdrCli(env: NodeJS.ProcessEnv = process.env, timing = {
	now: () => Date.now(),
	sleep: (ms: number, signal?: AbortSignal): Promise<void> => delay(ms, undefined, { signal }),
}, machine?: string): HerdrClient {
	const bin = env.HERDR_BIN_PATH || "herdr";
	const prefix = machine ? ["--machine", machine] : [];
	// Listings cross SSH when routed to a machine.
	const listTimeout = machine ? 10_000 : 2500;
	const routed = (binary: string, args: string[], ...rest: CallOptions) => call(binary, [...prefix, ...args], ...rest);
	return {
		async split(options) {
			const payload = await routed(bin, [
				"pane", "split", "--pane", options.paneId, "--direction", options.direction,
				"--cwd", options.cwd, "--no-focus",
			], env);
			return { paneId: paneIdFromSplit(payload) };
		},
		async startPi(options, signal) {
			const deadline = timing.now() + 60_000;
			for (;;) {
				signal?.throwIfAborted();
				try {
					await routed(bin, [
						"agent", "start", options.name, "--kind", "pi", "--pane", options.paneId, "--timeout", "60000",
						"--", ...options.args,
					], env, 70_000, signal);
					return;
				} catch (error) {
					// This rejection happens before launch. Never retry ambiguous startup or transport failures.
					if (!(error instanceof HerdrCliError)
						|| error.message !== `agent target pane ${options.paneId} is not an available shell`) throw error;
					const remaining = deadline - timing.now();
					if (remaining <= 0) throw new Error(`Timed out after 60 seconds waiting for shell readiness in ${options.paneId}: ${error.message}`);
					await timing.sleep(Math.min(250, remaining), signal);
				}
			}
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

class HerdrCliError extends Error {
	code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

function errorPayload(text: string): Record<string, unknown> | undefined {
	try { return object(object(parsePayload(text))?.error); }
	catch { return undefined; } // Preserve plain or malformed CLI diagnostics instead of masking them with a parse error.
}

type CallOptions = [env: NodeJS.ProcessEnv, timeout?: number, signal?: AbortSignal];

function call(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout = 70_000, signal?: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { env, timeout, signal, killSignal: "SIGKILL" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			try {
				const payload = code === 0 ? parsePayload(stdout) : undefined;
				// Herdr sends structured failures to stderr. Older versions may use stdout.
				const error = code === 0 ? object(object(payload)?.error) : errorPayload(stderr) ?? errorPayload(stdout);
				if (code !== 0 || error) {
					reject(new HerdrCliError(
						typeof error?.message === "string" ? error.message : stderr.trim() || stdout.trim() || `herdr ${args.join(" ")} exited ${code}`,
						typeof error?.code === "string" ? error.code : undefined,
					));
					return;
				}
				resolve(payload);
			} catch (error) {
				reject(error);
			}
		});
	});
}
