import { textTail } from "../utils/text-tail.ts";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WriteSummary } from "./write-summary.ts";

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
	get_subagent_result: "Read agent result",
};

export type ToolArgs = Record<string, unknown> | undefined | null;

export type ToolContentBlock = { type?: string; text?: string; data?: string; mimeType?: string };

export type ToolResult = {
	content?: ToolContentBlock[];
	details?: unknown;
};

export type ToolResultOptions = {
	expanded: boolean;
	isPartial?: boolean;
};

export type ToolRenderContext = {
	isError?: boolean;
	args?: ToolArgs;
	expanded?: boolean;
	cwd?: string;
	state?: { grokEdit?: { open: boolean; expanded: boolean; line?: number }; grokTool?: { open: boolean; expanded: boolean }; grokWrite?: WriteSummary; grokExitCode?: string };
	invalidate?: () => void;
};

const PRIMARY_ARG_KEYS = ["command", "path", "pattern", "agent_id"] as const;

/** Sanitize untrusted content before adding our own theme escape sequences. */
export function sanitizeToolText(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

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
	const collapsed = sanitizeToolText(primary).replace(/\s+/g, " ");
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function toolVerb(name: string): string {
	return TOOL_SUMMARY_VERBS[name] ?? name;
}

export function commandSummary(args: ToolArgs): string {
	const description = typeof args?.description === "string" ? sanitizeToolText(args.description).replace(/\s+/g, " ").trim() : "";
	if (description) return description.slice(0, 160);
	const command = typeof args?.command === "string" ? args.command.trim() : "";
	// Conservative fallbacks for older calls without a model-provided summary.
	if (/[;&|\n]/.test(command)) return "Run shell commands";
	if (/^(?:npm|pnpm|yarn|bun) (?:run )?test\b|^pytest\b|^cargo test\b|^go test\b/.test(command)) return "Run tests";
	if (/^(?:npm|pnpm|yarn|bun) (?:run )?build\b|^cargo build\b|^make\b/.test(command)) return "Build project";
	if (/^git status\b/.test(command)) return "Check working tree";
	if (/^git diff\b/.test(command)) return "Review changes";
	if (/^(?:rg|grep|Select-String)\b/.test(command)) return "Search files";
	if (/^(?:ls|find|Get-ChildItem)\b/.test(command)) return "List files";
	if (/^(?:curl|wget)\b/.test(command)) return "Fetch remote content";
	return "Run shell command";
}

export function agentSummary(args: ToolArgs): string {
	const clean = (value: unknown) => typeof value === "string" ? sanitizeToolText(value).replace(/\s+/g, " ").trim().slice(0, 160) : "";
	const type = clean(args?.subagent_type) || "Agent";
	const description = clean(args?.description);
	return description ? `${type}: ${description}` : type;
}

export function formatToolCall(name: string, args?: ToolArgs): string {
	if (name === "Agent") return `${DIAMOND} ${agentSummary(args)}`;
	if (["bash", "powershell"].includes(name)) return `${DIAMOND} ${commandSummary(args)}`;
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

/** Bounded projection for activity; the original result remains untouched. */
export function extractResultTail(result: ToolResult | undefined): string {
	return textTail((function* () {
		const blocks = result?.content ?? [];
		for (let index = blocks.length - 1; index >= 0; index--) {
			if (typeof blocks[index]?.text === "string") yield blocks[index].text!;
		}
	})());
}

export function extractResultDiff(result: ToolResult | undefined): string {
	const details = result?.details as { diff?: unknown; patch?: unknown } | undefined;
	return typeof details?.diff === "string" ? details.diff :
		typeof details?.patch === "string" ? details.patch : "";
}

export function formatToolResult(
	result: ToolResult | undefined,
	options: ToolResultOptions,
	context: ToolRenderContext = {},
): { text: string; collapsed: boolean } {
	if (options.isPartial || !options.expanded) {
		return { text: "", collapsed: true };
	}
	const full = extractResultText(result);
	const diff = extractResultDiff(result);
	return { text: sanitizeToolText([full, diff].filter(Boolean).join("\n\n")) || (context.isError ? "error" : ""), collapsed: false };
}

export function textComponent(text: string, singleLine = false): { render: (width: number) => string[]; invalidate: () => void } {
	const normalized = text.replace(/\t/g, "   ");
	let cachedWidth: number | undefined;
	let cachedLines: string[] = [];
	return {
		render(width: number) {
			if (!text || width <= 0) return [];
			if (width === cachedWidth) return cachedLines;
			cachedWidth = width;
			cachedLines = singleLine
				? [truncateToWidth(normalized, width)]
				: wrapTextWithAnsi(normalized, width).map((line) => truncateToWidth(line, width, ""));
			return cachedLines;
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
