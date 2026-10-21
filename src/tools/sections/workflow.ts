import { extractResultText } from "../diamond.ts";
import type { DiamondSection } from "../section.ts";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

export const workflowSection: DiamondSection = {
	summary(view) {
		const data = object(view.result?.details);
		const name = text(data?.workflowName) ?? text(view.args?.name) ?? text(view.args?.title) ?? "workflow";
		const launched = !view.isError && Boolean(text(data?.taskId) && text(data?.runId)) && !data?.error && !data?.notLaunched;
		return {
			title: `Workflow · ${name} · ${view.result ? launched ? data?.runId : "not launched" : "launching"}`,
			filePath: text(data?.scriptPath) ?? text(view.args?.scriptPath), errorPrefix: false,
		};
	},
	body(view) {
		if (view.isPartial || !view.result) return [];
		const data = object(view.result.details);
		const launched = !view.isError && Boolean(text(data?.taskId) && text(data?.runId)) && !data?.error && !data?.notLaunched;
		if (!launched) return [{ kind: "text", text: extractResultText(view.result), tone: "error" }];
		return [{ kind: "text", text: [
			text(data?.summary),
			`Script: ${text(data?.scriptPath) ?? "(not provided)"}`,
			`Task: ${data?.taskId}`,
			`Transcripts: ${text(data?.transcriptDir) ?? "(not provided)"}`,
			`Resume: use Workflow with this scriptPath and resumeFromRunId: ${data?.runId} after the earlier task has stopped and settled.`,
		].filter(Boolean).join("\n") }];
	},
};
