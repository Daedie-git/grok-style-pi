import {
	emptyComponent,
	commandSummary,
	agentSummary,
	compactArgs,
	toolVerb,
	formatToolResult,
	extractResultText,
	extractResultDiff,
	sanitizeToolText,
	textComponent,
	type ToolArgs,
	type ToolResult,
	type ToolResultOptions,
	type ToolRenderContext,
} from "./diamond.ts";
import type { ToolsOptions, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { openInCursor, type OpenTarget } from "./open-in-cursor.ts";
import { countLines, withWriteSummary, writeSummary } from "./write-summary.ts";

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
	fg?: (token: ThemeColor, text: string) => string;
	inverse?: (text: string) => string;
};

function editDisplay(context: ToolRenderContext | undefined, expanded: boolean) {
	const state = context?.state;
	if (!state) return { open: true, expanded };
	state.grokEdit ??= { open: true, expanded };
	if (state.grokEdit.expanded !== expanded) {
		state.grokEdit.expanded = expanded;
		state.grokEdit.open = expanded;
	}
	return state.grokEdit;
}

/** Invert the changed portion of a replacement, preserving its red/green line color. */
function emphasizeReplacement(oldLine: string, newLine: string, theme: ThemeLike): [string, string] {
	if (!theme.inverse) return [oldLine, newLine];
	const parse = (line: string) => /^([+-]\s*\d* )(.*)$/.exec(line);
	const old = parse(oldLine), next = parse(newLine);
	if (!old || !next) return [oldLine, newLine];
	const a = Array.from(old[2]), b = Array.from(next[2]);
	let start = 0, end = 0;
	while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
	while (end < Math.min(a.length, b.length) - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
	const mark = (prefix: string, chars: string[]) => prefix + chars.slice(0, start).join("") +
		(start < chars.length - end ? theme.inverse!(chars.slice(start, chars.length - end).join("")) : "") +
		(end ? chars.slice(-end).join("") : "");
	return [mark(old[1], a), mark(next[1], b)];
}

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

export type DiamondHooks = {
	onModifierOpen?: (target: OpenTarget) => void;
};

export type ToolFactory<N extends BuiltinToolName = BuiltinToolName> = (cwd: string, options?: ToolsOptions[N]) => OriginalTool;

export type ToolFactoryMap = { [N in BuiltinToolName]: ToolFactory<N> };

function paint(theme: ThemeLike | undefined, token: ThemeColor, text: string): string {
	return theme?.fg ? theme.fg(token, text) : text;
}

function callComponent(
	label: string | (() => string),
	onRowClick?: (event: TuiMouseEvent) => { handled: true } | undefined,
) {
	return {
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			return onRowClick?.(event);
		},
		render(width: number) { return width > 0 ? [truncateToWidth(typeof label === "function" ? label() : label, width)] : []; },
	};
}

function defaultModifierOpen(target: OpenTarget): void {
	// Standalone renderers have no notification UI. Never leak a launcher rejection.
	void openInCursor(target).catch(() => {});
}

function ctrlOpen(
	event: TuiMouseEvent,
	args: ToolArgs,
	line: number,
	cwd: string | undefined,
	onModifierOpen: (target: OpenTarget) => void,
): { handled: true } | undefined {
	if (event.type !== "click" || event.button !== "left" || !event.ctrl) return undefined;
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (path) onModifierOpen({ path, line: Math.max(1, line), cwd: cwd ?? process.cwd() });
	return { handled: true };
}

function changedLine(details: unknown): number {
	const line = (details as { firstChangedLine?: unknown } | undefined)?.firstChangedLine;
	return typeof line === "number" && line > 0 ? line : 1;
}

export function wrapWithDiamondRenderer(original: OriginalTool, hooks?: DiamondHooks): DiamondTool {
	const onModifierOpen = hooks?.onModifierOpen ?? defaultModifierOpen;
	const execute = original.execute.bind(original);
	const shell = ["bash", "powershell"].includes(original.name);
	const edit = original.name === "edit";
	const write = original.name === "write";
	const fileRow = original.name === "read" || edit || write;
	const schema = original.parameters as Record<string, any>;
	const parameters = (shell || write) && schema?.type === "object" ? {
		...original.parameters, properties: { ...schema.properties, description: {
			type: "string", maxLength: 160, description: write ? "Short human-readable description of this file's purpose, e.g. Fury control protocol helpers." : "Short human-readable summary of the command's purpose, e.g. Run unit tests. Do not repeat shell syntax.",
		} },
	} : original.parameters;
	return {
		name: original.name,
		label: original.label ?? original.name,
		description: original.description,
		parameters,
		promptSnippet: original.promptSnippet,
		promptGuidelines: shell || write ? [...original.promptGuidelines ?? [], write ? "Include a concise description of the file’s purpose for the write summary." : "Include a concise description of the command’s purpose for the activity display."] : original.promptGuidelines,
		prepareArguments: original.prepareArguments,
		constrainedSampling: original.constrainedSampling,
		executionMode: original.executionMode,
		renderShell: "self",
		execute: (...args: Parameters<typeof original.execute>) => execute(...args),
		renderCall(args, theme, context) {
			const failed = context?.isError;
			if (write) {
				const path = compactArgs(args, Infinity);
				const purpose = typeof args?.description === "string" ? sanitizeToolText(args.description).replace(/\s+/g, " ").trim().slice(0, 160) : "";
				const lines = typeof args?.content === "string" ? countLines(args.content) : undefined;
				return callComponent(() => {
					const summary = context?.state?.grokWrite;
					const verb = failed ? "Failed to write" : summary?.kind === "created" ? "Created" : summary?.kind === "replaced" ? "Replaced" : summary ? "Wrote" : "Write";
					const count = summary?.lines ?? lines;
					return paint(theme, failed ? "error" : "toolTitle", `◆ ${verb}`) + " " + paint(theme, failed ? "error" : "text", path) +
						paint(theme, "muted", `${count === undefined ? "" : ` · ${count} ${count === 1 ? "line" : "lines"}`}${purpose ? ` · ${purpose}` : ""}`);
				}, (event) => {
					const opened = ctrlOpen(event, args, 1, context?.cwd, onModifierOpen);
					if (opened) return opened;
					if (context?.state?.grokWrite?.kind !== "created" || !context.invalidate || event.type !== "click" || event.button !== "left") return undefined;
					const display = editDisplay(context, context.expanded ?? false);
					display.open = !display.open;
					context.invalidate();
					return { handled: true };
				});
			}
			const title = `◆ ${failed ? "Failed: " : ""}${shell ? commandSummary(args) : original.name === "Agent" ? agentSummary(args) : toolVerb(original.name)}`;
			const target = shell || original.name === "Agent" ? "" : compactArgs(args, Infinity);
			const label = paint(theme, failed ? "error" : "toolTitle", title) +
				(target ? " " + paint(theme, failed ? "error" : "text", target) : "");
			const display = edit && context?.state && context.invalidate ? editDisplay(context, context.expanded ?? false) : undefined;
			return callComponent(() => label + (shell && failed && context?.state?.grokExitCode !== undefined ? paint(theme, "error", ` · exit ${context.state.grokExitCode}`) : ""), (event) => {
				if (fileRow) {
					// Pi calls renderCall before renderResult populates the shared change line.
					const line = original.name === "read" && typeof args?.offset === "number" ? args.offset : context?.state?.grokEdit?.line ?? 1;
					const opened = ctrlOpen(event, args, line, context?.cwd, onModifierOpen);
					if (opened) return opened;
				}
				if (!display || event.type !== "click" || event.button !== "left") return undefined;
				display.open = !display.open;
				context?.invalidate?.();
				return { handled: true };
			});
		},
		renderResult(result, options, theme, context) {
			if (shell && context?.state) {
				const exitCode = context.isError && !options.isPartial ? /(?:^|\n)Command exited with code (-?\d+)\s*$/.exec(sanitizeToolText(extractResultText(result)))?.[1] : undefined;
				if (exitCode !== undefined) context.state.grokExitCode = exitCode;
				else delete context.state.grokExitCode;
			}
			let summary = write && !context?.isError && !options.isPartial ? writeSummary(result.details) : undefined;
			if (!summary && write && !context?.isError && !options.isPartial && typeof context?.args?.content === "string") {
				const content = context.args.content;
				summary = { kind: "unknown", lines: countLines(content), preview: content.slice(0, 16_000),
					note: "Previous contents were not recorded; showing written contents" + (content.length > 16_000 ? " (truncated)." : ".") };
			}
			if (summary && context?.state) context.state.grokWrite = summary;
			const line = edit ? changedLine(result.details) : original.name === "read" && typeof context?.args?.offset === "number" ? context.args.offset : 1;
			if (edit && context?.state) editDisplay(context, options.expanded).line = line;
			const defaultOpen = edit || summary?.kind === "created";
			const open = defaultOpen ? editDisplay(context, options.expanded).open : options.expanded;
			if (options.isPartial || !open) return emptyComponent();
			const diff = sanitizeToolText(extractResultDiff(result));
			let { text } = formatToolResult({ ...result, details: undefined }, { ...options, expanded: true });
			if (shell && typeof context?.args?.command === "string") {
				// Pi inserts this placeholder when a command emits no stdout/stderr.
				if (/^\(no output\)(?:\n\nCommand exited with code -?\d+)?\s*$/.test(text)) text = text.replace(/^\(no output\)\s*/, "");
				text = [`$ ${sanitizeToolText(context.args.command)}`, text].filter(Boolean).join("\n\n");
			}
			if (summary) text = sanitizeToolText([summary.note, summary.preview].filter(Boolean).join("\n\n"));
			const token = context?.isError ? "error" : "toolOutput";
			const diffLines = diff.split("\n");
			for (let i = 0; i + 1 < diffLines.length; i++) {
				if (/^-\s*\d+ /.test(diffLines[i]) && /^\+\s*\d+ /.test(diffLines[i + 1])) {
					[diffLines[i], diffLines[i + 1]] = emphasizeReplacement(diffLines[i], diffLines[i + 1], theme);
					i++;
				}
			}
			const coloredDiff = diff ? diffLines.map((line) => {
				const diffToken = line.startsWith("+++") || line.startsWith("---") ? "toolDiffContext" :
					line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext";
				return paint(theme, diffToken, line);
			}).join("\n") : "";
			const createdContents = summary?.kind === "created" ? [
				summary.note ? paint(theme, "muted", sanitizeToolText(summary.note)) : "",
				summary.preview ? sanitizeToolText(summary.preview).replace(/\n$/, "").split("\n")
					.map((line, index) => paint(theme, "toolDiffAdded", `+${index + 1} ${line}`)).join("\n") : "",
			].filter(Boolean).join("\n\n") : undefined;
			const rendered = createdContents ?? [text ? paint(theme, token, text) : "", coloredDiff].filter(Boolean).join("\n\n");
			if (!rendered && !context?.isError) return emptyComponent();
			const body = textComponent(rendered || paint(theme, "error", "error"));
			return {
				invalidate() { body.invalidate(); },
				handleMouse(event: TuiMouseEvent) {
					const opened = fileRow ? ctrlOpen(event, context?.args, line, context?.cwd, onModifierOpen) : undefined;
					if (opened) return opened;
					if (!defaultOpen || !context?.state || !context.invalidate || event.type !== "click" || event.button !== "left") return undefined;
					const display = editDisplay(context, options.expanded);
					display.open = !display.open;
					context.invalidate();
					return { handled: true };
				},
				render(width: number) {
					const indent = width > 2 ? "  " : "";
					return body.render(width - indent.length).map((line) => indent + line);
				},
			};
		},
	};
}

export function createDiamondTools(cwd: string, factories: ToolFactoryMap, options: ToolsOptions = {}, hooks?: DiamondHooks): DiamondTool[] {
	return BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => wrapWithDiamondRenderer(
		name === "write" ? withWriteSummary(factories.write, cwd, options.write) : factories[name](cwd, options[name]), hooks,
	));
}
