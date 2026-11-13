import type { AgentSnapshot, EngineEvent } from "../../packages/subagent-engine/src/engine.ts";
import type { WorkflowSnapshot } from "../../packages/subagent-engine/src/workflow-tool.ts";
import type { WorkflowProgress } from "../../packages/subagent-engine/src/workflow/host.ts";
import { plainText, type Activity } from "../activity/ui.ts";

type AgentState = "queued" | "running" | "cached" | "done" | "failed";
type Slot = { index: number; label?: string; phase?: string; state: AgentState; agentId?: string; attempt?: number; startedAt?: number; endedAt?: number; tokens?: number; output?: number; earlierOutput?: number };
type Workflow = {
	taskId: string; runId: string; activity: Activity; slots: Map<number, Slot>; phases: Map<string, number>;
	logs: string; children: string; logTail: string; childTail: string; terminal: boolean;
	outline: string; outlineDirty: boolean;
};
type Child = { taskId: string; workflowRunId: string; logicalIndex: number; runId: string };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const line = (value: string) => plainText(value).replace(/\s+/g, " ").trim();

/** A single activity projection per workflow task, including its attributed child events. */
export class WorkflowActivities {
	private readonly workflows = new Map<string, Workflow>();
	private readonly children = new Map<string, Child>();
	private readonly forgotten = new Set<string>();
	private disposed = false;
	private readonly stopWorkflow?: (taskId: string) => boolean | void | Promise<boolean | void>;
	private readonly publish: (entry: Activity, newRun: boolean, streaming?: boolean) => void;
	private readonly outlineBuilt?: (slotCount: number) => void;
	constructor(stopWorkflow: WorkflowActivities["stopWorkflow"], publish: WorkflowActivities["publish"], diagnostics?: { outlineBuilt(slotCount: number): void }) {
		this.stopWorkflow = stopWorkflow; this.publish = publish; this.outlineBuilt = diagnostics?.outlineBuilt;
	}
	private ensure(taskId: string, runId: string, name?: string): Workflow | undefined {
		if (this.disposed || this.forgotten.has(taskId)) return;
		let workflow = this.workflows.get(taskId);
		if (workflow && workflow.runId !== runId) return;
		if (!workflow) {
			const activity: Activity = { id: `workflow:${taskId}`, kind: "workflow", title: `◆ Workflow · ${line(name ?? taskId)}`, status: "running", startedAt: Date.now(), output: "" };
			workflow = { taskId, runId, activity, slots: new Map(), phases: new Map(), logs: "", children: "", logTail: "", childTail: "", terminal: false, outline: "", outlineDirty: true };
			this.workflows.set(taskId, workflow);
			const current = workflow;
			activity.transcript = () => activity.output;
			if (this.stopWorkflow) activity.stop = () => this.stop(current);
			this.refresh(workflow, true);
		} else if (name) workflow.activity.title = `◆ Workflow · ${line(name)}`;
		return workflow;
	}
	/** Receipts supply the display name absent from progress events; never revive an already settled task. */
	receipt(details: unknown): void {
		const data = object(details);
		if (typeof data?.taskId !== "string" || !data.taskId || typeof data.runId !== "string" || !data.runId || data.error || data.notLaunched) return;
		const previous = this.workflows.get(data.taskId);
		const oldTitle = previous?.activity.title;
		const workflow = this.ensure(data.taskId, data.runId, typeof data.workflowName === "string" ? data.workflowName : undefined);
		if (workflow && previous && workflow.activity.title !== oldTitle) this.refresh(workflow);
	}
	private slot(workflow: Workflow, next: Slot): boolean {
		const previous = workflow.slots.get(next.index);
		next = { ...previous, ...next };
		if (previous && previous.label === next.label && previous.phase === next.phase && previous.state === next.state && previous.agentId === next.agentId && previous.attempt === next.attempt
			&& previous.startedAt === next.startedAt && previous.endedAt === next.endedAt && previous.tokens === next.tokens && previous.output === next.output && previous.earlierOutput === next.earlierOutput) return false;
		workflow.slots.set(next.index, next);
		workflow.outlineDirty = true;
		return true;
	}
	/** Tail work is bounded independently of the historical slot outline. */
	private tail(workflow: Workflow, kind: "logs" | "children", text: string): boolean {
		const raw = (workflow[kind] + text).slice(-16000);
		if (raw === workflow[kind]) return false;
		workflow[kind] = raw;
		const projected = plainText(raw);
		const field = kind === "logs" ? "logTail" : "childTail";
		if (projected === workflow[field]) return false;
		workflow[field] = projected;
		return true;
	}
	child(meta: Pick<AgentSnapshot, "agentId" | "workflow" | "startedAt" | "usage"> & Partial<Pick<AgentSnapshot, "running" | "status" | "endedAt">>, runId: string): void {
		const provenance = meta.workflow;
		if (!provenance) return;
		const workflow = this.ensure(provenance.taskId, provenance.runId);
		if (!workflow || workflow.terminal) return;
		this.children.set(meta.agentId, { taskId: provenance.taskId, workflowRunId: provenance.runId, logicalIndex: provenance.logicalIndex, runId });
		const previous = workflow.slots.get(provenance.logicalIndex);
		const sameAgent = previous?.agentId === meta.agentId;
		const finished = meta.running === false;
		if (this.slot(workflow, {
			index: provenance.logicalIndex, label: provenance.label ?? previous?.label, phase: provenance.phase ?? previous?.phase,
			state: finished ? meta.status === "completed" ? "done" : "failed" : "running", agentId: meta.agentId, attempt: provenance.attempt,
			startedAt: meta.startedAt ?? (sameAgent ? previous?.startedAt : undefined) ?? (finished ? undefined : Date.now()), endedAt: finished ? meta.endedAt : undefined,
			tokens: meta.usage?.latestFootprint ?? (sameAgent ? previous?.tokens : undefined) ?? 0,
			output: meta.usage?.billable.output ?? (sameAgent ? previous?.output : undefined) ?? 0,
			// Reattachment replays each attempt's agent in turn; a replaced one keeps its output in the total.
			earlierOutput: previous?.agentId !== undefined && !sameAgent ? (previous.earlierOutput ?? 0) + (previous.output ?? 0) : previous?.earlierOutput,
		})) this.refresh(workflow, false, true);
	}
	/** Restore logical call states after hydrating child-run metrics; a completed child can still fail its workflow call. */
	restore(snapshot: WorkflowSnapshot): void {
		const workflow = this.ensure(snapshot.taskId, snapshot.runId, snapshot.name);
		if (!workflow || workflow.terminal) return;
		workflow.activity.startedAt = snapshot.startedAt;
		for (const progress of snapshot.progress) this.progress(workflow, progress, true);
		this.refresh(workflow);
	}
	private progress(workflow: Workflow, progress: WorkflowProgress, restoring = false): boolean {
		if (progress.type === "phase") {
			if (workflow.phases.get(progress.title) === progress.index) return false;
			workflow.phases.set(progress.title, progress.index);
			workflow.outlineDirty = true;
			return true;
		}
		if (progress.type === "log") return this.tail(workflow, "logs", progress.message + "\n");
		const previous = workflow.slots.get(progress.logicalIndex);
		const newAttempt = progress.attempt !== undefined && previous?.attempt !== undefined
			? progress.attempt !== previous.attempt
			: progress.state === "start" && ((progress.agentId !== undefined && previous?.agentId !== undefined && progress.agentId !== previous.agentId)
				|| (!restoring && previous?.state !== "running"));
		if (newAttempt && previous?.agentId) this.children.delete(previous.agentId);
		return this.slot(workflow, {
			index: progress.logicalIndex, label: progress.label ?? previous?.label, phase: progress.phase ?? previous?.phase,
			state: progress.state === "start" ? "running" : progress.state, agentId: progress.agentId ?? (newAttempt ? undefined : previous?.agentId),
			attempt: progress.attempt ?? (newAttempt ? undefined : previous?.attempt),
			startedAt: newAttempt ? undefined : previous?.startedAt, tokens: newAttempt ? 0 : previous?.tokens, output: newAttempt ? 0 : previous?.output,
			// Output a retried call generated before stays in the workflow's total.
			earlierOutput: newAttempt ? (previous?.earlierOutput ?? 0) + (previous?.output ?? 0) : previous?.earlierOutput,
			endedAt: progress.state === "done" || progress.state === "failed" ? (newAttempt ? undefined : previous?.endedAt) ?? Date.now() : newAttempt ? undefined : previous?.endedAt,
		});
	}
	observe(event: EngineEvent): boolean {
		if (event.type === "workflow-progress" || event.type === "workflow-settled") {
			const workflow = this.ensure(event.taskId, event.runId);
			if (!workflow) return true;
			if (event.type === "workflow-settled") {
				const status = event.status === "killed" || event.status === "stopped" ? "stopped" : event.status === "completed" ? "completed" : "failed";
				if (workflow.terminal && workflow.activity.status === status) return true;
				workflow.terminal = true;
				workflow.activity.status = status;
				workflow.activity.endedAt = Date.now(); workflow.activity.stop = undefined; workflow.activity.transcript = undefined;
				this.refresh(workflow);
			} else if (!workflow.terminal && this.progress(workflow, event.event)) this.refresh(workflow, false, true);
			return true;
		}
		if (event.type === "spawned" && event.meta.workflow) {
			const run = event.meta.runs.find((run) => run.runId === event.runId);
			this.child({ ...event.meta, startedAt: run?.startedAt, usage: run?.usage }, event.runId);
			return true;
		}
		if (!("agentId" in event)) return false;
		const child = this.children.get(event.agentId);
		if (!child) return false;
		const workflow = this.workflows.get(child.taskId);
		if (!workflow || workflow.runId !== child.workflowRunId || ("runId" in event && event.runId !== child.runId)) return true;
		let text = "", changed = false;
		if (event.type === "diagnostics") text = event.messages.join("\n");
		else if (event.type === "run-event") {
			if (event.event.type === "text") text = event.event.delta;
			else if (event.event.type === "tool") text = `${event.event.toolName} · ${event.event.phase}`;
			else if (event.event.type === "usage") {
				const slot = workflow.slots.get(child.logicalIndex);
				if (slot?.agentId === event.agentId && slot.endedAt === undefined && !workflow.terminal) changed = this.slot(workflow, { ...slot, tokens: event.event.usage.latestFootprint, output: event.event.usage.billable.output });
			}
		} else if (event.type === "settled") {
			const slot = workflow.slots.get(child.logicalIndex);
			if (slot?.agentId === event.agentId && !workflow.terminal) changed = this.slot(workflow, {
				...slot, state: event.outcome.status === "completed" ? "done" : "failed", endedAt: slot.endedAt ?? Date.now(), tokens: event.outcome.usage.latestFootprint, output: event.outcome.usage.billable.output,
			});
			text = event.outcome.error ?? event.outcome.resultText;
		}
		if (text) changed = this.tail(workflow, "children", `[${line(event.agentId)}] ${text}\n`) || changed;
		if (changed) this.refresh(workflow, false, event.type === "run-event");
		return true;
	}
	private refresh(workflow: Workflow, newRun = false, streaming = false): void {
		if (workflow.outlineDirty) this.outline(workflow);
		workflow.activity.output = [workflow.outline, workflow.logTail ? `\nLog tail\n${workflow.logTail}` : "", workflow.childTail ? `\nChild transcript tail\n${workflow.childTail}` : ""].filter(Boolean).join("\n");
		this.publish(workflow.activity, newRun, streaming);
	}
	private outline(workflow: Workflow): void {
		const slots = [...workflow.slots.values()].sort((a, b) => a.index - b.index);
		const count = (state: AgentState) => slots.filter((slot) => slot.state === state).length;
		const summary = `${count("done")}/${slots.length} done · ${count("cached")} cached · ${count("failed")} failed`;
		workflow.activity.detail = summary;
		workflow.activity.children = slots.map((slot) => ({
			title: line(slot.label ?? `agent() #${slot.index}`), status: slot.state,
			startedAt: slot.startedAt, endedAt: slot.endedAt, tokens: slot.tokens ?? 0, output: (slot.earlierOutput ?? 0) + (slot.output ?? 0),
		}));
		const groups = new Map<string, Slot[]>();
		for (const slot of slots) { const phase = slot.phase ?? "Ungrouped"; const group = groups.get(phase) ?? []; group.push(slot); groups.set(phase, group); }
		for (const phase of workflow.phases.keys()) if (!groups.has(phase)) groups.set(phase, []);
		const rows: string[] = [summary];
		for (const [phase, agents] of [...groups].sort(([a], [b]) => (workflow.phases.get(a) ?? Infinity) - (workflow.phases.get(b) ?? Infinity))) {
			rows.push(`\n${workflow.phases.has(phase) ? `Phase ${workflow.phases.get(phase)} · ` : ""}${line(phase)}`);
			for (const slot of agents) rows.push(`  ${line(slot.label ?? `agent() #${slot.index}`)} · ${slot.state}${slot.agentId ? ` · ${line(slot.agentId)}` : ""}`);
		}
		let outline = rows.join("\n");
		if (outline.length > 30000) outline = outline.slice(0, 29950) + "\n[More workflow rows omitted]";
		workflow.outline = outline;
		workflow.outlineDirty = false;
		this.outlineBuilt?.(slots.length);
	}
	private async stop(workflow: Workflow): Promise<void> {
		if (this.disposed || this.workflows.get(workflow.taskId) !== workflow || workflow.terminal) throw new Error("This workflow has ended; refresh activity before stopping it.");
		if (workflow.activity.status === "stopping") return;
		workflow.activity.status = "stopping"; this.refresh(workflow);
		try {
			if (await this.stopWorkflow?.(workflow.taskId) === false) throw new Error("The workflow is no longer running.");
		} catch (error) {
			if (!workflow.terminal && !this.disposed) { workflow.activity.status = "running"; this.refresh(workflow); }
			throw error;
		}
	}
	forget(activityId: string): void {
		if (!activityId.startsWith("workflow:")) return;
		const id = activityId.slice("workflow:".length);
		this.forgotten.add(id);
		this.workflows.delete(id);
		for (const [agentId, child] of this.children) if (child.taskId === id) this.children.delete(agentId);
	}
	dispose(): void { this.disposed = true; this.workflows.clear(); this.children.clear(); this.forgotten.clear(); }
}
