import { activeDiffPalette, createSectionLayouts, paint } from "./section-layout.ts";
import { editDisplay, toolDisplay, togglesOpen } from "./section-state.ts";
import { withDiamondSection, type SectionTable } from "./section.ts";
import { DEFAULT_SECTIONS } from "./sections/index.ts";
import { withToolDescriptions } from "./guidance.ts";
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
import { truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { openInCursor, type OpenTarget } from "../navigation/open-in-cursor.ts";
import type { VisualPreparation } from "../rendering/visual-preparation.ts";
import { languageForPath } from "../rendering/highlight.ts";
import { createdRows, paintRows, type RenderRow } from "../rendering/diff-render.ts";
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
	onCodeLocation?: (path: string, line: number, endLine?: number) => void;
	hasActiveSelection?: () => boolean | undefined;
};

type CodePoint = { x: number; y: number; line: number };
type CodeSelection = {
	content: unknown; details: unknown; args: unknown;
	anchor?: CodePoint; dragged?: boolean;
	lastClick?: { x: number; y: number; at: number }; suppressClick?: boolean;
	range?: { start: CodePoint; end: CodePoint; width: number };
};

// Match Pi TUI's double-click interval for the native text-selection path.
const DOUBLE_CLICK_INTERVAL_MS = 500;

// All diamond tools registered together share mouse selection state, but no
// transcript state or mutable component is retained after their hooks expire.
const selectionGroups = new WeakMap<DiamondHooks, { active?: CodeSelection }>();

export type ToolFactory<N extends BuiltinToolName = BuiltinToolName> = (cwd: string, options?: ToolsOptions[N]) => OriginalTool;

export type ToolFactoryMap = { [N in BuiltinToolName]: ToolFactory<N> };

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

function pathArg(args: ToolArgs): string | undefined {
	return typeof args?.path === "string" ? args.path : undefined;
}

function splitReadNotice(text: string): { code: string; notice: string } {
	const match = /\n\n\[(?:Showing lines |\d+ more lines in file\.|Line \d+ is )[\s\S]*\]\s*$/.exec(text);
	if (!match || match.index === undefined) return { code: text, notice: "" };
	return { code: text.slice(0, match.index), notice: text.slice(match.index + 2) };
}

export function wrapWithDiamondRenderer<T extends OriginalTool>(original: T, hooks?: DiamondHooks, sections: SectionTable = DEFAULT_SECTIONS): T & DiamondTool {
	const section = Object.hasOwn(sections, original.name) ? sections[original.name] : undefined;
	if (section) return withDiamondSection(original, section, hooks);
	return wrapSpecializedRenderer(original, hooks) as T & DiamondTool;
}

function wrapSpecializedRenderer(original: OriginalTool, hooks?: DiamondHooks): DiamondTool {
	const onModifierOpen = hooks?.onModifierOpen ?? defaultModifierOpen;
	const layouts = createSectionLayouts(hooks);
	const selections = new WeakMap<object, CodeSelection>();
	const selectionGroup = hooks ? selectionGroups.get(hooks) ?? {} : {};
	if (hooks) selectionGroups.set(hooks, selectionGroup);
	const shell = ["bash", "powershell"].includes(original.name);
	const edit = original.name === "edit";
	const write = original.name === "write";
	const fileRow = original.name === "read" || edit || write;
	const wrapped: DiamondTool = {
		...original,
		renderShell: "self",
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
			const visual = layouts.begin(context);
			const highlightCode = visual.highlight;
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
			if (options.isPartial || !open) {
				if (owner) {
					const selection = selections.get(owner);
					if (selectionGroup.active === selection) selectionGroup.active = undefined;
					selections.delete(owner);
				}
				return emptyComponent();
			}
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
			const diffRows = visual.diff(diff, theme, lang, pathArg(context?.args));
			const rows: RenderRow[] = [
				...(summary?.kind === "created" ? createdRows(sanitizeToolText(summary.preview), paintDiff, highlight) : []),
				...diffRows,
			];
			let prose = paintedText ?? (text ? paint(theme, token, text) : "");
			if (!prose && rows.length === 0 && context?.isError) prose = paint(theme, "error", "error");
			if (!prose && rows.length === 0) return emptyComponent();
			const background = original.name === "read" && !context?.isError ? theme?.bg?.("customMessageBg", "\0") : undefined;
			const layout = visual.layout(prose, rows, background);
			const { plainRows, plainProse } = layout;
			let cachedWidth: number | undefined;
			let cachedLines: string[] = [];
			let codeLines: Array<number | undefined> = [];
			const path = pathArg(context?.args);
			const readSource = original.name === "read" && !context?.isError && text ? splitReadNotice(text).code : "";
			const readCode = readSource && !result.content?.some((block) => block.type === "image") &&
				!/^Read image file \[[^\]\n]+\](?:\n|$)/.test(readSource) &&
				!/^\[(?:Showing lines |\d+ more lines in file\.|Line \d+ is )/.test(readSource)
				? readSource.split("\n") : [];
			const previewStart = summary?.preview && summary.kind !== "created" && !diff
				? (summary.note ? sanitizeToolText(summary.note).split("\n").length + 1 : 0) : -1;
			const previewLength = previewStart >= 0 ? sanitizeToolText(summary!.preview).split("\n").length : 0;
			const diffLines = diff ? diff.split("\n") : [];
			const previousSelection = owner && selections.get(owner);
			const selection = previousSelection && previousSelection.content === result.content && previousSelection.details === result.details && previousSelection.args === context?.args
				? previousSelection : { content: result.content, details: result.details, args: context?.args } as CodeSelection;
			if (selectionGroup.active === previousSelection && selection !== previousSelection) selectionGroup.active = undefined;
			if (owner) selections.set(owner, selection);
			return {
				invalidate() { cachedWidth = undefined; layout.invalidate(); },
				handleMouse(event: TuiMouseEvent) {
					const opened = fileRow ? ctrlOpen(event, context?.args, line, context?.cwd, onModifierOpen) : undefined;
					if (opened) { selection.range = undefined; selectionGroup.active = undefined; return opened; }
					const location = event.button === "left" && !event.alt && !event.ctrl &&
						Number.isInteger(event.y) && event.y >= 0 && Number.isInteger(event.x) && event.x >= 0 && event.x < (cachedWidth ?? 0)
						? codeLines[event.y] : undefined;
					const point = location === undefined ? undefined : { x: event.x, y: event.y, line: location };
					if (event.type === "press") {
						// A moved release does not produce a click, so expire suppression on every new press.
						selection.suppressClick = false;
						const previous = selection.lastClick;
						selection.lastClick = undefined;
						if (selectionGroup.active && (selectionGroup.active !== selection || hooks?.hasActiveSelection?.() === false)) {
							selectionGroup.active.range = undefined;
							selectionGroup.active = undefined;
						}
						// Native text selection turns a second press into a word selection before
						// Pi can send a clickCount: 2 click, so handle that press here.
						if (point && path && hooks?.onCodeLocation && previous && previous.x === point.x && previous.y === point.y && Date.now() - previous.at <= DOUBLE_CLICK_INTERVAL_MS) {
							selection.suppressClick = true;
							hooks.onCodeLocation(sanitizeToolText(path), point.line);
							return { handled: true };
						}
						selection.anchor = point;
						selection.dragged = false;
					} else if (event.type === "drag" && selection.anchor) {
						selection.dragged = true;
						selection.range = undefined;
						if (selectionGroup.active === selection) selectionGroup.active = undefined;
					} else if (event.type === "release") {
						let end = point;
						// A selection can finish in the read continuation notice or the
						// gap after source rows. Retain the source portion of the drag.
						if (!end && selection.anchor && Number.isInteger(event.y)) {
							const forward = event.y > selection.anchor.y;
							for (let y = event.y; forward ? y > selection.anchor.y : y < selection.anchor.y; y += forward ? -1 : 1) {
								const sourceLine = codeLines[y];
								if (sourceLine !== undefined) {
									end = { x: forward ? (cachedWidth ?? 1) - 1 : 0, y, line: sourceLine };
									break;
								}
							}
						}
						if (selection.dragged && selection.anchor && end && (end.y !== selection.anchor.y || end.x !== selection.anchor.x)) {
							const forward = selection.anchor.y < end.y || selection.anchor.y === end.y && selection.anchor.x < end.x;
							selection.range = { start: forward ? selection.anchor : end, end: forward ? end : selection.anchor, width: cachedWidth ?? 0 };
							selectionGroup.active = selection;
						}
						selection.anchor = undefined;
						selection.dragged = false;
					}
					if (event.type === "click" && selection.suppressClick) {
						selection.suppressClick = false;
						return { handled: true };
					}
					if (event.type === "click" && point && path && hooks?.onCodeLocation) {
						const range = selectionGroup.active === selection ? selection.range : undefined;
						const inside = range && range.width === cachedWidth &&
								(point.y > range.start.y || point.y === range.start.y && point.x >= range.start.x) &&
								(point.y < range.end.y || point.y === range.end.y && point.x <= range.end.x);
						selection.range = undefined;
						selectionGroup.active = undefined;
						// Captured or directly dispatched clicks may carry Pi's click count instead.
						if (inside || event.clickCount === 2) {
							hooks.onCodeLocation(sanitizeToolText(path), inside && range ? Math.min(range.start.line, range.end.line) : point.line,
								inside && range && range.start.line !== range.end.line ? Math.max(range.start.line, range.end.line) : undefined);
						} else {
							selection.lastClick = { x: point.x, y: point.y, at: Date.now() };
						}
						return { handled: true };
					}
					if (event.type === "click") { selection.range = undefined; selectionGroup.active = undefined; }
					if (!context?.state || !context.invalidate || !togglesOpen(event, display.open, defaultOpen)) return undefined;
					display.open = !display.open;
					context.invalidate();
					return { handled: true };
				},
				render(width: number) {
					if (width === cachedWidth) return cachedLines;
					if (cachedWidth !== undefined && cachedWidth !== width) {
						selection.anchor = undefined;
						selection.range = undefined;
						if (selectionGroup.active === selection) selectionGroup.active = undefined;
					}
					cachedWidth = width;
					cachedLines = layout.render(width);
					codeLines = [];
					if (!fileRow || !path || !hooks?.onCodeLocation) return cachedLines;
					// Use the same wrapping width as layoutTool, so a click on a continuation
					// row still refers to the logical source line rather than the next one.
					const inner = Math.max(0, width - (width > 2 ? 2 : 0));
					if (prose) {
						for (const [index, source] of plainProse.replace(/\t/g, "   ").split("\n").entries()) {
							const wraps = source && inner > 0 ? wrapTextWithAnsi(source, inner).length : 1;
							const number = index < readCode.length ? Math.max(1, Math.trunc(line)) + index :
								index >= previewStart && previewStart >= 0 && index < previewStart + previewLength ? index - previewStart + 1 : undefined;
							for (let row = 0; row < wraps; row++) codeLines.push(number);
						}
					}
					if (prose && rows.length) codeLines.push(undefined); // blank separator
					const createdCount = summary?.kind === "created" ? rows.length - diffLines.length : 0;
					let lineDelta = 0;
					for (const [index, row] of plainRows.entries()) {
							const source = diffLines[index - createdCount];
							const numbered = source && /^[ +\-]\s*(\d+) /.exec(source);
							// Pi prints old-file numbers on unchanged context, but new-file
							// numbers on additions. Account for preceding inserted/deleted lines.
							const number = index < createdCount ? index + 1 : numbered && (row.kind === "add" || row.kind === "remove" || row.kind === "context")
								? Number(numbered[1]) + (row.kind === "context" ? lineDelta : 0) : undefined;
							if (row.kind === "add") lineDelta++;
							if (row.kind === "remove") lineDelta--;
							for (let part = 0; part < paintRows([row], width, width > 2 ? "  " : "", palette).length; part++) codeLines.push(number);
						}
					return cachedLines;
				},
			};
		},
	};
	return { ...wrapped, renderResult(result, options, theme, context) {
		return layouts.cached(result, options, theme, context, () => wrapped.renderResult(result, options, theme, context));
	} };
}

export function createDiamondTools(cwd: string, factories: ToolFactoryMap, options: ToolsOptions = {}, hooks?: DiamondHooks, sections: SectionTable = DEFAULT_SECTIONS): DiamondTool[] {
	return BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => wrapWithDiamondRenderer(
		withToolDescriptions(name === "write" ? withWriteSummary(factories.write, cwd, options.write) : factories[name](cwd, options[name])), hooks, sections,
	));
}
