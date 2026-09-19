import { formatToolCall, formatToolResult, textComponent, type ToolArgs, type ToolResult, type ToolResultOptions } from "./diamond.ts";

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

export type OriginalTool = {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	prepareArguments?: (args: unknown) => unknown;
	constrainedSampling?: unknown;
	executionMode?: unknown;
	execute: (...args: any[]) => unknown;
};

export type DiamondTool = OriginalTool & {
	renderShell: "self";
	renderCall: (args: ToolArgs, theme: ThemeLike, context?: unknown) => ReturnType<typeof textComponent>;
	renderResult: (
		result: ToolResult,
		options: ToolResultOptions,
		theme: ThemeLike,
		context?: unknown,
	) => ReturnType<typeof textComponent>;
};

export type ToolFactory = (cwd: string) => OriginalTool;

export type ToolFactoryMap = Record<BuiltinToolName, ToolFactory>;

function paint(theme: ThemeLike | undefined, token: string, text: string): string {
	return theme?.fg ? theme.fg(token, text) : text;
}

export function wrapWithDiamondRenderer(original: OriginalTool): DiamondTool {
	const execute = original.execute.bind(original);
	return {
		name: original.name,
		label: original.label ?? original.name,
		description: original.description,
		parameters: original.parameters,
		promptSnippet: original.promptSnippet,
		promptGuidelines: original.promptGuidelines,
		prepareArguments: original.prepareArguments,
		constrainedSampling: original.constrainedSampling,
		executionMode: original.executionMode,
		renderShell: "self",
		execute: (...args: any[]) => execute(...args),
		renderCall(args, theme) {
			return textComponent(paint(theme, "toolTitle", formatToolCall(original.name, args)));
		},
		renderResult(result, options, theme) {
			const { text } = formatToolResult(result, options);
			const token = options.isError ? "error" : "dim";
			return textComponent(paint(theme, token, text));
		},
	};
}

export function createDiamondTools(cwd: string, factories: ToolFactoryMap): DiamondTool[] {
	return BUILTIN_TOOL_NAMES.map((name) => wrapWithDiamondRenderer(factories[name](cwd)));
}
