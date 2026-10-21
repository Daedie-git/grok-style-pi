import type { HookRunResult } from "./runner.ts";

export type StopDecision = { kind: "allow" } | { kind: "prevent"; reason?: string } | { kind: "feedback"; messages: string[] };
interface Effects { blocks: string[]; context: string[]; diagnostics: string[] }

function effects(results: HookRunResult[]): Effects {
	const output: Effects = { blocks: [], context: [], diagnostics: [] };
	for (const [index, result] of results.entries()) {
		const label = `Hook ${index + 1}`;
		if (result.missingScript) { output.diagnostics.push(`${label}: missing hook script: ${result.stderr.trim()}`); continue; }
		if (result.timedOut) { output.diagnostics.push(`${label}: timed out`); continue; }
		// A genuine exit-2 block is not demoted by malformed stdout JSON.
		if (result.exitCode === 2) { output.blocks.push(result.stderr.trim() || "Blocked by hook"); continue; }
		if (result.jsonError) { output.diagnostics.push(`${label}: invalid JSON output: ${result.jsonError}`); continue; }
		if (result.exitCode !== 0) { output.diagnostics.push(`${label}: execution failed (exit ${result.exitCode ?? "unknown"}): ${result.stderr.trim()}`); continue; }
		const json = result.json;
		if (json?.decision === "block") output.blocks.push(typeof json.reason === "string" && json.reason.trim() ? json.reason : "Blocked by hook");
		const specific = json?.hookSpecificOutput;
		if (specific && typeof specific === "object" && !Array.isArray(specific)) {
			const context = (specific as Record<string, unknown>).additionalContext;
			if (typeof context === "string" && context.trim()) output.context.push(context);
		}
	}
	return output;
}

/** Pure blockable-phase decision. Reactions/cleanup must not use it to restart a model. */
export function decideStop(results: HookRunResult[]): { decision: StopDecision; diagnostics: string[] } {
	const evaluated = effects(results);
	const preventing = results.find((result) => result.json?.continue === false);
	if (preventing) {
		const reason = preventing.json?.stopReason;
		return { decision: { kind: "prevent", ...(typeof reason === "string" ? { reason } : {}) }, diagnostics: evaluated.diagnostics };
	}
	const messages = [...evaluated.blocks, ...evaluated.context];
	return { decision: messages.length ? { kind: "feedback", messages } : { kind: "allow" }, diagnostics: evaluated.diagnostics };
}

export function decideStart(results: HookRunResult[]): { contextMessages: string[]; diagnostics: string[] } {
	const evaluated = effects(results);
	if (results.some((result) => result.json?.continue === false)) evaluated.diagnostics.push("SubagentStart prevention is ignored; start hooks cannot veto launch");
	return { contextMessages: [...evaluated.blocks, ...evaluated.context], diagnostics: evaluated.diagnostics };
}

export function decideTask(results: HookRunResult[]): { block?: string; diagnostics: string[] } {
	const evaluated = effects(results);
	return { ...(evaluated.blocks.length ? { block: evaluated.blocks.join("\n\n") } : {}), diagnostics: evaluated.diagnostics };
}

/** One instance per run. Call only after the coordinator's maxTurns check succeeds. */
export class StopLoopState {
	private readonly cap: number;
	private active = false;
	private consecutive = 0;
	constructor(cap?: number) {
		const configured = cap ?? (process.env.PI_STOP_HOOK_BLOCK_CAP?.trim() ? Number(process.env.PI_STOP_HOOK_BLOCK_CAP) : 8);
		this.cap = Number.isSafeInteger(configured) ? configured : 8;
	}
	get stopHookActive(): boolean { return this.active; }
	onFeedbackRetry(): { allowed: boolean; warning?: string } {
		if (this.cap > 0 && this.consecutive >= this.cap) return { allowed: false, warning: `Stop hook feedback retry cap (${this.cap}) exceeded; accepting completion` };
		this.consecutive++;
		this.active = true;
		return { allowed: true };
	}
	onToolTurn(): void { this.consecutive = 0; }
}

export function stopInput(common: Record<string, unknown>, extra: { agentId: string; agentType: string; transcriptPath: string; lastAssistantMessage: string; stopHookActive: boolean; backgroundWork?: string[] }): Record<string, unknown> {
	return {
		...common, hook_event_name: "SubagentStop", agent_id: extra.agentId, agent_type: extra.agentType,
		agent_transcript_path: extra.transcriptPath, last_assistant_message: extra.lastAssistantMessage,
		stop_hook_active: extra.stopHookActive, ...(extra.backgroundWork === undefined ? {} : { background_work: [...extra.backgroundWork] }),
	};
}
export function startInput(common: Record<string, unknown>, extra: { agentId: string; agentType: string }): Record<string, unknown> {
	return { ...common, hook_event_name: "SubagentStart", agent_id: extra.agentId, agent_type: extra.agentType };
}
export function taskInput(common: Record<string, unknown>, task: { id: string; subject: string; description: string }): Record<string, unknown> {
	const { teammate_name: _teammate, team_name: _team, ...fields } = common;
	return { ...fields, task_id: task.id, task_subject: task.subject, task_description: task.description };
}
