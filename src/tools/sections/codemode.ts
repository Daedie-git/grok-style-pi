import { extractResultText } from "../diamond.ts";
import type { DiamondSection, SectionBlock } from "../section.ts";

function nestedCalls(details: unknown): string {
	const calls = (details as { calls?: unknown } | undefined)?.calls;
	if (!Array.isArray(calls)) return "";
	return calls.map((call: unknown) => {
		if (!call || typeof call !== "object") return "";
		const value = call as Record<string, unknown>;
		if (typeof value.name !== "string") return "";
		const icon = typeof value.status === "string" ? ({ running: "…", ok: "✓", error: "✗", cancelled: "⊘" } as Record<string, string>)[value.status] ?? "…" : "…";
		const args = typeof value.args === "string" ? ` ${value.args}` : "";
		const duration = typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? ` ${Math.round(value.durationMs)}ms` : "";
		const cost = typeof value.cost === "number" && Number.isFinite(value.cost) ? ` $${value.cost.toPrecision(3)}` : "";
		const error = typeof value.error === "string" ? `\n${value.error}` : "";
		return `${icon} ${value.name}${args}${duration}${cost}${error}`;
	}).filter(Boolean).join("\n");
}

export const codemodeSection: DiamondSection = {
	summary: () => ({ title: "codemode" }),
	body(view) {
		const blocks: SectionBlock[] = [
			{ kind: "code", text: typeof view.args?.code === "string" ? view.args.code : "", language: "javascript" },
			{ kind: "text", text: nestedCalls(view.result?.details), tone: "muted" },
		];
		if (!view.isPartial) blocks.push({ kind: "text", text: extractResultText(view.result), tone: view.isError ? "error" : "output" });
		return blocks;
	},
};
