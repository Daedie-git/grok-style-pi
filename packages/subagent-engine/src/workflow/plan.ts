import { stripVTControlCharacters } from "node:util";
import type { WorkflowMeta } from "./meta.ts";
import { defaultConcurrency } from "./permits.ts";

export interface WorkflowLimits { maxCalls: number; concurrency: number }

/** The approval and runner use the same caps; a script can narrow, never widen, its host's limits. */
export function workflowLimits(meta: WorkflowMeta | undefined, env: Record<string, string | undefined>, host: Partial<WorkflowLimits> = {}): WorkflowLimits {
	return {
		maxCalls: Math.min(1000, host.maxCalls ?? 1000, meta?.maxAgents ?? 1000),
		concurrency: Math.min(host.concurrency ?? defaultConcurrency(env), meta?.maxConcurrency ?? 256),
	};
}

const line = (value: string, limit: number) => stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/** Human-readable intent, not JavaScript. The full immutable source is an optional separate view. */
export function workflowApproval(meta: WorkflowMeta, limits: WorkflowLimits, path?: string): string {
	const phases = meta.phases.slice(0, 12).map((phase, index) => `${index + 1}. ${line(phase.title, 100)}${phase.detail ? ` — ${line(phase.detail, 180)}` : ""}`);
	if (meta.phases.length > phases.length) phases.push(`… ${meta.phases.length - phases.length} more phases (see source).`);
	return [
		`Run workflow "${line(meta.title ?? meta.name, 100)}"?`,
		line(meta.description, 600),
		phases.length ? `Plan:\n${phases.join("\n")}` : "",
		`Agents: up to ${limits.maxCalls} agent tasks; at most ${limits.concurrency} at once.${meta.maxAgents === undefined ? "\nNo task count declared; the host limit applies." : ""}`,
		"Agents use this session's tools and permissions. The plan is supplied by the workflow.",
		path ? `Source: ${line(path, 300)}` : "",
	].filter(Boolean).join("\n\n");
}
