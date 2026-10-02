import type { OriginalTool } from "./renderer.ts";

/** Model-facing description arguments are separate from rendering decoration. */
export function withToolDescriptions<T extends OriginalTool>(tool: T): T {
	const shell = tool.name === "bash" || tool.name === "powershell";
	const write = tool.name === "write";
	if (!shell && !write) return tool;
	const schema = tool.parameters as Record<string, any>;
	const parameters = schema?.type === "object" ? {
		...tool.parameters, properties: { ...schema.properties, description: {
			type: "string", maxLength: 160, description: write ? "Short human-readable description of this file's purpose, e.g. Fury control protocol helpers." : "Short human-readable summary of the command's purpose, e.g. Run unit tests. Do not repeat shell syntax.",
		} },
	} : tool.parameters;
	return { ...tool, parameters, promptGuidelines: [...tool.promptGuidelines ?? [], write ? "Include a concise description of the file’s purpose for the write summary." : "Include a concise description of the command’s purpose for the activity display."] };
}
