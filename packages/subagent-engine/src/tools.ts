// Tool definitions shared by the root conversation and every child installer. The caller decides whose identity a call carries.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentParams, Caller, Engine, ToolText } from "./engine.ts";
import { agentToolDescription, SEND_MESSAGE_DESCRIPTION, TASK_STOP_DESCRIPTION, type PolicyInput } from "./policy/text.ts";

export const ENGINE_TOOL_NAMES = ["Agent", "SendMessage", "TaskStop"] as const;

export interface ToolOptions {
	policy: () => PolicyInput;
	/** Expose Herdr pane parameters (only inside Herdr, where a pane backend is attached). */
	panes?: boolean;
}

/** `engine` is resolved per call: after a reload the root's tools route to the adopted engine (plan §17.11). */
export function registerEngineTools(pi: ExtensionAPI, engine: Engine | (() => Engine), caller: Caller, options: ToolOptions): void {
	const current = typeof engine === "function" ? engine : () => engine;
	pi.registerTool(defineTool({
		name: "Agent",
		label: "Agent",
		description: agentToolDescription(options.policy()),
		parameters: Type.Object({
			description: Type.String({ description: "A short (3-5 word) description of the task." }),
			prompt: Type.String({ description: "The task for the agent to perform." }),
			subagent_type: Type.Optional(Type.String({ description: "The type of specialized agent to use. Omit for general-purpose." })),
			model: Type.Optional(Type.String({ description: "Optional model override, such as sonnet or provider/model-id." })),
			effort: Type.Optional(Type.Union(["low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)), { description: "Reasoning effort. Set only when explicitly asked." })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Defaults to true. Set false only when your next step depends on the result." })),
			name: Type.Optional(Type.String({ description: "Optional name, so SendMessage can address this agent by name." })),
			isolation: Type.Optional(Type.Literal("worktree", { description: "Run in an isolated git worktree." })),
			...(options.panes ? {
				backend: Type.Optional(Type.Union([Type.Literal("in-process"), Type.Literal("pane")], { description: "Default in-process. Use pane only when the user asks for a visible Herdr pane." })),
				runtime: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude-code")], { description: "Use claude-code only when the user asks for Claude Code; runs in a pane." })),
				machine: Type.Optional(Type.String({ description: "A saved Herdr SSH machine to run on, only when the user asks; runs in a pane there." })),
				machine_cwd: Type.Optional(Type.String({ description: "Absolute working directory on that machine." })),
			} : {}),
		}),
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => toolResult(await current().spawn(params as AgentParams, caller, { toolCallId, signal, ctx })),
	}));

	pi.registerTool(defineTool({
		name: "SendMessage",
		label: "Send Message",
		description: SEND_MESSAGE_DESCRIPTION,
		parameters: Type.Object({
			to: Type.String({ description: "The agent's name or id, or \"main\" for the main conversation." }),
			message: Type.String({ description: "The message text." }),
			summary: Type.Optional(Type.String({ description: "A 5-10 word summary for display." })),
		}),
		execute: async (toolCallId, params) => {
			const receipt = await current().sendMessage(params, caller, toolCallId);
			return toolResult({ text: receipt.message, isError: !receipt.success, details: { ...receipt } });
		},
	}));

	pi.registerTool(defineTool({
		name: "TaskStop",
		label: "Stop Agent",
		description: TASK_STOP_DESCRIPTION,
		parameters: Type.Object({
			task_id: Type.Optional(Type.String({ description: "The agent id (or name) to stop." })),
			shell_id: Type.Optional(Type.String({ description: "Deprecated alias of task_id." })),
		}),
		execute: async (_toolCallId, params) => toolResult(await current().stop(params.task_id ?? params.shell_id ?? "", caller)),
	}));
}

/** Compatibility tools from the previous runners (Pi Subagents, herdr-subagents). New work should use SendMessage. */
export function registerCompatAliases(pi: ExtensionAPI, engine: Engine | (() => Engine), caller: Caller): void {
	const current = typeof engine === "function" ? engine : () => engine;
	pi.registerTool(defineTool({
		name: "get_subagent_result",
		label: "Get Agent Result",
		description: "Read an agent's latest (or a specific) run outcome. Completion notices arrive automatically; use this only to re-read a retained result. wait: true blocks until a running agent finishes.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent id or name." }),
			run_id: Type.Optional(Type.String({ description: "A specific run id. Omit for the latest run." })),
			wait: Type.Optional(Type.Boolean({ description: "Wait for a running agent to finish. Default false." })),
		}),
		execute: async (_toolCallId, params, signal) => toolResult(await current().readResult(params.agent_id, caller, { runId: params.run_id, wait: params.wait, signal })),
	}));
	pi.registerTool(defineTool({
		name: "steer_subagent",
		label: "Steer Agent",
		description: "Send a steering message to a running agent; it arrives after the agent's current tool round. Prefer SendMessage, which also resumes finished agents.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent id or name." }),
			message: Type.String({ description: "The steering message." }),
		}),
		execute: async (toolCallId, params) => {
			const engineNow = current();
			const resolved = engineNow.control.resolveTarget(caller.agentId ?? "main", params.agent_id);
			if ("agentId" in resolved && !engineNow.control.get(resolved.agentId)?.active) {
				throw new Error(`Agent ${resolved.agentId} is not running. Use SendMessage to continue it.`);
			}
			const receipt = await engineNow.sendMessage({ to: params.agent_id, message: params.message }, caller, toolCallId);
			return toolResult({ text: receipt.message, isError: !receipt.success, details: { ...receipt } });
		},
	}));
}

export function toolResult(result: ToolText) {
	// Errors are returned, not thrown, so a failed foreground run still attributes its usage (plan §17.13).
	if (result.isError && !result.usage) throw new Error(result.text);
	return {
		...(result.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: result.text }], details: result.details ?? {}, ...(result.usage ? { usage: result.usage } : {}) };
}
