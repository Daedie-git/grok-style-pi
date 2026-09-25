import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function slashPath(path: string): string {
	return path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
}

function comparablePath(path: string): string {
	const normalized = slashPath(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function displaySeparator(...paths: string[]): string {
	const path = paths.find((value) => value.includes("\\") || value.includes("/")) ?? "";
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export type FooterInput = {
	cwd: string;
	model: string;
	percent: number | null | undefined;
	thinkingLevel?: string;
	branch?: string | null;
	provider?: string | null;
	subscription?: string;
	grokPercent?: number | null;
	grokWeekly?: string;
};

export type GrokFooterInput = { contextPercent?: number | null; weekly?: string };

export type FooterContext = {
	cwd: string;
	model?: { name?: string; id?: string; provider?: string } | null;
	getContextUsage?: () => { percent: number | null } | undefined;
	thinkingLevel?: string;
	branch?: string | null;
};

export function cwdBasename(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || cwd || ".";
}

export function cwdDisplayPath(cwd: string, home = homedir()): string {
	if (!cwd) return ".";
	const cwdSlash = slashPath(cwd);
	const homeSlash = slashPath(home);
	const comparableCwd = comparablePath(cwd);
	const comparableHome = comparablePath(home);
	if (comparableCwd === comparableHome) return "~";
	if (comparableCwd.startsWith(comparableHome + "/")) {
		const separator = displaySeparator(home, cwd);
		const suffix = cwdSlash.slice(homeSlash.length).replace(/^\/+/, "").replaceAll("/", separator);
		return `~${separator}${suffix}`;
	}
	return cwd;
}

export function formatPercent(percent: number | null | undefined): string {
	if (percent == null || Number.isNaN(Number(percent))) return "?";
	return String(Math.round(Number(percent)));
}

export type UsageSource = "codex" | "grok" | "session";

/** Context and allowance belong to the selected model, not every signed-in provider. */
export function usageSource(provider?: string | null): UsageSource {
	if (provider === "openai-codex") return "codex";
	if (provider === "xai") return "grok";
	return "session";
}

export function footerStats(input: { provider?: string | null; percent?: number | null; subscription?: string; grokPercent?: number | null; grokWeekly?: string }): string {
	const source = usageSource(input.provider);
	const context = `Context ${formatPercent(source === "grok" ? input.grokPercent : input.percent)}% used`;
	if (source === "grok") return [context, input.grokWeekly ?? "Weekly ?% left"].join(" │ ");
	if (source === "codex") return [context, ...(input.subscription ? [input.subscription] : [])].join(" │ ");
	return context;
}

export function formatFooterLine(input: FooterInput): string {
	const dir = `${cwdDisplayPath(input.cwd)}${input.branch ? ` (${input.branch})` : ""}`;
	const model = (input.model ?? "").trim() || "unknown";
	return [dir, [model, input.thinkingLevel].filter(Boolean).join(" "), footerStats(input)].join(" │ ");
}

export function modelDisplayName(model: FooterContext["model"]): string {
	if (!model) return "unknown";
	return (model.name || model.id || "unknown").trim() || "unknown";
}

export function footerFromContext(ctx: FooterContext, grok?: GrokFooterInput): string {
	return formatFooterLine({
		cwd: ctx.cwd,
		model: modelDisplayName(ctx.model),
		percent: ctx.getContextUsage?.()?.percent ?? null,
		thinkingLevel: ctx.thinkingLevel,
		branch: ctx.branch,
		provider: ctx.model?.provider,
		grokPercent: grok?.contextPercent,
		grokWeekly: grok?.weekly,
	});
}

export function footerLinesFromContext(ctx: FooterContext, width: number, thinkingLevel = ctx.thinkingLevel, subscription?: string, branch = ctx.branch, grok?: GrokFooterInput): string[] {
	if (width <= 0) return [""];
	const identity = `${cwdDisplayPath(ctx.cwd)}${branch ? ` (${branch})` : ""} │ ${modelDisplayName(ctx.model)} ${thinkingLevel ?? "?"}`;
	const stats = footerStats({
		provider: ctx.model?.provider,
		percent: ctx.getContextUsage?.()?.percent,
		subscription,
		grokPercent: grok?.contextPercent,
		grokWeekly: grok?.weekly,
	});
	const available = width - visibleWidth(stats) - 3;
	return [available > 0
		? `${truncateToWidth(identity, available)} │ ${stats}`
		: truncateToWidth(stats, width)];
}
