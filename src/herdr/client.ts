import { spawn } from "node:child_process";

export interface HerdrAgentRef {
	name?: string;
	tabId?: string;
	paneId?: string;
}

export interface HerdrClient {
	layout(paneId: string): Promise<unknown>;
	split(options: { paneId: string; direction: "right" | "down"; cwd: string }): Promise<{ paneId: string }>;
	startPi(options: { name: string; paneId: string; args: string[] }): Promise<void>;
	closePane(paneId: string): Promise<void>;
	isAlive(name: string): Promise<boolean>;
	showLabel(paneId: string, label: string): Promise<void>;
	listAgents(signal?: AbortSignal): Promise<HerdrAgentRef[]>;
	createTab(options: { cwd: string; label?: string }): Promise<{ tabId: string; paneId: string }>;
}

export function paneIdFromSplit(payload: unknown): string {
	const result = object(object(payload)?.result) ?? object(payload);
	const pane = object(result?.pane);
	const paneId = pane?.pane_id ?? result?.pane_id;
	if (typeof paneId !== "string" || !paneId) throw new Error("Herdr split did not return a pane id");
	return paneId;
}

export function tabFromCreate(payload: unknown): { tabId: string; paneId: string } {
	const result = object(object(payload)?.result) ?? object(payload);
	const tabId = object(result?.tab)?.tab_id;
	const paneId = object(result?.root_pane)?.pane_id;
	if (typeof tabId !== "string" || !tabId || typeof paneId !== "string" || !paneId) {
		throw new Error("Herdr tab create did not return a tab and root pane");
	}
	return { tabId, paneId };
}

export function agentsFromList(payload: unknown): HerdrAgentRef[] {
	const result = object(object(payload)?.result) ?? object(payload);
	const agents = result?.agents;
	if (!Array.isArray(agents)) throw new Error("Herdr agent list did not return an agents array");
	return agents.map((agent) => {
		const record = object(agent);
		return {
			...(typeof record?.name === "string" ? { name: record.name } : {}),
			tabId: typeof record?.tab_id === "string" ? record.tab_id : undefined,
			paneId: typeof record?.pane_id === "string" ? record.pane_id : undefined,
		};
	});
}

/** Wide panes split right. Missing geometry, and narrow or tall panes, split down. */
export function splitDirection(layout: unknown): "right" | "down" {
	const result = object(object(layout)?.result) ?? object(layout);
	const columns = numberField(result, ["columns", "width", "cols"]);
	const rows = numberField(result, ["rows", "height"]);
	if (columns == null || rows == null) return "down";
	if (columns >= 100 && columns > rows * 1.5) return "right";
	return "down";
}

export function createHerdrCli(env: NodeJS.ProcessEnv = process.env): HerdrClient {
	const bin = env.HERDR_BIN_PATH || "herdr";
	return {
		async layout(paneId) {
			try {
				return await call(bin, ["pane", "layout", "--pane", paneId], env);
			} catch {
				return undefined;
			}
		},
		async split(options) {
			const payload = await call(bin, [
				"pane", "split", "--pane", options.paneId, "--direction", options.direction,
				"--cwd", options.cwd, "--no-focus",
			], env);
			return { paneId: paneIdFromSplit(payload) };
		},
		async startPi(options) {
			await call(bin, [
				"agent", "start", options.name, "--kind", "pi", "--pane", options.paneId, "--timeout", "60000",
				"--", ...options.args,
			], env);
		},
		async closePane(paneId) {
			await call(bin, ["pane", "close", paneId], env);
		},
		async isAlive(name) {
			try {
				await call(bin, ["agent", "get", name], env);
				return true;
			} catch (error) {
				if (error instanceof HerdrCliError && error.code === "agent_not_found") return false;
				throw error;
			}
		},
		async showLabel(paneId, label) {
			await call(bin, [
				"pane", "report-metadata", paneId,
				"--source", "custom:grok-style-pi",
				"--agent", "pi",
				"--display-agent", label,
			], env);
		},
		async listAgents(signal) {
			return agentsFromList(await call(bin, ["agent", "list"], env, 2500, signal));
		},
		async createTab(options) {
			const args = ["tab", "create", "--cwd", options.cwd, "--no-focus"];
			if (options.label) args.push("--label", options.label);
			return tabFromCreate(await call(bin, args, env));
		},
	};
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function numberField(value: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!value) return undefined;
	for (const key of keys) {
		const found = value[key];
		if (typeof found === "number" && Number.isFinite(found)) return found;
	}
	return undefined;
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
