import { agentSummary, commandSummary, compactArgs, extractResultText, sanitizeToolText, toolVerb, type ToolArgs } from "../diamond.ts";
import type { DiamondSection, SectionBlock, SectionView } from "../section.ts";

type NestedCall = Record<string, unknown> & { name: string };

function callsFrom(details: unknown): NestedCall[] {
	const calls = (details as { calls?: unknown } | undefined)?.calls;
	if (!Array.isArray(calls)) return [];
	return calls.filter((call): call is NestedCall => !!call && typeof call === "object" &&
		typeof call.name === "string" && !!sanitizeToolText(call.name).trim());
}

function callArgs(call: NestedCall): ToolArgs {
	// Pi stores compact, sometimes truncated JSON. Never infer arguments from the script.
	if (typeof call.args !== "string" || call.args.length > 8_192) return undefined;
	try {
		const args: unknown = JSON.parse(call.args);
		return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

function singleCall(call: NestedCall): string {
	const args = callArgs(call);
	if (call.name === "Agent") return agentSummary(args);
	const description = typeof args?.description === "string" ? sanitizeToolText(args.description).replace(/\s+/g, " ").trim().slice(0, 100) : "";
	if (description) return description;
	if (call.name === "bash" || call.name === "powershell") return commandSummary(args);
	const target = compactArgs(args, 80);
	const verb = toolVerb(call.name);
	return target ? `${verb} ${target}` : verb;
}

function groupedCalls(calls: NestedCall[]): string {
	const groups = new Map<string, number>();
	for (const call of calls) {
		const name = call.name === "powershell" ? "bash" : call.name;
		groups.set(name, (groups.get(name) ?? 0) + 1);
	}
	const labels: string[] = [];
	let others = 0;
	for (const [name, count] of groups) {
		if (labels.length === 3) { others += count; continue; }
		const files = `${count} ${count === 1 ? "file" : "files"}`;
		switch (name) {
			case "read": labels.push(`Read ${files}`); break;
			case "edit": labels.push(`Edit ${files}`); break;
			case "write": labels.push(`Write ${files}`); break;
			case "bash": labels.push(`Run ${count} ${count === 1 ? "command" : "commands"}`); break;
			default: labels.push(`${toolVerb(name)}${count > 1 ? ` ×${count}` : ""}`); break;
		}
	}
	if (others) labels.push(`${others} other ${others === 1 ? "call" : "calls"}`);
	return labels.join(" · ");
}

function callSummary(view: SectionView): string | undefined {
	const calls = callsFrom(view.result?.details);
	if (!calls.length) return undefined;
	const parts = [calls.length === 1 ? singleCall(calls[0]) : groupedCalls(calls)];
	const finished = calls.filter(call => call.status === "ok" || call.status === "error" || call.status === "cancelled").length;
	const failed = calls.filter(call => call.status === "error").length;
	const cancelled = calls.filter(call => call.status === "cancelled").length;
	if (view.isPartial || calls.some(call => call.status === "running")) parts.push(`${finished}/${calls.length} finished`);
	// The "Failed:" title already reports a single failed call.
	if (failed && !(view.isError && failed === 1)) parts.push(`${failed} failed`);
	if (cancelled) parts.push(`${cancelled} cancelled`);
	return `· ${parts.join(" · ")}`;
}

function nestedCalls(details: unknown): string {
	return callsFrom(details).map(value => {
		const icon = typeof value.status === "string" ? ({ running: "…", ok: "✓", error: "✗", cancelled: "⊘" } as Record<string, string>)[value.status] ?? "…" : "…";
		const args = typeof value.args === "string" ? ` ${sanitizeToolText(value.args)}` : "";
		const duration = typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? ` ${Math.round(value.durationMs)}ms` : "";
		const cost = typeof value.cost === "number" && Number.isFinite(value.cost) ? ` $${value.cost.toPrecision(3)}` : "";
		const error = typeof value.error === "string" ? `\n${sanitizeToolText(value.error)}` : "";
		return `${icon} ${sanitizeToolText(value.name)}${args}${duration}${cost}${error}`;
	}).filter(Boolean).join("\n");
}

export const codemodeSection: DiamondSection = {
	summary: (view) => ({ title: "codemode", detail: callSummary(view) }),
	body(view) {
		const blocks: SectionBlock[] = [
			{ kind: "code", text: typeof view.args?.code === "string" ? view.args.code : "", language: "javascript" },
			{ kind: "text", text: nestedCalls(view.result?.details), tone: "muted" },
		];
		if (!view.isPartial) blocks.push({ kind: "text", text: extractResultText(view.result), tone: view.isError ? "error" : "output" });
		return blocks;
	},
};
