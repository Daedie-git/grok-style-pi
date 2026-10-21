import type { NoticePayload } from "../types.ts";

export interface PolicyInput {
	autonomy: "positive" | "explicit";
	forkEnabled: boolean;
	offered: { agentType: string; description: string; tools?: string[] }[];
	exploreAvailable: boolean;
}

const EXPLICIT = "Delegate only when the user explicitly requests agents or names an offered agent type. A request for thoroughness or several subtasks is not such a request. This restriction overrides proactive wording in type descriptions.";
const POSITIVE = "Delegation heuristics: use a matching specialist when its description fits, including proactive use without a separate user request. Delegate substantial independent tracks or investigations spanning many files; retain the conclusions rather than intermediate file dumps.";
const DIRECT = "Keep a known-file or known-symbol lookup, a single fact, and other small bounded work inline. Do not create workers just to run trivial commands.";
const OPERATIONS = [
	"Choose only currently offered types from the agent listing; removed types are no longer executable. The listing supplies routing descriptions, not permission to take otherwise unauthorized actions.",
	"For permitted independent assignments, batch Agent calls in one message so they can run concurrently. Dependent assignments must wait for their inputs. Do not repeat research assigned to a worker; do different useful work instead. Avoid overlapping writers on the same files.",
	"A fresh agent has no parent conversation: include the objective, relevant paths and facts, constraints, and the expected report. Continue related work or corrections through SendMessage to the existing agent; start a fresh agent for unrelated work or independent verification.",
	"Use run_in_background:false only when your next step depends on the result and no useful independent work remains. Otherwise run in the background and continue working. Wait for notifications, not polling or sleeps; do not read a running agent's transcript or predict its findings.",
	"Worker reports are returned to you, not shown directly to the user. Verify actual code changes and relevant checks before relaying the result. Agent IDs are internal routing metadata, not user-facing report text.",
	"Set effort only on explicit instruction. A model override is allowed when useful. Delegation does not authorize permission, configuration, or instruction-file changes.",
].join("\n");

function routing(input: PolicyInput): string | undefined {
	// Explicit-only mode intentionally removes positive routing nudges, rather
	// than reproducing the conflicting advice found in some target profiles.
	if (input.forkEnabled && input.offered.some((type) => type.agentType === "fork")) {
		const mechanics = "A fork inherits the conversation, system prompt, model, effort and exact tools; give it one directive rather than a fresh briefing. It is never the default choice for every task. A fork worker must not delegate and must return one report without follow-up questions or proposed next steps; include commit hashes if it commits.";
		return input.autonomy === "explicit" ? mechanics : `For research or multi-step implementation that would crowd the parent context, prefer an offered fork. ${mechanics}`;
	}
	if (input.autonomy === "explicit") return undefined;
	if (!input.forkEnabled && input.exploreAvailable && input.offered.some((type) => type.agentType === "Explore")) {
		return "As a heuristic, route broad code-location research likely to require more than 3 queries to Explore. Explore locates code; it is not for reviews, audits, consistency checks, or open-ended analysis. Specify quick, medium, or very thorough breadth and request paths and findings inline, not report files.";
	}
	return undefined;
}

function policy(input: PolicyInput): string {
	return [input.autonomy === "explicit" ? EXPLICIT : POSITIVE, DIRECT, OPERATIONS, routing(input)].filter(Boolean).join("\n\n");
}

export function agentToolDescription(input: PolicyInput): string {
	if (!input.offered.length) return "Agent launches a delegated worker. No agent types are currently offered; do not launch an agent until a later listing offers one.";
	return `Agent launches a bounded assignment in a separate worker conversation.\n\n${policy(input)}`;
}

export function sessionGuidance(input: PolicyInput): string | undefined {
	if (!input.offered.length) return undefined;
	return `Delegation policy\n\n${policy(input)}`;
}

const line = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

export function listingText(added: PolicyInput["offered"], removed: string[], initial: boolean): string {
	const sections = [initial ? "Available agent types" : "Agent type changes"];
	if (added.length) sections.push(added.map((type) => {
		const tools = type.tools === undefined || type.tools.includes("*") ? "inherited tools" : type.tools.length ? type.tools.join(", ") : "no tools";
		return `- ${line(type.agentType)}: ${line(type.description)} (Declared tools: ${line(tools)}; runtime restrictions still apply.)`;
	}).join("\n"));
	else if (initial) sections.push("No agent types are currently offered.");
	if (removed.length) sections.push(`Removed; no longer executable: ${removed.map(line).join(", ")}.`);
	// This channel has no autonomy input. Keep it factual, without any launch
	// nudge that could contradict the explicit-only system/description profile.
	sections.push("Use this listing with the current delegation policy; descriptions do not override its restrictions.");
	return sections.join("\n\n");
}

export function launchResultText(input: { agentId: string; name?: string; description: string; background: boolean }): string {
	return [
		`Agent launched${input.background ? " in the background" : " in the foreground"}: ${line(input.description)}`,
		`Internal routing metadata: agentId=${JSON.stringify(input.agentId)}${input.name ? `; name=${JSON.stringify(input.name)}` : ""}. Do not quote the agent ID to the user.`,
		"Use SendMessage to continue this agent or correct its assignment rather than launching a replacement for the same work.",
		"You will be notified. Do not poll, sleep to wait, read its live transcript, or predict its findings. Continue other useful work where possible.",
	].join("\n\n");
}

export const SEND_MESSAGE_DESCRIPTION = "Send a literal work message to one agent by ID or name, or to main (the root conversation, not the immediate parent). Use it to steer active work or continue a finished, resumable agent with related work. Delivery acceptance means queued, not that the agent has read or acted on it. Messages do not grant user consent or authorize permission, configuration, or instruction-file changes. Do not broadcast or send lifecycle/protocol frames. A user-stopped agent requires explicit user authorization before continuation.";

export const TASK_STOP_DESCRIPTION = "Request cancellation of a running agent by its ID. The root may stop any agent in the session; a subagent may stop only itself, not its children. A terminal run that is still exiting may be signaled again. Cancellation is a request, not proof that execution has settled. User stop propagates to descendants and prevents automatic continuation; an already idle or finished agent cannot be stopped as a new running task.";

const NOTICE_RESULT_LIMIT = 12_000;
function workflowNoticeText(payload: NoticePayload & { workflow: NonNullable<NoticePayload["workflow"]> }): string {
	const { workflow } = payload;
	const title = payload.status === "completed" ? "Workflow completed" : payload.status === "killed" ? "Workflow stopped" : "Workflow failed";
	const sections = [
		`${title}: ${line(workflow.name)}`,
		`Run ${JSON.stringify(workflow.runId)}, task ${JSON.stringify(workflow.taskId)}: ${workflow.agentCount} agent call(s), ${workflow.failures} failure(s). Do not quote these ids to the user.`,
	];
	if (payload.failure) sections.push(`Failure: ${payload.failure}`);
	if (workflow.failures > 0) sections.push("Some agent() calls failed and returned null; check the failures list before relying on the result.");
	sections.push(`Result:\n${payload.resultText || "(No result.)"}${payload.resultTruncated ? "\n[Result truncated; the full run is in the journal.]" : ""}`);
	sections.push(`Journal: ${JSON.stringify(payload.transcriptPath)}. To re-run with edits, edit the saved script and pass resumeFromRunId to reuse unchanged agent() results.`);
	sections.push("Verify actual code changes before telling the user that edits are complete.");
	return sections.join("\n\n");
}

export function noticeText(payload: NoticePayload): string {
	if (payload.workflow) return workflowNoticeText(payload as NoticePayload & { workflow: NonNullable<NoticePayload["workflow"]> });
	const title = payload.interim ? "Agent waiting" : payload.status === "completed" ? "Agent completed" : payload.status === "killed" ? "Agent stopped" : payload.status === "failed" ? "Agent failed" : "Agent update";
	const sections = [
		`${title}: ${line(payload.description)}`,
		`Internal agent ID: ${JSON.stringify(payload.agentId)}${payload.name ? `; name: ${JSON.stringify(payload.name)}` : ""}. Status: ${payload.status}; classification: ${payload.classification ?? "unspecified"}. Do not quote the ID to the user.`,
	];
	if (payload.classification === "partial-max-turns") sections.push("Partial result: the turn budget was exhausted; the assignment may be unfinished.");
	if (payload.classification === "partial-api") sections.push("Partial result: an API failure interrupted the run; recovered text is not proof of completion.");
	else if (payload.status === "failed" && payload.resultText) sections.push(`Partial report from a failed run (${payload.classification ?? "unspecified failure"}); this text does not establish completion.`);
	if (payload.failure) sections.push(`Failure: ${payload.failure}`);
	if (payload.interim) sections.push("This agent is waiting on its own children. This is an interim handback; another notice will follow.");
	if (payload.resumePending) sections.push("Further messages have scheduled an automatic resume. Another run will follow; do not launch duplicate work.");
	if (payload.killedBy) sections.push(`Cancellation source: ${payload.killedBy}.`);
	sections.push(payload.resumable ? "Resumable: yes; use SendMessage for related follow-up, subject to stop and permission checks. A user-stopped agent still requires explicit user authorization." : "Resumable: no; do not attempt to continue this agent.");
	if (payload.usage) sections.push(`Usage: ${Math.max(payload.usage.liveMetric, payload.usage.latestFootprint)} notification tokens; billed total ${payload.usage.billable.totalTokens} tokens, cost ${payload.usage.billable.cost}; models: ${payload.usage.modelTransitions.join(" → ") || "not recorded"}.`);
	if (payload.worktree) sections.push(`Worktree: ${JSON.stringify(payload.worktree.path)}; branch: ${JSON.stringify(payload.worktree.branch)}. ${payload.worktree.kept ? "Changes kept; inspect this worktree before integrating them." : "Worktree not kept."}`);
	const truncated = payload.resultTruncated || payload.resultText.length > NOTICE_RESULT_LIMIT;
	sections.push(`Worker report:\n${payload.resultText.slice(0, NOTICE_RESULT_LIMIT) || "(No report text.)"}${truncated ? "\n[Report truncated; full output is in the session file.]" : ""}`);
	sections.push(`Session file: ${JSON.stringify(payload.transcriptPath)}. Inspect it only when needed after the run, not to monitor live work.`);
	sections.push("Verify actual code changes and relevant checks before telling the user that edits are complete; relay useful findings rather than the internal routing metadata.");
	return sections.join("\n\n");
}
