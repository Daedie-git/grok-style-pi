import type { AgentSnapshot, EngineEvent } from "../../packages/subagent-engine/src/engine.ts";
import { plainText, type Activity } from "../activity/ui.ts";
import { WorkflowActivities } from "./workflow-activity.ts";

export interface ActivityEngine {
	/** Detached public snapshots restore already-running entries after an engine handover. */
	agentSnapshots(): AgentSnapshot[];
	subscribe(listener: (event: EngineEvent) => void): () => void;
	userStop(agentId: string): Promise<void>;
	userStopWorkflow?(taskId: string): boolean | void | Promise<boolean | void>;
}
export type RunIdentity = Readonly<{ agentId: string; runId: string }>;
type Run = { identity: RunIdentity; activity: Activity; tools: Map<string, string>; retired: Set<string> };
const active = (entry: Activity) => entry.status === "running" || entry.status === "stopping";

export function subagentRuntimeLabel(snapshot: Pick<AgentSnapshot, "model" | "effort">): string | undefined {
	const label = [snapshot.model, snapshot.effort].filter(Boolean).join(" · ");
	return plainText(label).replace(/\s+/g, " ").trim() || undefined;
}

/** Public snapshots hydrate entries; events track changes. No child-session ownership or registry access. */
export class SubagentAdapter {
	private readonly runs = new Map<string, Run>();
	private readonly unsubscribe: () => void;
	private readonly workflows: WorkflowActivities;
	private disposed = false;
	private readonly engine: ActivityEngine;
	private readonly publish: (entry: Activity, newRun: boolean, streaming?: boolean) => void;
	constructor(engine: ActivityEngine, publish: (entry: Activity, newRun: boolean, streaming?: boolean) => void) {
		this.engine = engine; this.publish = publish;
		this.workflows = new WorkflowActivities(engine.userStopWorkflow?.bind(engine), publish);
		this.unsubscribe = engine.subscribe((event) => this.observe(event));
		for (const snapshot of engine.agentSnapshots()) {
			if (snapshot.running && snapshot.runId) {
				if (snapshot.workflow) this.workflows.child(snapshot, snapshot.runId);
				else this.begin(snapshot.agentId, snapshot.runId, snapshot);
			}
		}
	}
	workflowReceipt(details: unknown): void { this.workflows.receipt(details); }
	identity(agentId: string): RunIdentity | undefined { return this.runs.get(agentId)?.identity; }
	private current(run: Run): boolean { return !this.disposed && this.runs.get(run.identity.agentId) === run; }
	private begin(agentId: string, runId: string, snapshot?: Pick<AgentSnapshot, "agentType" | "description" | "startedAt" | "model" | "effort">): Run | undefined {
		const previous = this.runs.get(agentId);
		if (previous?.identity.runId === runId) return previous;
		if (previous?.retired.has(runId)) return;
		if (!snapshot && !previous) return;
		const activity: Activity = previous?.activity ?? { id: `agent:${agentId}`, kind: "agent", title: "", status: "running", startedAt: Date.now(), output: "" };
		Object.assign(activity, { status: "running", startedAt: snapshot?.startedAt ?? Date.now(), endedAt: undefined, output: "", detail: undefined });
		if (snapshot) { activity.title = `${snapshot.agentType}: ${snapshot.description}`; activity.model = subagentRuntimeLabel(snapshot); }
		const retired = new Set(previous?.retired);
		if (previous) retired.add(previous.identity.runId);
		const run: Run = { identity: Object.freeze({ agentId, runId }), activity, tools: new Map(), retired };
		this.runs.set(agentId, run);
		activity.transcript = () => activity.output;
		activity.stop = () => this.stop(run);
		this.publish(activity, true);
		return run;
	}
	private append(run: Run, text: string): void { run.activity.output = (run.activity.output + text).slice(-64000); }
	private observe(event: EngineEvent): void {
		if (this.disposed || this.workflows.observe(event)) return;
		if (event.type === "workflow-progress" || event.type === "workflow-settled") return;
		if (event.type === "spawned") {
			const meta = event.meta;
			this.begin(event.agentId, event.runId, {
				agentType: meta.agentType, description: meta.description, model: meta.model?.effective, effort: meta.effort?.effective,
				startedAt: meta.runs.find((run) => run.runId === event.runId)?.startedAt,
			});
			return;
		}
		let run = this.runs.get(event.agentId);
		if (event.type === "diagnostics") {
			if (!run) return;
			this.append(run, `\n${event.messages.join("\n")}`);
			this.publish(run.activity, false);
			return;
		}
		if (event.type === "run-event" && event.event.type === "started") run = this.begin(event.agentId, event.runId);
		if (!run || run.identity.runId !== event.runId) return;
		if (event.type === "settled") {
			if (event.outcome.resultText && !run.activity.output.includes(event.outcome.resultText)) this.append(run, `\n${event.outcome.resultText}`);
			if (event.outcome.error && !run.activity.output.includes(event.outcome.error)) this.append(run, `\n${event.outcome.error}`);
			run.activity.status = event.outcome.status === "killed" ? "stopped" : event.outcome.status;
			run.activity.endedAt = Date.now();
			run.activity.stop = undefined; run.activity.transcript = undefined; run.activity.detail = undefined;
			run.tools.clear();
			this.publish(run.activity, false);
		} else if (event.type === "run-event" && active(run.activity)) {
			const change = event.event;
			if (change.type === "text") this.append(run, change.delta);
			else if (change.type === "tool") {
				if (change.phase === "start") run.tools.set(change.toolCallId, change.toolName);
				else run.tools.delete(change.toolCallId);
				this.append(run, `\n${change.toolName} · ${change.phase === "start" ? "running" : change.isError ? "failed" : "finished"}\n`);
				run.activity.detail = [...run.tools.values()].at(-1);
			} else return;
			this.publish(run.activity, false, true);
		}
	}
	private async stop(run: Run): Promise<void> {
		if (!this.current(run) || !active(run.activity)) throw new Error("This run has ended; refresh activity before stopping another run.");
		if (run.activity.status === "stopping") return;
		run.activity.status = "stopping"; this.publish(run.activity, false);
		try { await this.engine.userStop(run.identity.agentId); }
		catch (error) {
			if (this.current(run) && run.activity.status === "stopping") { run.activity.status = "running"; this.publish(run.activity, false); }
			throw error;
		}
	}
	forget(activityId: string): void { this.runs.delete(activityId.replace(/^agent:/, "")); this.workflows.forget(activityId); }
	dispose(): void { this.disposed = true; this.unsubscribe(); this.runs.clear(); this.workflows.dispose(); }
}
