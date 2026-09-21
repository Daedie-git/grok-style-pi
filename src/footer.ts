import { homedir } from "node:os";
import { sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type FooterInput = {
	cwd: string;
	model: string;
	percent: number | null | undefined;
	thinkingLevel?: string;
	branch?: string | null;
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
	if (cwd === home) return "~";
	if (cwd.startsWith(home.endsWith(sep) ? home : home + sep)) return "~" + sep + cwd.slice(home.length).replace(/^[\\/]+/, "");
	return cwd || ".";
}

export function formatPercent(percent: number | null | undefined): string {
	if (percent == null || Number.isNaN(Number(percent))) return "?";
	return String(Math.round(Number(percent)));
}

export function footerStats(input: { percent?: number | null; subscription?: string; grokPercent?: number | null; grokWeekly?: string }): string {
	return [
		`Codex Context ${formatPercent(input.percent)}% used`,
		...(input.subscription ? [input.subscription] : []),
		`Grok Context ${formatPercent(input.grokPercent)}% used`,
		input.grokWeekly ?? "Grok Weekly ?% left",
	].join(" │ ");
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
		grokPercent: grok?.contextPercent,
		grokWeekly: grok?.weekly,
	});
}

export function footerLinesFromContext(ctx: FooterContext, width: number, thinkingLevel = ctx.thinkingLevel, subscription?: string, branch = ctx.branch, grok?: GrokFooterInput): string[] {
	if (width <= 0) return [""];
	const identity = `${cwdDisplayPath(ctx.cwd)}${branch ? ` (${branch})` : ""} │ ${modelDisplayName(ctx.model)} ${thinkingLevel ?? "?"}`;
	const stats = footerStats({
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
