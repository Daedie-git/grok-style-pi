export const DIAMOND = "◆";

export type ToolArgs = Record<string, unknown> | undefined | null;

export type ToolContentBlock = { type?: string; text?: string };

export type ToolResult = {
	content?: ToolContentBlock[];
	details?: unknown;
};

export type ToolResultOptions = {
	expanded: boolean;
	isPartial?: boolean;
	isError?: boolean;
};

const PRIMARY_ARG_KEYS = ["command", "path", "pattern"] as const;

export function compactArgs(args: ToolArgs, maxLength = 60): string {
	if (!args || typeof args !== "object") return "";
	let primary = "";
	for (const key of PRIMARY_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			primary = value.trim();
			break;
		}
	}
	if (typeof args.glob === "string" && args.glob.trim()) {
		primary = primary ? `${primary} ${args.glob.trim()}` : args.glob.trim();
	}
	const collapsed = primary.replace(/\s+/g, " ");
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatToolCall(name: string, args?: ToolArgs): string {
	const inner = compactArgs(args);
	return inner ? `${DIAMOND} ${name}(${inner})` : `${DIAMOND} ${name}`;
}

export function extractResultText(result: ToolResult | undefined): string {
	if (!result || !Array.isArray(result.content)) return "";
	return result.content
		.filter((block) => block && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

export function formatToolResult(
	result: ToolResult | undefined,
	options: ToolResultOptions,
): { text: string; collapsed: boolean } {
	if (options.isPartial) {
		return { text: "  running…", collapsed: true };
	}
	const full = extractResultText(result);
	if (!options.expanded) {
		const lines = full.length > 0 ? full.split("\n") : [options.isError ? "error" : "done"];
		const first = lines[0] ?? "";
		const preview = first.length > 72 ? `${first.slice(0, 71)}…` : first;
		const more = lines.length > 1 ? `  (${lines.length} lines)` : "";
		return { text: `  ${preview}${more}`, collapsed: true };
	}
	return { text: full || (options.isError ? "error" : ""), collapsed: false };
}

export function textComponent(text: string): { render: (width: number) => string[]; invalidate: () => void } {
	return {
		render(_width: number) {
			return text.length > 0 ? text.split("\n") : [""];
		},
		invalidate() {},
	};
}
