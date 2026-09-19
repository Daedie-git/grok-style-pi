import { applyComposerBorderColor } from "./composer.ts";
import { footerFromContext } from "./footer.ts";
import { createDiamondTools, type ToolFactoryMap } from "./tools.ts";

export type SessionUi = {
	theme?: { fg?: (token: string, text: string) => string };
	setFooter?: (factory: unknown) => void;
	setStatus?: (id: string, text: string | undefined) => void;
	setEditorComponent?: (factory: unknown) => void;
};

export type SessionContext = {
	cwd: string;
	hasUI?: boolean;
	mode?: string;
	model?: { name?: string; id?: string } | null;
	getContextUsage?: () => { percent: number | null } | undefined;
	ui: SessionUi;
};

export type ExtensionApiLike = {
	on: (event: string, handler: (event: unknown, ctx: SessionContext) => unknown) => unknown;
	registerTool: (tool: unknown) => unknown;
};

export type CustomEditorCtor = new (tui: unknown, theme: unknown, keybindings: unknown, options?: unknown) => {
	focused?: boolean;
	borderColor?: (text: string) => string;
	render: (width: number) => string[];
};

export type GrokStyleDeps = {
	CustomEditor: CustomEditorCtor;
	tools: ToolFactoryMap;
};

export function createGrokStyleExtension(pi: ExtensionApiLike, deps: GrokStyleDeps): void {
	pi.on("session_start", (_event, ctx) => {
		const tools = createDiamondTools(ctx.cwd, deps.tools);
		for (const tool of tools) {
			pi.registerTool(tool);
		}

		if (!ctx.hasUI && ctx.mode && ctx.mode !== "tui") {
			return;
		}

		if (typeof ctx.ui.setFooter === "function") {
			ctx.ui.setFooter((tui: { requestRender?: () => void }, theme: SessionUi["theme"], footerData?: { onBranchChange?: (cb: () => void) => () => void }) => {
				const dispose = footerData?.onBranchChange?.(() => tui.requestRender?.());
				return {
					dispose,
					invalidate() {},
					render(_width: number) {
						const line = footerFromContext(ctx);
						return [theme?.fg ? theme.fg("dim", line) : line];
					},
				};
			});
		}

		if (typeof ctx.ui.setEditorComponent === "function") {
			const Editor = deps.CustomEditor;
			class GrokComposer extends Editor {
				override render(width: number): string[] {
					const paint = (token: string, text: string) =>
						ctx.ui.theme?.fg ? ctx.ui.theme.fg(token, text) : text;
					applyComposerBorderColor(
						(fn) => {
							this.borderColor = fn;
						},
						Boolean(this.focused),
						paint,
					);
					return super.render(width);
				}
			}
			ctx.ui.setEditorComponent(
				(tui: unknown, theme: unknown, keybindings: unknown) => new GrokComposer(tui, theme, keybindings),
			);
		}
	});
}
