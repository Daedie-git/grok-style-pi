import { truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { languageForPath } from "../rendering/highlight.ts";
import { emptyComponent, extractResultDiff, sanitizeToolText, type ToolArgs, type ToolResult } from "./diamond.ts";
import { createSectionLayouts, paint } from "./section-layout.ts";
import { fileTarget, defaultModifierOpen, handleDiamondClick } from "./interaction.ts";
import { toolDisplay } from "./section-state.ts";
import type { DiamondHooks, DiamondTool, OriginalTool } from "./renderer.ts";

export type SectionView = { args: ToolArgs; result?: ToolResult; isError: boolean; isPartial: boolean };
export type SectionSummary = { title: string; target?: string; detail?: string };
export type SectionBlock =
	| { kind: "text"; text: string; tone?: "output" | "muted" | "error" }
	| { kind: "code"; text: string; language: string };
export type DiamondSection = {
	summary(view: SectionView): SectionSummary;
	body(view: SectionView): readonly SectionBlock[];
};
export type SectionTable = Readonly<Record<string, DiamondSection>>;

/** Render-only decoration: execution, schemas, and upstream metadata stay by identity. */
export function withDiamondSection<T extends OriginalTool>(tool: T, section: DiamondSection, hooks?: DiamondHooks): T & DiamondTool {
	const layouts = createSectionLayouts(hooks);
	const onModifierOpen = hooks?.onModifierOpen ?? defaultModifierOpen;
	const cleanSummary = (view: SectionView) => {
		const summary = section.summary(view);
		const clean = (value: string | undefined) => value === undefined ? undefined : sanitizeToolText(value).replace(/\s+/g, " ").trim();
		return { title: clean(summary.title) ?? "", target: clean(summary.target), detail: clean(summary.detail) };
	};
	return {
		...tool,
		renderShell: "self",
		renderCall(args, theme, context) {
			const initial = cleanSummary({ args, isError: !!context?.isError, isPartial: false });
			const saved = context?.state?.grokSection;
			if (context?.state && (!saved?.hasResult || saved.args !== args)) {
				context.state.grokSection = { args, summary: initial, isError: !!context.isError, hasResult: false };
			}
			const display = toolDisplay(context, context?.expanded ?? false);
			return {
				invalidate() {},
				render(width: number) {
					if (width <= 0) return [];
					const saved = context?.state?.grokSection;
					const summary = saved?.summary ?? initial;
					const failed = saved?.isError ?? !!context?.isError;
					const label = paint(theme, failed ? "error" : "toolTitle", `◆ ${failed ? "Failed: " : ""}${summary.title}`) +
						(summary.target ? " " + paint(theme, failed ? "error" : "text", summary.target) : "") +
						(summary.detail ? " " + paint(theme, failed ? "error" : "muted", summary.detail) : "");
					return [truncateToWidth(label, width)];
				},
				handleMouse(event: TuiMouseEvent) {
					return handleDiamondClick(event, "header", {
						display: context?.state && context.invalidate ? display : undefined, invalidate: context?.invalidate,
						openTarget: fileTarget(context?.args ?? args, 1, context?.cwd, onModifierOpen),
					});
				},
			};
		},
		renderResult(result, options, theme, context) {
			const view = { args: context?.args, result, isError: !!context?.isError, isPartial: !!options.isPartial };
			if (context?.state) context.state.grokSection = { args: context.args, summary: cleanSummary(view), isError: view.isError, hasResult: true };
			const display = toolDisplay(context, options.expanded);
			return layouts.cached(result, options, theme, context, () => {
				const visual = layouts.begin(context);
				if (!display.open) return emptyComponent();
				const blocks = section.body(view).map((block) => {
					const text = sanitizeToolText(block.text);
					if (!text) return "";
					if (block.kind === "code") return visual.highlight(text, block.language)?.join("\n") ?? paint(theme, "toolOutput", text);
					return paint(theme, block.tone === "error" ? "error" : block.tone === "muted" ? "muted" : "toolOutput", text);
				}).filter(Boolean);
				const path = typeof view.args?.path === "string" ? view.args.path : undefined;
				const rows = options.isPartial ? [] : visual.diff(sanitizeToolText(extractResultDiff(result)), theme, languageForPath(path), path);
				let prose = blocks.join("\n\n");
				if (!prose && !rows.length && view.isError && !options.isPartial) prose = paint(theme, "error", "error");
				const layout = visual.layout(prose, rows);
				return {
					invalidate: layout.invalidate,
					render: layout.render,
					handleMouse(event: TuiMouseEvent) {
						return handleDiamondClick(event, "body", {
							display: context?.state && context.invalidate ? display : undefined, invalidate: context?.invalidate,
							openTarget: fileTarget(view.args, 1, context?.cwd, onModifierOpen),
						});
					},
				};
			});
		},
	} as T & DiamondTool;
}
