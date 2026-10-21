// Root wiring: one engine per Pi extension runtime. Inside a child session this factory does nothing; children get the
// child installer from their parent's engine instead (plan §0).
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inChildContext } from "./child-context.ts";
import { childInstaller } from "./child-installer.ts";
import { Engine, ROOT_CALLER, type EngineDeps } from "./engine.ts";
import { builtInDefinitions } from "./definitions/builtins.ts";
import { sessionGuidance, type PolicyInput } from "./policy/text.ts";
import { installListingBridge } from "./listing.ts";
import { installSpawnApi } from "./spawn-api.ts";
import { registerWorkflowTool } from "./workflow-tool.ts";
import type { AgentDefinition } from "./types.ts";
import { registerCompatAliases, registerEngineTools } from "./tools.ts";
import { registerTaskTools } from "./tasks/tools.ts";
import { taskHooks } from "./hook-integration.ts";

export interface SubagentEngineOptions extends Partial<EngineDeps> {
	autonomy?: "positive" | "explicit";
	/** A Herdr pane backend will be attached (engine.attachHerdr); exposes pane parameters on Agent. */
	panes?: boolean;
	/** Called with the engine once created (integrations, tests). */
	onEngine?: (engine: Engine) => void;
}

export { inChildContext } from "./child-context.ts";
export { Engine } from "./engine.ts";

// ---- Live-session broker (plan §17.11) ----
// Extensions reload with a fresh module cache, so the broker lives on globalThis under a versioned key. A runtime that
// does not adopt a parked engine within the grace period shuts it down, so children never leak.

const BROKER_KEY = Symbol.for("subagent-engine.broker.v1");
const ADOPTION_GRACE_MS = 30_000;

interface BrokerEntry {
	engine: Engine;
	timer: ReturnType<typeof setTimeout>;
}

function broker(): Map<string, BrokerEntry> {
	const host = globalThis as Record<symbol, unknown>;
	host[BROKER_KEY] ??= new Map<string, BrokerEntry>();
	return host[BROKER_KEY] as Map<string, BrokerEntry>;
}

function parkInBroker(sessionId: string, engine: Engine): void {
	const entries = broker();
	const previous = entries.get(sessionId);
	if (previous && previous.engine !== engine) {
		clearTimeout(previous.timer);
		void previous.engine.shutdownRoot("quit");
	}
	const timer = setTimeout(() => {
		if (entries.get(sessionId)?.engine !== engine) return;
		entries.delete(sessionId);
		void engine.shutdownRoot("quit");
	}, ADOPTION_GRACE_MS);
	timer.unref?.();
	entries.set(sessionId, { engine, timer });
}

function adoptFromBroker(sessionId: string): Engine | undefined {
	const entries = broker();
	const entry = entries.get(sessionId);
	if (!entry) return undefined;
	entries.delete(sessionId);
	clearTimeout(entry.timer);
	return entry.engine;
}

export function createSubagentEngine(options: SubagentEngineOptions = {}) {
	return async (pi: ExtensionAPI): Promise<void> => {
		if (inChildContext()) return;
		const env = options.env ?? process.env;
		const agentDir = options.agentDir ?? getAgentDir();
		const offer = (definitions: AgentDefinition[]): PolicyInput["offered"] =>
			definitions.map((definition) => ({ agentType: definition.agentType, description: definition.description, tools: definition.tools }));
		// Built-ins always exist, so the description registered before session start already reflects real routing.
		let offered = offer(builtInDefinitions({ forkEnabled: env.PI_SUBAGENT_FORK === "1" || env.PI_SUBAGENT_FORK === "true" }));
		const policy = (): PolicyInput => ({
			autonomy: options.autonomy ?? (env.PI_SUBAGENT_AUTONOMY === "explicit" ? "explicit" : "positive"),
			forkEnabled: engine.forkEnabled(),
			offered,
			exploreAvailable: offered.some((agent) => agent.agentType === "Explore"),
		});
		const create = (): Engine => {
			const created = new Engine({
				env, agentDir, homeDir: options.homeDir ?? homedir(), now: options.now, onSessionCreated: options.onSessionCreated,
				modelRuntime: options.modelRuntime ?? (() => ModelRuntime.create({
					authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"),
				})),
				childInstaller: options.childInstaller ?? childInstaller(policy),
				taskHooks: options.taskHooks ?? ((owner) => taskHooks(owner.hookEnvironment(), () => owner.rootHookContext())),
			});
			options.onEngine?.(created);
			return created;
		};
		let engine = create();
		registerEngineTools(pi, () => engine, ROOT_CALLER, { policy, panes: options.panes });
		if (env.PI_SUBAGENT_ALIASES !== "0") registerCompatAliases(pi, () => engine, ROOT_CALLER);
		if (env.PI_SUBAGENT_TASKS !== "0") registerTaskTools(pi, { store: () => engine.taskStore(), caller: {} });
		if (env.PI_SUBAGENT_WORKFLOW !== "0") registerWorkflowTool(pi, () => engine.workflows());

		const refreshOffered = async (): Promise<PolicyInput["offered"]> => {
			try {
				const skills = engine.modelSkills().map((skill) => ({ agentType: `skill:${skill.name}`, description: skill.description, tools: skill.allowedTools }));
				offered = [...offer((await engine.definitions()).list), ...skills];
			} catch {}
			return offered;
		};

		pi.on("session_start", async (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			// Reload handover: adopt the engine (and its live children) the previous runtime parked in the broker.
			const adopted = adoptFromBroker(sessionId);
			if (adopted) {
				engine = adopted;
				adopted.rebindRuntime({
					childInstaller: options.childInstaller ?? childInstaller(policy),
					taskHooks: options.taskHooks ?? ((owner) => taskHooks(owner.hookEnvironment(), () => owner.rootHookContext())),
				});
				// Integrations (activity panel) must follow the adopted engine, not the fresh one this runtime created.
				options.onEngine?.(adopted);
			}
			else if (engine.sessionId && engine.sessionId !== sessionId) engine = create();
			await engine.bindRoot(pi, ctx);
			await refreshOffered();
			void event;
		});
		pi.on("session_shutdown", async (event) => {
			if (event.reason === "reload" && engine.sessionId) {
				engine.detachRoot();
				parkInBroker(engine.sessionId, engine);
				return;
			}
			await engine.shutdownRoot(event.reason);
		});
		pi.on("before_agent_start", async (event) => {
			await refreshOffered();
			const guidance = sessionGuidance(policy());
			return guidance ? { systemPrompt: `${event.systemPrompt}\n\n${guidance}` } : undefined;
		});
		installListingBridge(pi, refreshOffered);
		// The user runs a context:fork skill as an agent with /skill:<name> [arguments] (plan §16.9). Only genuine user input
		// counts; prompts from extensions or the engine never reach this route.
		pi.on("input", async (event, ctx) => {
			if (event.source !== "interactive") return { action: "continue" as const };
			const match = /^\/skill:([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(event.text.trim());
			if (!match) return { action: "continue" as const };
			const known = engine.userForkSkill(match[1]);
			if (!known) return { action: "continue" as const };
			const result = await engine.spawn({ description: `Skill ${match[1]}`, prompt: match[2] ?? "", subagent_type: `skill:${match[1]}`, run_in_background: true },
				ROOT_CALLER, { toolCallId: `user-skill-${Date.now()}`, ctx, origin: "user" });
			if (ctx.hasUI) ctx.ui.notify(result.isError ? result.text : `Started skill agent: ${match[1]}`, result.isError ? "error" : "info");
			return { action: "handled" as const };
		});
		installSpawnApi(pi, () => engine);
		pi.on("ui_prompt_start", () => engine.notePrompt(true));
		pi.on("ui_prompt_end", () => engine.notePrompt(false));
		pi.on("message_end", (event) => {
			const message = event.message as { role?: string; usage?: { output?: number } };
			if (message.role === "assistant") engine.noteRootOutputTokens(message.usage?.output ?? 0);
			engine.observeReceipts();
		});
		pi.on("turn_end", () => engine.observeReceipts());
		pi.on("agent_settled", () => engine.observeReceipts());
	};
}
