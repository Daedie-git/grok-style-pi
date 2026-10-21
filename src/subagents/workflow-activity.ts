import type { AgentSnapshot, EngineEvent } from "../../packages/subagent-engine/src/engine.ts";
import { plainText, type Activity } from "../activity/ui.ts";

type AgentState = "queued" | "running" | "cached" | "done" | "failed";
type Slot = { index: number; label?: string; phase?: string; state: AgentState; agentId?: string };
type Workflow = {
	taskId: string; runId: string; activity: Activity; slots: Map<number, Slot>; phases: Map<string, number>;
	logs: string; children: string; terminal: boolean;
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
	constructor(stopWorkflow: WorkflowActivities["stopWorkflow"], publish: WorkflowActivities["publish"]) {
		this.stopWorkflow = stopWorkflow; this.publish = publish;
	}
	private ensure(taskId: string, runId: string, name?: string): Workflow | undefined {
		if (this.disposed || this.forgotten.has(taskId)) return;
		let workflow = this.workflows.get(taskId);
		if (workflow && workflow.runId !== runId) return;
		if (!workflow) {
			const activity: Activity = { id: `workflow:${taskId}`, kind: "workflow", title: `◆ Workflow · ${line(name ?? taskId)}`, status: "running", startedAt: Date.now(), output: "" };
			workflow = { taskId, runId, activity, slots: new Map(), phases: new Map(), logs: "", children: "", terminal: false };
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
		const workflow = this.ensure(data.taskId, data.runId, typeof data.workflowName === "string" ? data.workflowName : undefined);
		if (workflow) this.refresh(workflow);
	}
	child(meta: Pick<AgentSnapshot, "agentId" | "workflow">, runId: string): void {
		const provenance = meta.workflow;
		if (!provenance) return;
		const workflow = this.ensure(provenance.taskId, provenance.runId);
		if (!workflow || workflow.terminal) return;
		this.children.set(meta.agentId, { taskId: provenance.taskId, workflowRunId: provenance.runId, logicalIndex: provenance.logicalIndex, runId });
		const previous = workflow.slots.get(provenance.logicalIndex);
		workflow.slots.set(provenance.logicalIndex, { index: provenance.logicalIndex, ...previous, label: provenance.label ?? previous?.label, phase: provenance.phase ?? previous?.phase, state: "running", agentId: meta.agentId });
		this.refresh(workflow, false, true);
	}
	observe(event: EngineEvent): boolean {
		if (event.type === "workflow-progress" || event.type === "workflow-settled") {
			const workflow = this.ensure(event.taskId, event.runId);
			if (!workflow) return true;
			if (event.type === "workflow-settled") {
				workflow.terminal = true;
				workflow.activity.status = event.status === "killed" || event.status === "stopped" ? "stopped" : event.status === "completed" ? "completed" : "failed";
				workflow.activity.endedAt = Date.now(); workflow.activity.stop = undefined; workflow.activity.transcript = undefined;
				this.refresh(workflow);
			} else if (!workflow.terminal) {
				const progress = event.event;
				if (progress.type === "phase") workflow.phases.set(progress.title, progress.index);
				else if (progress.type === "log") workflow.logs = (workflow.logs + progress.message + "\n").slice(-16000);
				else {
					const previous = workflow.slots.get(progress.logicalIndex);
					workflow.slots.set(progress.logicalIndex, {
						index: progress.logicalIndex, label: progress.label ?? previous?.label, phase: progress.phase ?? previous?.phase,
						state: progress.state === "start" ? "running" : progress.state, agentId: progress.agentId ?? previous?.agentId,
					});
				}
				this.refresh(workflow, false, true);
			}
			return true;
		}
		if (event.type === "spawned" && event.meta.workflow) { this.child(event.meta, event.runId); return true; }
		if (!("agentId" in event)) return false;
		const child = this.children.get(event.agentId);
		if (!child) return false;
		const workflow = this.workflows.get(child.taskId);
		if (!workflow || workflow.runId !== child.workflowRunId || ("runId" in event && event.runId !== child.runId)) return true;
		let text = "";
		if (event.type === "diagnostics") text = event.messages.join("\n");
		else if (event.type === "run-event") {
			if (event.event.type === "text") text = event.event.delta;
			else if (event.event.type === "tool") text = `${event.event.toolName} · ${event.event.phase}`;
		} else if (event.type === "settled") {
			const slot = workflow.slots.get(child.logicalIndex);
			if (slot?.agentId === event.agentId && !workflow.terminal) slot.state = event.outcome.status === "completed" ? "done" : "failed";
			text = event.outcome.error ?? event.outcome.resultText;
		}
		if (text) workflow.children = (workflow.children + `[${line(event.agentId)}] ${text}\n`).slice(-16000);
		this.refresh(workflow, false, event.type === "run-event");
		return true;
	}
	private refresh(workflow: Workflow, newRun = false, streaming = false): void {
		const slots = [...workflow.slots.values()].sort((a, b) => a.index - b.index);
		const count = (state: AgentState) => slots.filter((slot) => slot.state === state).length;
		const summary = `${count("done")}/${slots.length} done · ${count("cached")} cached · ${count("failed")} failed`;
		workflow.activity.detail = summary;
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
		workflow.activity.output = [outline, workflow.logs ? `\nLog tail\n${plainText(workflow.logs)}` : "", workflow.children ? `\nChild transcript tail\n${plainText(workflow.children)}` : ""].filter(Boolean).join("\n");
		this.publish(workflow.activity, newRun, streaming);
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
