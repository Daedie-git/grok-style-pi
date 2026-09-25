import { layoutTool } from "../rendering/tool-layout.ts";
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
import { openInCursor, type OpenTarget } from "../navigation/open-in-cursor.ts";
import type { VisualPreparation } from "../rendering/visual-preparation.ts";
import { highlightLines, languageForPath } from "../rendering/highlight.ts";
import { buildDiffRows, createdRows, type DiffPalette, type RenderRow } from "../rendering/diff-render.ts";
import { hexToRgb, styleColors } from "../chrome/style-colors.ts";
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
	/** GrokNight code-block panel: `#1c1c1c`, mapped to customMessageBg. */
	bg?: (token: "customMessageBg", text: string) => string;
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

function toolDisplay(context: ToolRenderContext | undefined, expanded: boolean) {
	const state = context?.state;
	if (!state) return { open: expanded, expanded };
	state.grokTool ??= { open: expanded, expanded };
	if (state.grokTool.expanded !== expanded) {
		state.grokTool.expanded = expanded;
		state.grokTool.open = expanded;
	}
	return state.grokTool;
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
	preparation?: VisualPreparation;
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

/** An open diff closes only on Alt+click, so a normal click does not dismiss it. */
function togglesOpen(event: TuiMouseEvent, open: boolean, requireAltToClose = true): boolean {
	return event.type === "click" && event.button === "left" && !event.ctrl && (!open || !requireAltToClose || event.alt);
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

function pathArg(args: ToolArgs): string | undefined {
	return typeof args?.path === "string" ? args.path : undefined;
}

function activeDiffPalette(): DiffPalette {
	const colors = styleColors();
	return {
		insert: hexToRgb(colors.diffInsert),
		delete: hexToRgb(colors.diffDelete),
		insertChar: hexToRgb(colors.diffInsertChar),
		deleteChar: hexToRgb(colors.diffDeleteChar),
	};
}

const fallbackHighlight = () => undefined;

function splitReadNotice(text: string): { code: string; notice: string } {
	const match = /\n\n\[(?:Showing lines |\d+ more lines in file\.|Line \d+ is )[\s\S]*\]\s*$/.exec(text);
	if (!match || match.index === undefined) return { code: text, notice: "" };
	return { code: text.slice(0, match.index), notice: text.slice(match.index + 2) };
}

export function wrapWithDiamondRenderer(original: OriginalTool, hooks?: DiamondHooks): DiamondTool {
	const onModifierOpen = hooks?.onModifierOpen ?? defaultModifierOpen;
	const execute = original.execute.bind(original);
	const requests = new WeakMap<object, object>();
	const rendered = new WeakMap<object, { keys: unknown[]; component: ReturnType<typeof textComponent> }>();
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
	const wrapped: DiamondTool = {
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
					const created = summary?.kind === "created";
					const verb = failed ? "Failed to write" : created ? "Creating" : summary?.kind === "replaced" ? "Replaced" : summary ? "Wrote" : "Write";
					const count = summary?.lines ?? lines;
					const open = context?.state?.grokEdit?.open ?? true;
					const stat = created && !open && count !== undefined
						? paint(theme, "toolDiffAdded", ` +${count}`) + paint(theme, "muted", "/") + paint(theme, "toolDiffRemoved", "-0")
						: "";
					const detail = created ? stat : paint(theme, "muted", `${count === undefined ? "" : ` · ${count} ${count === 1 ? "line" : "lines"}`}${purpose ? ` · ${purpose}` : ""}`);
					return paint(theme, failed ? "error" : "toolTitle", `◆ ${verb}`) + " " + paint(theme, failed ? "error" : "text", path) + detail;
				}, (event) => {
					const opened = ctrlOpen(event, args, 1, context?.cwd, onModifierOpen);
					if (opened) return opened;
					if (!context?.state || !context.invalidate) return undefined;
					const created = context.state.grokWrite?.kind === "created";
					const display = created ? editDisplay(context, context.expanded ?? false) : toolDisplay(context, context.expanded ?? false);
					if (!togglesOpen(event, display.open, created)) return undefined;
					display.open = !display.open;
					context.invalidate();
					return { handled: true };
				});
			}
			const title = `◆ ${failed ? "Failed: " : ""}${shell ? commandSummary(args) : original.name === "Agent" ? agentSummary(args) : toolVerb(original.name)}`;
			const target = shell || original.name === "Agent" ? "" : compactArgs(args, Infinity);
			const label = paint(theme, failed ? "error" : "toolTitle", title) +
				(target ? " " + paint(theme, failed ? "error" : "text", target) : "");
			const display = context?.state && context.invalidate ? edit ? editDisplay(context, context.expanded ?? false) : toolDisplay(context, context.expanded ?? false) : undefined;
			return callComponent(() => label + (shell && failed && context?.state?.grokExitCode !== undefined ? paint(theme, "error", ` · exit ${context.state.grokExitCode}`) : ""), (event) => {
				if (fileRow) {
					// Pi calls renderCall before renderResult populates the shared change line.
					const line = original.name === "read" && typeof args?.offset === "number" ? args.offset : context?.state?.grokEdit?.line ?? 1;
					const opened = ctrlOpen(event, args, line, context?.cwd, onModifierOpen);
					if (opened) return opened;
				}
				if (!display || !togglesOpen(event, display.open, edit)) return undefined;
				display.open = !display.open;
				context?.invalidate?.();
				return { handled: true };
			});
		},
		renderResult(result, options, theme, context) {
			const owner = context?.state ?? context;
			const preparation = context?.invalidate ? hooks?.preparation : undefined;
			const ticket = {};
			if (owner) requests.set(owner, ticket);
			const notify = () => {
				if (!owner || requests.get(owner) !== ticket) return;
				rendered.delete(owner); context?.invalidate?.();
			};
			const highlightCode = (value: string, lang: string | undefined, filePath?: string) => {
				const ready = owner && preparation?.request({ kind: "highlight", text: value, lang, filePath, colors: styleColors() }, owner, notify);
				return ready?.lines ?? (value.length <= 8_000 ? highlightLines(value, lang, filePath, fallbackHighlight) : undefined);
			};
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
			const display = defaultOpen ? editDisplay(context, options.expanded) : toolDisplay(context, options.expanded);
			const open = display.open;
			if (options.isPartial || !open) return emptyComponent();
			const diff = sanitizeToolText(extractResultDiff(result));
			let { text } = formatToolResult({ ...result, details: undefined }, { ...options, expanded: true });
			const token = context?.isError ? "error" : "toolOutput";
			const lang = languageForPath(pathArg(context?.args));
			let paintedText: string | undefined;
			if (shell && typeof context?.args?.command === "string") {
				// Pi inserts this placeholder when a command emits no stdout/stderr.
				if (/^\(no output\)(?:\n\nCommand exited with code -?\d+)?\s*$/.test(text)) text = text.replace(/^\(no output\)\s*/, "");
				const command = sanitizeToolText(context.args.command);
				const commandLang = original.name === "powershell" ? "powershell" : "bash";
				const highlighted = context?.isError ? undefined : highlightCode(command, commandLang);
				const commandText = highlighted
					? highlighted.map((line, index) => (index === 0 ? paint(theme, token, "$ ") : "") + line).join("\n")
					: undefined;
				if (commandText) paintedText = [commandText, text ? paint(theme, token, text) : ""].filter(Boolean).join("\n\n");
				else text = [`$ ${command}`, text].filter(Boolean).join("\n\n");
			} else if (original.name === "read" && !context?.isError && text) {
				const { code, notice } = splitReadNotice(text);
				const highlighted = highlightCode(code, lang, pathArg(context?.args));
				if (highlighted) paintedText = [highlighted.join("\n"), notice ? paint(theme, "muted", notice) : ""].filter(Boolean).join("\n\n");
			}
			if (summary) {
				const note = summary.note ? paint(theme, "muted", sanitizeToolText(summary.note)) : "";
				if (summary.kind === "created") {
					paintedText = note;
				} else if (summary.preview && !diff) {
					paintedText = [note, (highlightCode(sanitizeToolText(summary.preview), lang, pathArg(context?.args))?.join("\n") ?? paint(theme, token, sanitizeToolText(summary.preview)))].filter(Boolean).join("\n\n");
				} else text = sanitizeToolText([summary.note, summary.preview].filter(Boolean).join("\n\n"));
			}
			const paintDiff = {
				paint: (token: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", value: string) => paint(theme, token, value),
			};
			const palette = activeDiffPalette();
			const highlight = (value: string) => highlightCode(value, lang, pathArg(context?.args));
			const fallbacks: Array<[string, string[]]> = [];
			const fallbackRows = diff ? buildDiffRows(diff, paintDiff, (value) => {
				const lines = value.length <= 8_000 ? highlightLines(value, lang, pathArg(context?.args), fallbackHighlight) : undefined;
				if (lines) fallbacks.push([value, lines]);
				return lines;
			}, palette, !preparation) : [];
			const preparedDiff = diff && owner ? preparation?.request({
				kind: "diff", text: diff, fallbacks, lang, filePath: pathArg(context?.args), colors: styleColors(), palette,
				paint: { toolDiffAdded: paintDiff.paint("toolDiffAdded", "\0"), toolDiffRemoved: paintDiff.paint("toolDiffRemoved", "\0"), toolDiffContext: paintDiff.paint("toolDiffContext", "\0") },
			}, owner, notify) : undefined;
			const rows: RenderRow[] = [
				...(summary?.kind === "created" ? createdRows(sanitizeToolText(summary.preview), paintDiff, highlight) : []),
				...(preparedDiff?.rows ?? fallbackRows),
			];
			let prose = paintedText ?? (text ? paint(theme, token, text) : "");
			if (!prose && rows.length === 0 && context?.isError) prose = paint(theme, "error", "error");
			if (!prose && rows.length === 0) return emptyComponent();
			const background = original.name === "read" && !context?.isError ? theme?.bg?.("customMessageBg", "\0") : undefined;
			const large = rows.length > 200 || prose.length + rows.reduce((sum, row) => sum + row.text.length, 0) > 16_000;
			const plainRows = large && preparation ? rows.map((row) => ({ ...row, text: sanitizeToolText(row.text) })) : rows;
			const plainProse = large && preparation ? sanitizeToolText(prose) : prose;
			let cachedWidth: number | undefined;
			let cachedLines: string[] = [];
			return {
				invalidate() { cachedWidth = undefined; },
				handleMouse(event: TuiMouseEvent) {
					const opened = fileRow ? ctrlOpen(event, context?.args, line, context?.cwd, onModifierOpen) : undefined;
					if (opened) return opened;
					if (!context?.state || !context.invalidate || !togglesOpen(event, display.open, defaultOpen)) return undefined;
					display.open = !display.open;
					context.invalidate();
					return { handled: true };
				},
				render(width: number) {
					if (width === cachedWidth) return cachedLines;
					cachedWidth = width;
					const layout = large && owner ? preparation?.request({
						kind: "layout", text: prose, rows, width, palette, background, colors: styleColors(),
					}, owner, notify) : undefined;
					return cachedLines = layout?.lines ?? layoutTool(plainProse, plainRows, width, palette, background);
				},
			};
		},
	};
	return { ...wrapped, renderResult(result, options, theme, context) {
		const owner = context?.state ?? context;
		// Pi creates a fresh result wrapper on every call, but preserves its content and details.
		const keys = [result.content, result.details, context?.args, options.expanded, options.isPartial, context?.isError, context?.state?.grokEdit?.open, context?.state?.grokTool?.open,
			styleColors(), ...(["toolOutput", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "muted", "error"] as const).map((token) => paint(theme, token, "x")), theme?.bg?.("customMessageBg", "x")];
		const cached = owner && rendered.get(owner);
		if (cached && keys.every((key, index) => key === cached.keys[index])) return cached.component;
		const component = wrapped.renderResult(result, options, theme, context);
		keys[6] = context?.state?.grokEdit?.open;
		keys[7] = context?.state?.grokTool?.open;
		if (owner && !options.isPartial) rendered.set(owner, { keys, component });
		return component;
	} };
}

export function createDiamondTools(cwd: string, factories: ToolFactoryMap, options: ToolsOptions = {}, hooks?: DiamondHooks): DiamondTool[] {
	return BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => wrapWithDiamondRenderer(
		name === "write" ? withWriteSummary(factories.write, cwd, options.write) : factories[name](cwd, options[name]), hooks,
	));
}
