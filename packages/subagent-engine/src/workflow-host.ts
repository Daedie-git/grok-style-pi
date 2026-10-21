// Engine implementation of the Workflow host (plan §18): each script agent() call runs as a normal engine child under the
// session's current authorization, with Workflow's default denies, optional structured handback and an optional shell clamp.
import { defineTool, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ROOT_CALLER, type Engine } from "./engine.ts";
import type { WorkflowAgentRequest, WorkflowAgentResult } from "./workflow/host.ts";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** Workflow agents never delegate further or start workflows (dossier: default workflow-agent denies). */
export const WORKFLOW_AGENT_DENIES = ["Agent", "Workflow", "RunWorkflow", "SendUserMessage"];
const MAX_INVALID_STRUCTURED = 5;

interface StructuredCapture {
	value?: unknown;
	invalid: number;
	error?: string;
}

/** The handback tool for agent(prompt, {schema}): the result is the validated tool input, never parsed prose. */
function structuredOutputInstaller(schema: Record<string, unknown>, capture: StructuredCapture): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool(defineTool({
			name: STRUCTURED_OUTPUT_TOOL,
			label: "Structured Output",
			description: `Return your final result as structured data matching the required schema. Call this exactly once, when your work is complete. Expected result JSON schema:\n${JSON.stringify(schema)}`,
			// Pi validates transport parameters before execute. Keep them permissive
			// so missing or schema-invalid handbacks reach our bounded accounting.
			parameters: Type.Object({ result: Type.Optional(Type.Unknown()) }),
			execute: async (_toolCallId, params) => {
				if (capture.invalid >= MAX_INVALID_STRUCTURED) throw new Error("StructuredOutput is exhausted; no further handbacks are accepted.");
				const value = (params as { result: unknown }).result;
				if (!Value.Check(schema, value)) {
					capture.invalid++;
					const details = [...Value.Errors(schema, value)].slice(0, 5).map((issue) => `${issue.instancePath || "/"}: ${issue.message}`).join("; ");
					capture.error = `Invalid structured output: ${details}`;
					if (capture.invalid >= MAX_INVALID_STRUCTURED) return { content: [{ type: "text" as const, text: "Too many invalid attempts; stop now." }], details: {}, terminate: true };
					throw new Error(`${capture.error}. Fix it and call ${STRUCTURED_OUTPUT_TOOL} again.`);
				}
				capture.value = stripReservedKeys(value);
				capture.error = undefined;
				return { content: [{ type: "text" as const, text: "Result recorded. You are done." }], details: {}, terminate: true };
			},
		}));
		// A missing handback gets one nudge before the run settles (dossier: required handback with bounded retry).
		let nudged = false;
		pi.on("agent_before_settle", (event) => {
			if (capture.value !== undefined || capture.invalid >= MAX_INVALID_STRUCTURED || nudged || event.outcome !== "completed") return undefined;
			nudged = true;
			return { continue: true, entries: [{ type: "custom_message" as const, customType: "workflow-structured-nudge", display: false, content: `You have not called ${STRUCTURED_OUTPUT_TOOL}. Call it now with your result.` }] };
		});
	};
}

/** Host-reserved keys a model must not forge in structured results. */
function stripReservedKeys(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const copy = { ...(value as Record<string, unknown>) };
	delete copy.webFetchSavedFiles;
	return copy;
}

/** bashCommandClamp: shell commands must start with an allowed prefix; alternate shells and MCP routes are removed. */
function clampInstaller(prefixes: string[]): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			if (event.toolName === "powershell" || event.toolName.startsWith("mcp__")) return { block: true, reason: "Shell access is clamped for this workflow agent." };
			if (event.toolName !== "bash") return undefined;
			const command = String((event.input as { command?: unknown }).command ?? "");
			return prefixes.some((rule) => matchesBashRule(rule, command)) ? undefined : { block: true, reason: `Only these commands are allowed: ${prefixes.join(", ")}.` };
		});
	};
}

/** `Bash(cmd)` allows exactly cmd; `Bash(prefix:*)` allows prefix followed by nothing or a space. A bare rule is treated as Bash(rule). */
export function matchesBashRule(rule: string, command: string): boolean {
	// This is deliberately conservative, including inside quotes. A narrowed
	// shell grant must never authorize additional commands or substitutions.
	if (/[;&|`()<>\r\n]/.test(command)) return false;
	command = command.trim();
	const inner = /^Bash\((.*)\)$/s.exec(rule)?.[1] ?? rule;
	if (inner === "*" || inner === "") return inner === "*";
	if (inner.endsWith(":*")) {
		const prefix = inner.slice(0, -2);
		return command === prefix || command.startsWith(`${prefix} `);
	}
	return command === inner;
}

export async function runWorkflowAgent(engine: Engine, ctx: ExtensionContext, request: WorkflowAgentRequest): Promise<WorkflowAgentResult> {
	const capture: StructuredCapture = { invalid: 0 };
	const installers: ExtensionFactory[] = [];
	if (request.schema) installers.push(structuredOutputInstaller(request.schema, capture));
	const clamp = request.bashCommandClamp?.filter((prefix) => prefix.trim()) ?? [];
	if (clamp.length > 0) installers.push(clampInstaller(clamp));
	const extraDenied = [...WORKFLOW_AGENT_DENIES, ...(request.disallowedTools ?? []), ...(clamp.length > 0 ? ["powershell"] : [])];
	const result = await engine.spawn({
		description: request.label ?? `workflow agent ${request.logicalIndex}`,
		prompt: request.schema ? `${request.prompt}\n\nWhen finished, call ${STRUCTURED_OUTPUT_TOOL} with your result.` : request.prompt,
		subagent_type: request.agentType, model: request.model, effort: request.effort, isolation: request.isolation, run_in_background: false,
	}, ROOT_CALLER, { toolCallId: `wf:${request.runId}:${request.logicalIndex}:${request.attempt}`, signal: request.signal, ctx, origin: "model", internal: {
		extraDenied, installers, extraTools: request.schema ? [STRUCTURED_OUTPUT_TOOL] : [],
		// Pi ends a batch on terminate only when every sibling agrees; exhaustion ends the agent at the turn boundary
		// regardless of an ordinary sibling such as read (re-review RR05).
		shouldEndTurn: () => capture.invalid >= MAX_INVALID_STRUCTURED,
		workflow: { taskId: request.taskId, runId: request.runId, logicalIndex: request.logicalIndex, label: request.label, phase: request.phase },
	} });
	// Hold the workflow's permit/obligation until the child's own cleanup (stop hooks, worktree) finishes (plan §18.1 H1, M1).
	const spawnedId = (result.details as { agentId?: unknown } | undefined)?.agentId;
	if (typeof spawnedId === "string") await engine.teardown(spawnedId);
	if (capture.invalid >= MAX_INVALID_STRUCTURED) throw new Error(`StructuredOutput stopped after ${MAX_INVALID_STRUCTURED} invalid attempts. ${capture.error ?? "No valid result was returned."}`);
	const details = (result.details ?? {}) as { agentId?: string; status?: string; classification?: string; usage?: { billable?: { output?: number } }; resultText?: string; error?: string };
	const status = details.status === "completed" ? "completed" : details.status === "killed" ? "killed" : "failed";
	const out: WorkflowAgentResult = {
		status: details.agentId ? status : "failed",
		agentId: details.agentId ?? "",
		text: details.resultText ?? (result.isError ? "" : result.text),
		outputTokens: details.usage?.billable?.output ?? 0,
		stalled: details.classification === "stalled",
		error: details.agentId ? details.error : result.text,
	};
	if (request.schema) out.structured = capture.value !== undefined ? { ok: true, value: capture.value } : { ok: false, error: capture.error ?? `No ${STRUCTURED_OUTPUT_TOOL} result was returned.` };
	return out;
}
