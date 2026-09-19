export type FooterInput = {
	cwd: string;
	model: string;
	percent: number | null | undefined;
};

export type FooterContext = {
	cwd: string;
	model?: { name?: string; id?: string } | null;
	getContextUsage?: () => { percent: number | null } | undefined;
};

export function cwdBasename(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || cwd || ".";
}

export function formatPercent(percent: number | null | undefined): string {
	if (percent == null || Number.isNaN(Number(percent))) return "?";
	return String(Math.round(Number(percent)));
}

export function formatFooterLine(input: FooterInput): string {
	const dir = cwdBasename(input.cwd);
	const model = (input.model ?? "").trim() || "unknown";
	return `${dir} │ ${model} │ ${formatPercent(input.percent)}% ctx`;
}

export function modelDisplayName(model: FooterContext["model"]): string {
	if (!model) return "unknown";
	return (model.name || model.id || "unknown").trim() || "unknown";
}

export function footerFromContext(ctx: FooterContext): string {
	return formatFooterLine({
		cwd: ctx.cwd,
		model: modelDisplayName(ctx.model),
		percent: ctx.getContextUsage?.()?.percent ?? null,
	});
}
