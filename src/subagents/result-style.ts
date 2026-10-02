import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { wrapWithDiamondRenderer } from "../tools/renderer.ts";
import { registerToolExtension, type ToolTransform } from "../tools/register-extension.ts";

const EXPLICIT_SUBAGENT_REQUEST = "Do not call this tool unless the user explicitly asked you to use a subagent, agent, or workflow. Do not launch one on your own for exploration, research, parallelism, or context management.";

type InitiativeTool = {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
};

/** Drop the system-prompt invitation to spawn agents. The tool stays callable when the user asks. */
export function withoutSubagentInitiative<T extends InitiativeTool>(tool: T): T {
	if (tool.name !== "Agent" && tool.name !== "SubagentWorkflow") return tool;
	const { promptSnippet: _snippet, promptGuidelines: _guidelines, description, ...rest } = tool;
	const body = (description ?? "")
		.replace(/^- If an agent's description says it should be used proactively.*\n?/m, "")
		.trim();
	return { ...rest, description: body ? `${EXPLICIT_SUBAGENT_REQUEST}\n\n${body}` : EXPLICIT_SUBAGENT_REQUEST } as T;
}

/** Decorate registration, preserving the owning extension's execution and metadata. */
export async function registerStyledSubagents(pi: ExtensionAPI, factory: ExtensionFactory, enabled: boolean, styleTool: ToolTransform = wrapWithDiamondRenderer) {
	await registerToolExtension(pi, factory, (tool) => {
		const gated = withoutSubagentInitiative(tool);
		return enabled && ["Agent", "get_subagent_result"].includes(gated.name) ? styleTool(gated) : gated;
	});
}
