import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolsOptions, ModelRegistry, ExtensionAPI, CustomEditor, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { applyComposerBorderColor, frameEditorLines } from "./composer.ts";
import { footerLinesFromContext, type FooterContext } from "./footer.ts";
import { formatCodexQuota, parseCodexQuota, startCodexUsagePolling, type QuotaWindow } from "./subscription.ts";
import {
	applyGrokTerminalChrome,
	resetGrokTerminalChrome,
	tuiWrite,
	suspendTerminalChrome,
} from "./terminal-chrome.ts";
import { defaultFeatures, type Features } from "./features.ts";
import { BUILTIN_TOOL_NAMES, createDiamondTools, type OriginalTool, type ToolFactoryMap, type BuiltinToolName, type ViewImage } from "./tools.ts";

export type SessionUi = {
	theme?: { fg?(token: string, text: string): string };
	setFooter?(factory: unknown): void;
	setStatus?: (id: string, text: string | undefined) => void;
	setEditorComponent?(factory: unknown): void;
};

export type SessionContext = FooterContext & {
	cwd: string;
	modelRegistry?: Pick<ModelRegistry, "getApiKeyForProvider">;
	hasUI?: boolean;
	mode?: string;
	model?: { name?: string; id?: string; provider?: string } | null;
	getContextUsage?: () => { percent: number | null } | undefined;
	isProjectTrusted?: () => boolean;
	ui: SessionUi;
};

export type ExtensionApiLike = {
	on: ExtensionAPI["on"];
	registerTool: ExtensionAPI["registerTool"];
	getThinkingLevel?: () => string;
};

export type CustomEditorCtor = typeof CustomEditor;

export type GrokStyleDeps = {
	CustomEditor: CustomEditorCtor;
	tools: ToolFactoryMap;
	getToolOptions?: (ctx: SessionContext) => ToolsOptions;
	wrapTool?: (tool: OriginalTool) => OriginalTool;
	viewImage?: ViewImage;
	features?: Partial<Features>;
};

export function createGrokStyleExtension(pi: ExtensionApiLike, deps: GrokStyleDeps): void {
	const features = { ...defaultFeatures, ...deps.features };
	function registerTools(cwd: string, options?: ToolsOptions) {
		const tools = features.toolStyling ? createDiamondTools(cwd, deps.tools, options, deps.viewImage) :
			BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => deps.tools[name](cwd, options?.[name]));
		for (const tool of tools) {
			const registered = deps.wrapTool ? deps.wrapTool(tool) : tool;
			pi.registerTool({ ...registered, label: registered.label ?? registered.name });
		}
	}
	// Pi rebuilds transcript rows before session_start on reload. Register the
	// renderers during extension load, then refresh execution options at startup.
	registerTools(process.cwd());
	let suspendChrome: ReturnType<typeof suspendTerminalChrome> | undefined;
	let restoreTerminal: (() => void) | undefined;
	let quota: QuotaWindow[] = [];
	let quotaError: string | undefined;
	let quotaPolling: ReturnType<typeof startCodexUsagePolling> | undefined;
	function refreshQuotaSource(ctx: SessionContext) {
		quotaPolling?.dispose(); quotaPolling = undefined;
		quotaError = undefined;
		if (!features.footer || ctx.model?.provider !== "openai-codex" || !ctx.modelRegistry || (ctx.mode && ctx.mode !== "tui")) return;
		const registry = ctx.modelRegistry;
		quotaPolling = startCodexUsagePolling(() => registry.getApiKeyForProvider("openai-codex"), (windows, error) => {
			if (windows) quota = windows;
			quotaError = error;
			requestRender?.();
		});
	}
	let requestRender: (() => void) | undefined;
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex") return;
		const headers = (event as { headers?: Record<string, string> }).headers;
		if (!headers) return;
		const updated = parseCodexQuota(headers);
		if (updated.length) {
			quota = [...quota.filter((window) => !updated.some((next) => next.label === window.label)), ...updated];
			quotaError = undefined;
			requestRender?.();
		}
	});
	pi.on("model_select", (_event, ctx) => {
		quota = [];
		refreshQuotaSource(ctx);
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		quota = [];
		registerTools(ctx.cwd, deps.getToolOptions?.(ctx));

		if (!ctx.hasUI && ctx.mode && ctx.mode !== "tui") {
			return;
		}

		if (features.footer && typeof ctx.ui.setFooter === "function") {
			ctx.ui.setFooter((tui: { requestRender?: () => void }, theme: SessionUi["theme"], footerData?: { getGitBranch?: () => string | null; onBranchChange?: (cb: () => void) => () => void }) => {
				requestRender = () => tui.requestRender?.();
				const write = tuiWrite(tui);
				if (features.terminalColors && write && !restoreTerminal) {
					applyGrokTerminalChrome(write);
					suspendChrome ??= suspendTerminalChrome(write);
					restoreTerminal = () => resetGrokTerminalChrome(write);
				}
				const dispose = footerData?.onBranchChange?.(() => tui.requestRender?.());
				return {
					dispose,
					invalidate() {},
					render(width: number) {
						const formattedQuota = formatCodexQuota(quota);
						const subscription = ctx.model?.provider === "openai-codex"
							? quotaError && formattedQuota === "Codex weekly ? left" ? `Codex weekly ${quotaError}` : formattedQuota
							: undefined;
						return footerLinesFromContext(ctx, width, pi.getThinkingLevel?.(), subscription, footerData?.getGitBranch?.()).map((line) =>
							truncateToWidth(theme?.fg ? theme.fg("muted", line) : line, Math.max(0, width)),
						);
					},
				};
			});
		}

		if ((features.composer || features.terminalColors) && typeof ctx.ui.setEditorComponent === "function") {
			const Editor = deps.CustomEditor;
			class GrokComposer extends Editor {
				private suspendHandler: (() => void) | undefined;

				override handleInput(data: string) {
					const handler = this.actionHandlers?.get("app.suspend");
					if (handler && handler !== this.suspendHandler && suspendChrome) {
						const chrome = suspendChrome;
						this.suspendHandler = () => chrome.run(handler);
						this.actionHandlers!.set("app.suspend", this.suspendHandler);
					}
					super.handleInput?.(data);
				}

				private bottomBorder = "";
				private framed = false;

				override renderBottomBorder(width: number, hiddenLineCount: number): string {
					this.bottomBorder = super.renderBottomBorder?.(width, hiddenLineCount) ?? this.borderColor!("─".repeat(width));
					return this.bottomBorder;
				}

				override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					return super.handleMouse?.(this.framed ? { ...event, x: Math.max(0, event.x - 4), width: event.width - 5 } : event);
				}

				override render(width: number): string[] {
					if (!features.composer) { this.framed = false; return super.render(width); }
					const paint = (token: ThemeColor, text: string) =>
						ctx.ui.theme?.fg ? ctx.ui.theme.fg(token, text) : text;
					applyComposerBorderColor(
						(fn) => {
							this.borderColor = fn;
						},
						Boolean(this.focused),
						paint,
					);
					this.framed = width >= 8;
					this.bottomBorder = "";
					const lines = super.render(this.framed ? width - 5 : width);
					if (!this.framed) return lines;
					const bottomIndex = this.bottomBorder ? lines.lastIndexOf(this.bottomBorder) : lines.length - 1;
					return frameEditorLines(lines, bottomIndex, width, paint, Boolean(this.focused));
				}
			}
			ctx.ui.setEditorComponent((...[tui, theme, keybindings]: ConstructorParameters<typeof CustomEditor>) => {
				const write = tuiWrite(tui);
				if (features.terminalColors && write && !restoreTerminal) {
					applyGrokTerminalChrome(write);
					suspendChrome ??= suspendTerminalChrome(write);
					restoreTerminal = () => resetGrokTerminalChrome(write);
				}
				return new GrokComposer(tui, theme, keybindings);
			});
		}
		refreshQuotaSource(ctx);
	});

	pi.on("session_shutdown", () => {
		quotaPolling?.dispose(); quotaPolling = undefined;
		quotaError = undefined;
		quota = [];
		requestRender = undefined;
		suspendChrome?.dispose(); suspendChrome = undefined;
		restoreTerminal?.();
		restoreTerminal = undefined;
	});
}
