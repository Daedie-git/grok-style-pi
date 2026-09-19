import {
	emptyComponent,
	commandSummary,
	compactArgs,
	toolVerb,
	formatToolResult,
	textComponent,
	type ToolArgs,
	type ToolResult,
	type ToolResultOptions,
	type ToolRenderContext,
} from "./diamond.ts";
import type { ToolsOptions } from "@earendil-works/pi-coding-agent";

export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export type ThemeLike = {
	fg?: (token: string, text: string) => string;
};

export type OriginalTool = Pick<import("@earendil-works/pi-coding-agent").ToolDefinition, "name" | "description" | "parameters" | "execute"> &
	Partial<Pick<import("@earendil-works/pi-coding-agent").ToolDefinition, "label" | "promptSnippet" | "promptGuidelines" | "prepareArguments" | "constrainedSampling" | "executionMode">>;

export type DiamondTool = OriginalTool & {
	renderShell: "self";
	renderCall: (args: ToolArgs, theme: ThemeLike, context?: ToolRenderContext) => ReturnType<typeof textComponent>;
	renderResult: (
		result: ToolResult,
		options: ToolResultOptions,
		theme: ThemeLike,
		context?: ToolRenderContext,
	) => ReturnType<typeof textComponent>;
};

export type ToolFactory<N extends BuiltinToolName = BuiltinToolName> = (cwd: string, options?: ToolsOptions[N]) => OriginalTool;

export type ToolFactoryMap = { [N in BuiltinToolName]: ToolFactory<N> };

function paint(theme: ThemeLike | undefined, token: string, text: string): string {
	return theme?.fg ? theme.fg(token, text) : text;
}

export function wrapWithDiamondRenderer(original: OriginalTool): DiamondTool {
	const execute = original.execute.bind(original);
	const shell = ["bash", "powershell"].includes(original.name);
	const schema = original.parameters as Record<string, any>;
	const parameters = shell && schema?.type === "object" ? {
		...original.parameters, properties: { ...schema.properties, description: {
			type: "string", maxLength: 160, description: "Short human-readable summary of the command's purpose, e.g. Run unit tests. Do not repeat shell syntax.",
		} },
	} : original.parameters;
	return {
		name: original.name,
		label: original.label ?? original.name,
		description: original.description,
		parameters,
		promptSnippet: original.promptSnippet,
		promptGuidelines: shell ? [...original.promptGuidelines ?? [], "Include a concise description of the command’s purpose for the activity display."] : original.promptGuidelines,
		prepareArguments: original.prepareArguments,
		constrainedSampling: original.constrainedSampling,
		executionMode: original.executionMode,
		renderShell: "self",
		execute: (...args: Parameters<typeof original.execute>) => execute(...args),
		renderCall(args, theme, context) {
			const failed = context?.isError;
			const title = `◆ ${failed ? "Failed: " : ""}${shell ? commandSummary(args) : toolVerb(original.name)}`;
			const target = shell ? "" : compactArgs(args, Infinity);
			return textComponent(
				paint(theme, failed ? "error" : "toolTitle", title) +
				(target ? " " + paint(theme, failed ? "error" : "text", target) : ""), true,
			);
		},
		renderResult(result, options, theme, context) {
			const { text } = formatToolResult(result, options, context);
			if (!text) return emptyComponent();
			const token = context?.isError ? "error" : "dim";
			const body = textComponent(paint(theme, token, text));
			return {
				invalidate() { body.invalidate(); },
				render(width: number) {
					const indent = width > 2 ? "  " : "";
					return body.render(width - indent.length).map((line) => indent + line);
				},
			};
		},
	};
}

export function createDiamondTools(cwd: string, factories: ToolFactoryMap, options: ToolsOptions = {}): DiamondTool[] {
	return BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => wrapWithDiamondRenderer(factories[name](cwd, options[name])));
}
