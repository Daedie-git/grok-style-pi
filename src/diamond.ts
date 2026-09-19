export const DIAMOND = "◆";

export const TOOL_SUMMARY_VERBS: Record<string, string> = {
	read: "Read",
	bash: "Ran",
	powershell: "Ran",
	edit: "Edited",
	write: "Wrote",
	grep: "Searched",
	find: "Found",
	ls: "Listed",
};

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

export function toolVerb(name: string): string {
	return TOOL_SUMMARY_VERBS[name] ?? name;
}

export function formatToolCall(name: string, args?: ToolArgs): string {
	const inner = compactArgs(args);
	const verb = toolVerb(name);
	return inner ? `${DIAMOND} ${verb} ${inner}` : `${DIAMOND} ${verb}`;
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
	if (options.isPartial || !options.expanded) {
		return { text: "", collapsed: true };
	}
	const full = extractResultText(result);
	return { text: full || (options.isError ? "error" : ""), collapsed: false };
}

export function textComponent(text: string): { render: (width: number) => string[]; invalidate: () => void } {
	return {
		render(_width: number) {
			return text.length > 0 ? text.split("\n") : [];
		},
		invalidate() {},
	};
}

export function emptyComponent(): { render: (width: number) => string[]; invalidate: () => void } {
	return {
		render() {
			return [];
		},
		invalidate() {},
	};
}
