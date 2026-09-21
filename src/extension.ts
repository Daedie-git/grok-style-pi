import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolsOptions, ModelRegistry, ExtensionAPI, CustomEditor, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { applyComposerBorderColor, frameEditorLines } from "./composer.ts";
import { footerLinesFromContext, type FooterContext } from "./footer.ts";
import { startGrokFooterPolling } from "./grok-usage.ts";
import { formatCodexQuota, parseCodexQuota, startCodexUsagePolling, type QuotaWindow } from "./subscription.ts";
import {
	applyGrokTerminalChrome,
	resetGrokTerminalChrome,
	tuiWrite,
	suspendTerminalChrome,
} from "./terminal-chrome.ts";
import { defaultFeatures, type Features } from "./features.ts";
import { createOpenHistory, absPath, type OpenTarget } from "./open-in-cursor.ts";
import { createCursorWorkspaceOpener, type CursorOpenContext, type CursorWorkspaceDeps } from "./cursor-workspace.ts";
import { BUILTIN_TOOL_NAMES, createDiamondTools, type OriginalTool, type ToolFactoryMap, type BuiltinToolName } from "./tools.ts";

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
	registerCommand?: ExtensionAPI["registerCommand"];
	registerShortcut?: ExtensionAPI["registerShortcut"];
	getThinkingLevel?: () => string;
};

export type CustomEditorCtor = typeof CustomEditor;

export type GrokStyleDeps = {
	CustomEditor: CustomEditorCtor;
	tools: ToolFactoryMap;
	getToolOptions?: (ctx: SessionContext) => ToolsOptions;
	wrapTool?: (tool: OriginalTool) => OriginalTool;
	features?: Partial<Features>;
	openCursor?: (target: OpenTarget) => Promise<void>;
	refreshCompileCommands?: CursorWorkspaceDeps["refresh"];
};

export function createGrokStyleExtension(pi: ExtensionApiLike, deps: GrokStyleDeps): void {
	const features = { ...defaultFeatures, ...deps.features };
	const { rememberOpen, lastOpen, recentOpens, clear } = createOpenHistory();
	const cursor = createCursorWorkspaceOpener({ open: deps.openCursor, refresh: deps.refreshCompileCommands });
	let openContext: CursorOpenContext | undefined;
	let notifyOpenError: ((message: string, kind: "error") => void) | undefined;
	let sessionGeneration = 0;
	function registerTools(cwd: string, options?: ToolsOptions) {
		const tools = features.toolStyling ? createDiamondTools(cwd, deps.tools, options, {
			onModifierOpen(target) {
				const notify = notifyOpenError;
				const generation = sessionGeneration;
				void (async () => {
					try { await cursor.open(target, openContext); }
					catch (error) {
						if (generation === sessionGeneration) notify?.(`Failed to open Cursor: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				})();
			},
		}) :
			BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => deps.tools[name](cwd, options?.[name]));
		for (const tool of tools) {
			const registered = deps.wrapTool ? deps.wrapTool(tool) : tool;
			pi.registerTool({ ...registered, label: registered.label ?? registered.name });
		}
	}
	// Pi rebuilds transcript rows before session_start on reload. Register the
	// renderers during extension load, then refresh execution options at startup.
	registerTools(process.cwd());
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const path = typeof event.input.path === "string" ? event.input.path : undefined;
		if (!path) return;
		const details = event.details as { firstChangedLine?: unknown } | undefined;
		const line = event.toolName === "edit" && typeof details?.firstChangedLine === "number" ? details.firstChangedLine : 1;
		rememberOpen({ path: absPath(path, ctx.cwd), line, cwd: ctx.cwd });
	});
	async function openLast(ctx: CursorOpenContext) {
		const target = lastOpen();
		if (!target) {
			ctx.ui.notify?.("No edited files in this session yet", "warning");
			return;
		}
		try {
			if (!await cursor.open(target, ctx)) return;
			ctx.ui.notify?.(`Cursor ${target.path}:${target.line}`, "info");
		} catch (error) {
			ctx.ui.notify?.(`Failed to open Cursor: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
	pi.registerShortcut?.("ctrl+alt+o", {
		description: "Open last edited file in Cursor at the change line",
		handler: async (ctx) => { await openLast(ctx); },
	});
	pi.registerCommand?.("open", {
		description: "Open last edited file in Cursor (usage: /open [pick])",
		handler: async (args, ctx) => {
			if (args.trim() === "pick") {
				const generation = sessionGeneration;
				const recents = recentOpens();
				if (recents.length === 0) {
					ctx.ui.notify("No edited files in this session yet", "warning");
					return;
				}
				const labels = recents.map((target) => `${target.path}:${target.line}`);
				const selected = await ctx.ui.select("Open in Cursor", labels);
				if (!selected || generation !== sessionGeneration) return;
				const target = recents[labels.indexOf(selected)];
				if (target) {
					try {
						if (!await cursor.open(target, ctx)) return;
						ctx.ui.notify(`Cursor ${target.path}:${target.line}`, "info");
					} catch (error) {
						ctx.ui.notify(`Failed to open Cursor: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				return;
			}
			await openLast(ctx);
		},
	});
	let suspendChrome: ReturnType<typeof suspendTerminalChrome> | undefined;
	let restoreTerminal: (() => void) | undefined;
	let quota: QuotaWindow[] = [];
	let quotaError: string | undefined;
	let quotaPolling: ReturnType<typeof startCodexUsagePolling> | undefined;
	let grokContext: number | null = null;
	let grokWeekly = "Grok Weekly ?% left";
	let grokPolling: ReturnType<typeof startGrokFooterPolling> | undefined;
	function refreshGrokSource(ctx: SessionContext) {
		grokPolling?.dispose(); grokPolling = undefined;
		grokContext = null;
		grokWeekly = "Grok Weekly ?% left";
		if (!features.footer || (ctx.mode && ctx.mode !== "tui")) return;
		grokPolling = startGrokFooterPolling(
			() => ctx.cwd,
			() => ctx.modelRegistry ? ctx.modelRegistry.getApiKeyForProvider("xai") : Promise.resolve(undefined),
			(stats) => { grokContext = stats.contextPercent; grokWeekly = stats.weekly; requestRender?.(); },
		);
	}
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
		cursor.reset();
		openContext = ctx;
		clear();
		sessionGeneration++;
		notifyOpenError = (message, kind) => ctx.ui.notify(message, kind);
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
						return footerLinesFromContext(ctx, width, pi.getThinkingLevel?.(), subscription, footerData?.getGitBranch?.(), {
							contextPercent: grokContext,
							weekly: grokWeekly,
						}).map((line) =>
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
		refreshGrokSource(ctx);
	});

	pi.on("session_shutdown", () => {
		cursor.reset();
		openContext = undefined;
		clear();
		sessionGeneration++;
		notifyOpenError = undefined;
		quotaPolling?.dispose(); quotaPolling = undefined;
		quotaError = undefined;
		quota = [];
		grokPolling?.dispose(); grokPolling = undefined;
		grokContext = null;
		grokWeekly = "Grok Weekly ?% left";
		requestRender = undefined;
		suspendChrome?.dispose(); suspendChrome = undefined;
		restoreTerminal?.();
		restoreTerminal = undefined;
	});
}
