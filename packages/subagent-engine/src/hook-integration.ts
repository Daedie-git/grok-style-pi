// Wires the hook modules into runs: SubagentStart before launch, the blockable SubagentStop loop at each child's
// pre-settle boundary, the interrupted-run fallback, and TaskCreated/TaskCompleted vetoes (plan §9, §17.16).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadHooks, matching } from "./hooks/config.ts";
import { decideStart, decideStop, decideTask, startInput, StopLoopState, stopInput, taskInput } from "./hooks/decide.ts";
import { runHook, type HookRunResult } from "./hooks/runner.ts";
import type { TaskHooks } from "./tasks/store.ts";
import type { AgentDefinition, AgentMeta, HookConfig, HookEventName } from "./types.ts";

export const STOP_FEEDBACK_TYPE = "subagent-stop-feedback";
const FALLBACK_TIMEOUT_MS = 5000;

export interface HookEnvironment {
	agentDir: string;
	projectTrusted: boolean;
	env: Record<string, string | undefined>;
}

function common(meta: Pick<AgentMeta, "rootSessionId" | "cwd" | "sessionFile">, event: HookEventName): Record<string, unknown> {
	return { session_id: meta.rootSessionId, cwd: meta.cwd, transcript_path: meta.sessionFile, hook_event_name: event };
}

async function runAll(config: HookConfig, event: HookEventName, matchValue: string | undefined, input: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<HookRunResult[]> {
	const commands = matching(config, event, matchValue);
	return Promise.all(commands.map((command) => runHook(command, input, { cwd, signal })));
}

/** Session/user/project hooks only: a child's own definition hooks are registered after its start hooks run. */
export async function runStartHooks(environment: HookEnvironment, meta: AgentMeta): Promise<{ contextMessages: string[]; diagnostics: string[] }> {
	const { config, diagnostics } = loadHooks({ agentDir: environment.agentDir, cwd: meta.cwd, projectTrusted: environment.projectTrusted });
	const results = await runAll(config, "SubagentStart", meta.agentType, startInput(common(meta, "SubagentStart"), { agentId: meta.agentId, agentType: meta.agentType }), meta.cwd);
	if (results.length === 0) return { contextMessages: [], diagnostics };
	const decided = decideStart(results);
	return { contextMessages: decided.contextMessages, diagnostics: [...diagnostics, ...decided.diagnostics] };
}

export interface StopLoopBindings {
	meta: () => AgentMeta | undefined;
	currentRunId: () => string | undefined;
	/** Whether another model turn is still within the run's turn budget. */
	turnAllowed: () => boolean;
	/** Clear queued input back into the durable inbox and fence the run against further turns. */
	prevent: (reason?: string) => void;
	markAttempted: (runId: string) => void;
	/** The run's own cancellation signal; Pi's ctx.signal has ended by the pre-settle boundary. */
	runSignal: (runId: string) => AbortSignal | undefined;
	diagnostics: (messages: string[]) => void;
}

/** Child-side blockable SubagentStop loop (plan §9): block or additionalContext → continue; continue:false → prevent. */
export function installStopHooks(pi: ExtensionAPI, environment: HookEnvironment, bindings: StopLoopBindings): void {
	let state: { runId: string; loop: StopLoopState } | undefined;
	const loopFor = (runId: string) => {
		if (state?.runId !== runId) state = { runId, loop: new StopLoopState(cap(environment.env)) };
		return state.loop;
	};
	pi.on("turn_end", (event) => {
		const runId = bindings.currentRunId();
		const message = event.message as { content?: { type?: string }[] } | undefined;
		if (runId && message?.content?.some((block) => block.type === "toolCall")) loopFor(runId).onToolTurn();
		return undefined;
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		const meta = bindings.meta();
		const runId = bindings.currentRunId();
		if (!meta || !runId || event.outcome !== "completed") return undefined;
		const { config, diagnostics } = loadHooks({ agentDir: environment.agentDir, cwd: meta.cwd, projectTrusted: environment.projectTrusted, definition: hookableDefinition(meta.definition) });
		if (diagnostics.length > 0) bindings.diagnostics(diagnostics);
		if (matching(config, "SubagentStop", meta.agentType).length === 0) return undefined;
		bindings.markAttempted(runId);
		const loop = loopFor(runId);
		const results = await runAll(config, "SubagentStop", meta.agentType, stopInput(common(meta, "SubagentStop"), {
			agentId: meta.agentId, agentType: meta.agentType, transcriptPath: meta.sessionFile,
			lastAssistantMessage: lastAssistantText(event.context.contextMessages), stopHookActive: loop.stopHookActive,
		}), meta.cwd, bindings.runSignal(runId) ?? ctx.signal);
		const { decision, diagnostics: decisionDiagnostics } = decideStop(results);
		if (decisionDiagnostics.length > 0) bindings.diagnostics(decisionDiagnostics);
		if (decision.kind === "prevent") {
			bindings.prevent(decision.reason);
			return { continue: false };
		}
		if (decision.kind !== "feedback") return undefined;
		// maxTurns is checked before the hook cap.
		if (!bindings.turnAllowed()) return undefined;
		const retry = loop.onFeedbackRetry();
		if (!retry.allowed) {
			if (retry.warning) bindings.diagnostics([retry.warning]);
			return undefined;
		}
		return {
			continue: true,
			entries: [{ type: "custom_message" as const, customType: STOP_FEEDBACK_TYPE, display: true, content: `Stop hook feedback:\n\n${decision.messages.join("\n\n")}`, details: { runId } }],
		};
	});
}

/** Interrupted-run fallback: run SubagentStop once, bounded, ignoring any block or continue signal (plan §9, A4). */
export async function runInterruptedStopHooks(environment: HookEnvironment, meta: AgentMeta, lastAssistantMessage: string): Promise<void> {
	const { config } = loadHooks({ agentDir: environment.agentDir, cwd: meta.cwd, projectTrusted: environment.projectTrusted, definition: hookableDefinition(meta.definition) });
	if (matching(config, "SubagentStop", meta.agentType).length === 0) return;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
	try {
		await runAll(config, "SubagentStop", meta.agentType, stopInput(common(meta, "SubagentStop"), {
			agentId: meta.agentId, agentType: meta.agentType, transcriptPath: meta.sessionFile, lastAssistantMessage, stopHookActive: false,
		}), meta.cwd, controller.signal);
	} catch {} finally {
		clearTimeout(timer);
	}
}

/** TaskCreated / TaskCompleted adapters for the shared task store (plan §17.5). */
export function taskHooks(environment: HookEnvironment, rootMeta: () => Pick<AgentMeta, "rootSessionId" | "cwd" | "sessionFile">): TaskHooks {
	const veto = async (event: "TaskCreated" | "TaskCompleted", task: { id: string; subject: string; description: string }) => {
		const meta = rootMeta();
		const { config } = loadHooks({ agentDir: environment.agentDir, cwd: meta.cwd, projectTrusted: environment.projectTrusted });
		const results = await runAll(config, event, undefined, taskInput(common(meta, event), task), meta.cwd);
		if (results.length === 0) return {};
		const { block } = decideTask(results);
		return block ? { block } : {};
	};
	return {
		created: (task) => veto("TaskCreated", task),
		completed: (before) => veto("TaskCompleted", before),
	};
}

function hookableDefinition(definition: AgentDefinition): AgentDefinition | undefined {
	return definition.source === "package" ? undefined : definition;
}

function cap(env: Record<string, string | undefined>): number | undefined {
	const value = env.PI_STOP_HOOK_BLOCK_CAP;
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function lastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; content?: { type?: string; text?: string }[] };
		if (message?.role !== "assistant") continue;
		const text = (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
		if (text) return text;
	}
	return "";
}
