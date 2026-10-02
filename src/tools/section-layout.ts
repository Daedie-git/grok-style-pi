import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { hexToRgb, styleColors } from "../chrome/style-colors.ts";
import { buildDiffRows, type DiffPalette, type RenderRow } from "../rendering/diff-render.ts";
import { highlightLines } from "../rendering/highlight.ts";
import { layoutTool } from "../rendering/tool-layout.ts";
import { sanitizeToolText, type ToolResult, type ToolResultOptions, type ToolRenderContext, type textComponent } from "./diamond.ts";
import type { DiamondHooks, ThemeLike } from "./renderer.ts";

export function paint(theme: ThemeLike | undefined, token: ThemeColor, text: string): string {
	return theme?.fg ? theme.fg(token, text) : text;
}

export function activeDiffPalette(): DiffPalette {
	const colors = styleColors();
	return {
		insert: hexToRgb(colors.diffInsert), delete: hexToRgb(colors.diffDelete),
		insertChar: hexToRgb(colors.diffInsertChar), deleteChar: hexToRgb(colors.diffDeleteChar),
	};
}

const fallbackHighlight = () => undefined;
type Component = ReturnType<typeof textComponent>;

/** One implementation of result identity, preparation ownership, and bounded layout. */
export function createSectionLayouts(hooks?: DiamondHooks) {
	const requests = new WeakMap<object, object>();
	const rendered = new WeakMap<object, { keys: unknown[]; component: Component }>();
	function keys(result: ToolResult, options: ToolResultOptions, theme: ThemeLike, context?: ToolRenderContext) {
		return [result.content, result.details, context?.args, options.expanded, options.isPartial, context?.isError,
			context?.state?.grokEdit?.open, context?.state?.grokTool?.open, styleColors(),
			...(["toolOutput", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "muted", "error"] as const).map((token) => paint(theme, token, "x")),
			theme?.bg?.("customMessageBg", "x")];
	}
	return {
		cached(result: ToolResult, options: ToolResultOptions, theme: ThemeLike, context: ToolRenderContext | undefined, build: () => Component): Component {
			const owner = context?.state ?? context;
			const before = keys(result, options, theme, context);
			const cached = owner && rendered.get(owner);
			if (!options.isPartial && cached && before.every((key, index) => key === cached.keys[index])) return cached.component;
			if (owner) rendered.delete(owner);
			const component = build();
			if (owner && !options.isPartial) rendered.set(owner, { keys: keys(result, options, theme, context), component });
			return component;
		},
		begin(context?: ToolRenderContext) {
			const owner = context?.state ?? context;
			const preparation = context?.invalidate ? hooks?.preparation : undefined;
			const ticket = {};
			if (owner) requests.set(owner, ticket);
			const notify = () => {
				if (!owner || requests.get(owner) !== ticket) return;
				rendered.delete(owner); context?.invalidate?.();
			};
			const highlight = (value: string, lang?: string, filePath?: string) => {
				const ready = owner && preparation?.request({ kind: "highlight", text: value, lang, filePath, colors: styleColors() }, owner, notify);
				return ready?.lines ?? (value.length <= 8_000 ? highlightLines(value, lang, filePath, fallbackHighlight) : undefined);
			};
			return {
				highlight,
				diff(text: string, theme: ThemeLike, lang?: string, filePath?: string): RenderRow[] {
					if (!text) return [];
					const palette = activeDiffPalette();
					const paintDiff = { paint: (token: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", value: string) => paint(theme, token, value) };
					const fallbacks: Array<[string, string[]]> = [];
					const fallbackRows = buildDiffRows(text, paintDiff, (value) => {
						const lines = value.length <= 8_000 ? highlightLines(value, lang, filePath, fallbackHighlight) : undefined;
						if (lines) fallbacks.push([value, lines]);
						return lines;
					}, palette, !preparation);
					const ready = owner && preparation?.request({
						kind: "diff", text, fallbacks, lang, filePath, colors: styleColors(), palette,
						paint: { toolDiffAdded: paintDiff.paint("toolDiffAdded", "\0"), toolDiffRemoved: paintDiff.paint("toolDiffRemoved", "\0"), toolDiffContext: paintDiff.paint("toolDiffContext", "\0") },
					}, owner, notify);
					return ready?.rows ?? fallbackRows;
				},
				layout(prose: string, rows: RenderRow[], background?: string) {
					const palette = activeDiffPalette();
					const large = rows.length > 200 || prose.length + rows.reduce((sum, row) => sum + row.text.length, 0) > 16_000;
					const plainRows = large && preparation ? rows.map((row) => ({ ...row, text: sanitizeToolText(row.text) })) : rows;
					const plainProse = large && preparation ? sanitizeToolText(prose) : prose;
					let cachedWidth: number | undefined;
					let cachedLines: string[] = [];
					return {
						plainRows, plainProse,
						invalidate() { cachedWidth = undefined; },
						render(width: number) {
							if (width === cachedWidth) return cachedLines;
							cachedWidth = width;
							const ready = large && owner ? preparation?.request({ kind: "layout", text: prose, rows, width, palette, background, colors: styleColors() }, owner, notify) : undefined;
							cachedLines = ready?.lines ?? layoutTool(plainProse, plainRows, width, palette, background);
							return cachedLines;
						},
					};
				},
			};
		},
	};
}
