import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CustomEditor, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { applyComposerBorderColor, frameEditorLines } from "../chrome/composer.ts";
import { footerLinesFromContext } from "../chrome/footer.ts";
import { startGrokFooterPolling } from "./grok-usage.ts";
import { formatCodexQuota, parseCodexQuota, startCodexUsagePolling, type QuotaWindow } from "./subscription.ts";
import {
	applyGrokTerminalChrome,
	resetGrokTerminalChrome,
	tuiWrite,
	suspendTerminalChrome,
} from "../chrome/terminal-chrome.ts";
import type { Features } from "./features.ts";
import type { CustomEditorCtor, ExtensionApiLike, SessionContext, SessionUi } from "./types.ts";

type SessionChromeDeps = {
	CustomEditor: CustomEditorCtor;
	features: Pick<Features, "footer" | "composer" | "terminalColors" | "toolStyling">;
};

/** Owns footer polling, the framed editor, and their shared terminal colors. */
export function createSessionChrome(pi: ExtensionApiLike, deps: SessionChromeDeps) {
	const { features } = deps;
	let suspendChrome: ReturnType<typeof suspendTerminalChrome> | undefined;
	let restoreTerminal: (() => void) | undefined;
	let quota: QuotaWindow[] = [];
	let quotaError: string | undefined;
	let quotaPolling: ReturnType<typeof startCodexUsagePolling> | undefined;
	let grokContext: number | null = null;
	let grokWeekly = "Weekly ?% left";
	let grokPolling: ReturnType<typeof startGrokFooterPolling> | undefined;
	function refreshGrokSource(ctx: SessionContext) {
		grokPolling?.dispose(); grokPolling = undefined;
		grokContext = null;
		grokWeekly = "Weekly ?% left";
		if (!features.footer || ctx.model?.provider !== "xai" || (ctx.mode && ctx.mode !== "tui")) return;
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
	let hasActiveSelection: (() => boolean) | undefined;
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
		refreshGrokSource(ctx);
		requestRender?.();
	});

	function startSession(ctx: SessionContext) {
		quota = [];

		if (!ctx.hasUI && ctx.mode && ctx.mode !== "tui") {
			return;
		}

		if (features.footer && typeof ctx.ui.setFooter === "function") {
			ctx.ui.setFooter((tui: { requestRender?: (force?: boolean) => void; hasActiveSelection?: () => boolean }, theme: SessionUi["theme"], footerData?: { getGitBranch?: () => string | null; onBranchChange?: (cb: () => void) => () => void }) => {
				hasActiveSelection = tui.hasActiveSelection?.bind(tui);
				requestRender = () => tui.requestRender?.();
				const write = tuiWrite(tui);
				if (features.terminalColors && write && !restoreTerminal) {
					applyGrokTerminalChrome(write);
					suspendChrome ??= suspendTerminalChrome(write);
					restoreTerminal = () => resetGrokTerminalChrome(write);
					// Default-color changes also affect rows outside our components.
					tui.requestRender?.(true);
				}
				const dispose = footerData?.onBranchChange?.(() => tui.requestRender?.());
				return {
					dispose,
					invalidate() {},
					render(width: number) {
						const formattedQuota = formatCodexQuota(quota);
						const subscription = ctx.model?.provider === "openai-codex"
							? quotaError && formattedQuota === "Weekly ?% left" ? `Weekly ${quotaError}` : formattedQuota
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

		// Even without visual chrome, styled tool selections need the public
		// editor factory's TUI to detect when a native selection was dismissed.
		if ((features.composer || features.terminalColors || features.toolStyling) && typeof ctx.ui.setEditorComponent === "function") {
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
				hasActiveSelection = "hasActiveSelection" in tui && typeof tui.hasActiveSelection === "function"
					? tui.hasActiveSelection.bind(tui) : undefined;
				const write = tuiWrite(tui);
				if (features.terminalColors && write && !restoreTerminal) {
					applyGrokTerminalChrome(write);
					suspendChrome ??= suspendTerminalChrome(write);
					restoreTerminal = () => resetGrokTerminalChrome(write);
					// Default-color changes also affect rows outside our components.
					tui.requestRender?.(true);
				}
				return new GrokComposer(tui, theme, keybindings);
			});
		}
		refreshQuotaSource(ctx);
		refreshGrokSource(ctx);
	}

	function dispose() {
		quotaPolling?.dispose(); quotaPolling = undefined;
		quotaError = undefined;
		quota = [];
		grokPolling?.dispose(); grokPolling = undefined;
		grokContext = null;
		grokWeekly = "Weekly ?% left";
		requestRender = undefined;
		hasActiveSelection = undefined;
		suspendChrome?.dispose(); suspendChrome = undefined;
		restoreTerminal?.();
		restoreTerminal = undefined;
	}

	return { startSession, dispose, hasActiveSelection: () => hasActiveSelection?.() };
}
