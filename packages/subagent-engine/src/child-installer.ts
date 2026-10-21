// Installed into each child session instead of the root engine (plan §0): the engine's tools bound to the child's identity,
// plus enforcement that keeps nested tool calls inside the child's active tool surface.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Caller, Engine } from "./engine.ts";
import { registerCompatAliases, registerEngineTools } from "./tools.ts";
import { registerTaskTools } from "./tasks/tools.ts";
import { installStopHooks } from "./hook-integration.ts";
import { sessionGuidance, type PolicyInput } from "./policy/text.ts";
import { installListingBridge } from "./listing.ts";

export function childInstaller(policy: () => PolicyInput) {
	return (engine: Engine, caller: Caller) => (pi: ExtensionAPI) => {
		registerEngineTools(pi, engine, caller, { policy });
		registerCompatAliases(pi, engine, caller);
		registerTaskTools(pi, { store: () => engine.taskStore(), caller: { agentId: caller.agentId } });
		// Late registrations or loadout changes never widen the compiled policy (plan §2.3).
		pi.on("turn_end", () => {
			if (!caller.allowedTools) return undefined;
			const active = pi.getActiveTools();
			const narrowed = active.filter((name) => caller.allowedTools!.has(name));
			if (narrowed.length !== active.length) pi.setActiveTools(narrowed);
			return undefined;
		});
		// Children that may delegate get the same guidance and listing, narrowed to the types they may launch.
		const offered = async () => {
			if (!caller.allowedTools?.has("Agent")) return [];
			const list = (await engine.definitions()).list
				.filter((definition) => !caller.allowedAgentTypes || caller.allowedAgentTypes.includes(definition.agentType));
			return list.map((definition) => ({ agentType: definition.agentType, description: definition.description, tools: definition.tools }));
		};
		pi.on("before_agent_start", async (event) => {
			if (!caller.allowedTools?.has("Agent")) return undefined;
			const guidance = sessionGuidance({ ...policy(), offered: await offered() });
			return guidance ? { systemPrompt: `${event.systemPrompt}\n\n${guidance}` } : undefined;
		});
		installListingBridge(pi, offered);
		const agentId = caller.agentId!;
		installStopHooks(pi, engine.hookEnvironment(), {
			meta: () => engine.control.get(agentId)?.meta,
			currentRunId: () => engine.control.get(agentId)?.active?.runId,
			turnAllowed: () => engine.turnAllowed(agentId),
			prevent: () => engine.preventContinuation(agentId),
			markAttempted: (runId) => engine.noteStopHookAttempted(runId),
			runSignal: (runId) => engine.runSignal(runId),
			diagnostics: (messages) => engine.reportDiagnostics(agentId, messages),
		});
		pi.on("tool_call", async (event) => {
			if (caller.allowedTools && !caller.allowedTools.has(event.toolName)) {
				return { block: true, reason: "This agent is not allowed to use that tool." };
			}
			const revoked = await engine.toolRevocation(caller.agentId!, event.toolName);
			if (revoked) return { block: true, reason: revoked };
			if (caller.memoryScoped?.includes(event.toolName) && caller.memoryGuard) {
				const reason = caller.memoryGuard(event.toolName, event.input as Record<string, unknown>);
				if (reason) return { block: true, reason };
			}
			return undefined;
		});
	};
}
