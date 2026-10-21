// Extension spawn API (plan §16.9, §17.10): other extensions launch subagents without a model-visible Agent call.
//
//   pi.events.emit("subagent-engine:register", { extensionId: "my-ext", reply(handle) { ... } })
//
// The reply carries an engine-issued launcher handle; every launch goes through it, which stamps its origin. The extension id
// is self-declared, so the per-extension cap is cooperative accounting between trusted in-process extensions, not a security
// boundary. Ordinary admission (the global cap and depth) still applies to every launch.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROOT_CALLER, type AgentParams, type Engine, type ToolText } from "./engine.ts";

export const REGISTER_CHANNEL = "subagent-engine:register";
export const DEFAULT_EXTENSION_CAP = 20;

export interface LauncherHandle {
	readonly extensionId: string;
	/** Launches in the background; resolves once the agent has started (or with an error result). */
	spawn(params: Omit<AgentParams, "run_in_background">): Promise<ToolText>;
	stop(agentId: string): Promise<ToolText>;
	status(agentId: string, options?: { wait?: boolean; signal?: AbortSignal }): Promise<ToolText>;
	/** Agents launched through this handle that have not settled. */
	running(): number;
}

interface RegisterRequest {
	extensionId?: unknown;
	cap?: unknown;
	reply?: unknown;
}

export function installSpawnApi(pi: ExtensionAPI, engine: () => Engine): void {
	let current: ExtensionContextRef | undefined;
	pi.on("session_start", (_event, ctx) => { current = { ctx }; });
	pi.on("session_shutdown", () => { current = undefined; });
	pi.events.on(REGISTER_CHANNEL, (data) => {
		const request = data as RegisterRequest;
		if (typeof request?.reply !== "function" || typeof request.extensionId !== "string" || !request.extensionId.trim()) return;
		const cap = typeof request.cap === "number" && request.cap > 0 ? Math.floor(request.cap) : DEFAULT_EXTENSION_CAP;
		(request.reply as (handle: LauncherHandle) => void)(createHandle(request.extensionId.trim(), cap, engine, () => current));
	});
}

interface ExtensionContextRef {
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext;
}

function createHandle(extensionId: string, cap: number, engine: () => Engine, context: () => ExtensionContextRef | undefined): LauncherHandle {
	// Shared by every handle registered under this id, so re-registering never resets the cap (pre-push review #4).
	// Accounting is resolved from the current engine at each call (it changes on reload adoption, review recheck #2).
	const accounting = () => engine().extensionAccounting(extensionId);
	return {
		extensionId,
		running: () => accounting().size,
		async spawn(params) {
			const ref = context();
			if (!ref) return { text: "The session is not ready.", isError: true };
			const live = accounting();
			if (live.size >= cap) return { text: `${extensionId} already has ${cap} agents running.`, isError: true };
			// Reserve the slot synchronously so concurrent launches cannot both pass the cap (review R09).
			// Globally unique reservation token: handles of the same extension share one accounting set (recheck #1).
			const slot = `pending:${randomUUID()}`;
			live.add(slot);
			// Observe settlement before launching, so a child that finishes during spawn is not counted forever.
			const settledEarly = new Set<string>();
			let agentId: string | undefined;
			const unsubscribe = engine().subscribe((event) => {
				if (event.type !== "settled") return;
				if (agentId === undefined) { settledEarly.add(event.agentId); return; }
				if (event.agentId !== agentId) return;
				live.delete(agentId);
				unsubscribe();
			});
			let result: ToolText;
			try {
				result = await engine().spawn({ ...params, run_in_background: true }, ROOT_CALLER, {
					toolCallId: `ext:${extensionId}:${Date.now().toString(36)}:${slot}`, ctx: ref.ctx, origin: "model",
				});
			} catch (spawnError) {
				live.delete(slot);
				unsubscribe();
				throw spawnError;
			}
			live.delete(slot);
			const launched = typeof result.details?.agentId === "string" && !result.isError ? result.details.agentId : undefined;
			if (!launched || settledEarly.has(launched)) {
				unsubscribe();
				return result;
			}
			agentId = launched;
			live.add(agentId);
			return result;
		},
		stop: (agentId) => engine().stop(agentId, ROOT_CALLER),
		status: (agentId, options) => engine().readResult(agentId, ROOT_CALLER, options ?? {}),
	};
}
