import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactArgs, extractResultText } from "./diamond.ts";
import { plainText, type Activity } from "./activity-ui.ts";

export type AgentInvocation = {
	modelName?: string; modelId?: string; thinking?: string;
	requestedThinking?: string; requestedModel?: string;
};
export type AgentRecord = {
	status: string; startedAt?: number; completedAt?: number; result?: string; error?: string;
	session?: Pick<AgentSession, "state" | "subscribe"> & Partial<Pick<AgentSession, "abort" | "model" | "thinkingLevel">>;
	invocation?: AgentInvocation;
};

const labelText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Effective model and thinking level. The live session wins; the spawn invocation is the fallback. */
export function subagentRuntimeLabel(record: Pick<AgentRecord, "session" | "invocation">): string | undefined {
	const invocation = record.invocation;
	const sessionModel = record.session?.model;
	const name = labelText(sessionModel?.name) ?? labelText(sessionModel?.id) ?? labelText(invocation?.modelName) ?? labelText(invocation?.modelId);
	const modelId = labelText(sessionModel?.id) ?? labelText(invocation?.modelId);
	const requestedModel = labelText(invocation?.requestedModel);
	const model = name && requestedModel && requestedModel !== name && requestedModel !== modelId ? `${name} (asked ${requestedModel})` : name;
	const thinking = labelText(record.session?.thinkingLevel) ?? labelText(invocation?.thinking);
	const requestedThinking = labelText(invocation?.requestedThinking);
	const level = thinking && requestedThinking && requestedThinking !== thinking ? `${thinking} (asked ${requestedThinking})` : thinking;
	const label = [model, level].filter(Boolean).join(" · ");
	const clean = label ? plainText(label).replace(/\s+/g, " ").trim() : "";
	return clean || undefined;
}
export type RunStatus = "queued" | "running" | "stopping" | "completed" | "error" | "stopped";
export type RunIdentity = Readonly<{ agentId: string; sequence: number; startedAt?: number }>;
type Bus = ExtensionAPI["events"];
type AgentEvent = { id: string; type?: string; description?: string; status?: string; result?: string; error?: string };
type Run = {
	identity: RunIdentity; status: RunStatus; activity: Activity;
	session?: AgentRecord["session"]; unsubscribe?: () => void;
	liveMessage?: unknown; tools: Map<string, { label: string; output: string }>;
	lastUser?: WeakRef<object>; cancelled: boolean; rpcAllowed: boolean; completedAt?: number; result?: string; error?: string;
};
const active = (status: RunStatus) => status === "queued" || status === "running" || status === "stopping";
const statusOf = (value: string): RunStatus => value === "failed" ? "error" : value === "aborted" ? "stopped" : value === "steered" ? "completed" :
	["queued", "running", "stopping", "completed", "error", "stopped"].includes(value) ? value as RunStatus : "error";
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const string = (value: unknown) => typeof value === "string" ? value : undefined;

export function agentRecord(id: string): AgentRecord | undefined {
	const registry = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
	const get = object(registry)?.getRecord;
	if (typeof get !== "function") return;
	const record = get.call(registry, id) as unknown;
	if (typeof object(record)?.status !== "string") return;
	return record as AgentRecord;
}

function messageText(message: unknown): string {
	const msg = object(message);
	if (!msg) return "";
	const content = string(msg.content) ?? (Array.isArray(msg.content) ? msg.content.map((value: unknown) => {
		const block = object(value);
		if (!block) return "";
		if (block.type === "toolCall") return `${string(block.name) ?? "tool"} ${compactArgs(object(block.arguments), 500)}`;
		return string(block.text) ?? string(block.thinking) ?? "";
	}).filter(Boolean).join("\n") : "");
	return content ? `${string(msg.role) ?? "activity"}${msg.toolName ? ` · ${String(msg.toolName)}` : ""}\n${content}` : "";
}

/** One owner for run identity, registry reconciliation, subscriptions and cancellation.
 * Events discover agents; registry snapshots are authoritative when available.
 * Each new run invalidates callbacks and Stop closures from the previous run.
 */
export class SubagentAdapter {
	private runs = new Map<string, Run>();
	private sequence = 0;
	private disposed = false;
	private listeners: (() => void)[] = [];
	private pendingStops = new Set<() => void>();
	private bus: Bus;
	private lookup: (id: string) => AgentRecord | undefined;
	private publish: (entry: Activity, newRun: boolean) => void;
	constructor(bus: Bus, lookup: (id: string) => AgentRecord | undefined, publish: (entry: Activity, newRun: boolean) => void) {
		this.bus = bus; this.lookup = lookup; this.publish = publish;
		for (const [event, status] of [["created", "queued"], ["started", "running"], ["completed", "completed"], ["failed", "error"]] as const) {
			this.listeners.push(bus.on(`subagents:${event}`, (data: unknown) => this.observe(data, status)));
		}
	}
	identity(agentId: string) { return this.runs.get(agentId)?.identity; }
	private current(run: Run) { return !this.disposed && this.runs.get(run.identity.agentId) === run; }
	private observe(value: unknown, fallback: RunStatus) {
		const data = object(value);
		if (typeof data?.id !== "string" || this.disposed) return;
		const event: AgentEvent = { id: data.id, type: string(data.type), description: string(data.description), status: string(data.status), result: string(data.result), error: string(data.error) };
		const record = this.lookup(event.id);
		const existing = this.runs.get(event.id);
		// A late created event must not regress a started run without a registry.
		const status = !record && fallback === "queued" && existing?.status === "running" ? "running" : statusOf(event.status ?? fallback);
		this.reconcile(event.id, record ?? { status, result: event.result, error: event.error }, event);
	}
	poll(): boolean {
		let changed = false;
		for (const id of this.runs.keys()) {
			const record = this.lookup(id);
			if (record) changed = this.reconcile(id, record) || changed;
		}
		return changed;
	}
	private reconcile(id: string, record: AgentRecord, event?: AgentEvent): boolean {
		let run = this.runs.get(id);
		const status = statusOf(record.status);
		const lastUser = record.session?.state.messages.findLast((message) => message.role === "user");
		const newRun = !run || (record.startedAt !== undefined && run.identity.startedAt !== undefined && record.startedAt !== run.identity.startedAt)
			|| (!active(run.status) && (active(status) || (lastUser !== undefined && lastUser !== run.lastUser?.deref())));
		if (newRun) {
			const old = run;
			old?.unsubscribe?.();
			const identity = Object.freeze({ agentId: id, sequence: ++this.sequence, startedAt: record.startedAt });
			const title = event ? `${event.type || "Agent"}: ${event.description || id}` : old?.activity.title ?? `Agent: ${id}`;
			// Keep the viewer's Activity object stable; identity and callbacks belong to the run.
			const activity = old?.activity ?? { id: `agent:${id}`, kind: "agent" as const, title, status, startedAt: 0, output: "" };
			Object.assign(activity, { title, status, startedAt: record.startedAt ?? Date.now(), endedAt: undefined, output: "", transcript: undefined, detail: undefined, stop: undefined });
			run = { identity, status, activity, tools: new Map(), lastUser: lastUser ? new WeakRef(lastUser) : undefined, cancelled: false, rpcAllowed: !old, session: record.session };
			this.runs.set(id, run);
		}
		if (!run) return false;
		if (run.identity.startedAt === undefined && record.startedAt !== undefined) {
			run.identity = Object.freeze({ ...run.identity, startedAt: record.startedAt });
		}
		run.lastUser = lastUser ? new WeakRef(lastUser) : undefined;
		const result = (record.result ?? event?.result ?? (!newRun ? run.result : undefined))?.slice(-64000);
		const error = (record.error ?? event?.error ?? (!newRun ? run.error : undefined))?.slice(-64000);
		const runtime = subagentRuntimeLabel(record);
		const previous = run.status;
		const effective = run.cancelled && !active(status) ? "stopped" : run.status === "stopping" && active(status) ? "stopping" : status;
		const changed = newRun || previous !== effective || run.completedAt !== record.completedAt || run.result !== result || run.error !== error || run.activity.model !== runtime;
		if (!changed && !active(effective)) return false;
		run.status = effective; run.completedAt = record.completedAt; run.result = result; run.error = error;
		run.activity.status = effective;
		run.activity.model = runtime;
		run.activity.startedAt = record.startedAt ?? run.activity.startedAt;
		run.activity.endedAt = record.completedAt;
		if (record.session && run.session !== record.session) { run.unsubscribe?.(); run.unsubscribe = undefined; run.session = record.session; }
		if (active(effective)) {
			const current = run;
			run.activity.stop = run.session?.abort || run.rpcAllowed || effective === "queued" ? () => this.stop(current) : undefined;
			this.subscribe(run);
			run.activity.transcript = () => this.transcript(current);
		} else {
			const diagnostic = error ?? "";
			const text = this.transcript(run) || result || "";
			run.activity.output = (diagnostic && !text.includes(diagnostic) ? `${text}\n${diagnostic}` : text).slice(-64000);
			run.activity.transcript = undefined; run.activity.detail = undefined; run.activity.stop = undefined;
			run.activity.endedAt ??= Date.now();
			run.unsubscribe?.(); run.unsubscribe = undefined; run.tools.clear(); run.liveMessage = undefined; run.session = undefined;
		}
		if (changed) this.publish(run.activity, newRun);
		return changed;
	}
	private transcript(run: Run): string {
		return [...(run.session?.state.messages.slice(-100).map(messageText) ?? []),
			...(run.liveMessage ? [messageText(run.liveMessage)] : []),
			...[...run.tools.values()].map((tool) => `${tool.label}\n${tool.output}`)].filter(Boolean).join("\n\n");
	}
	private subscribe(run: Run) {
		if (!run.session || run.unsubscribe) return;
		run.unsubscribe = run.session.subscribe((event) => {
			if (!this.current(run)) return;
			if (event.type === "message_update") run.liveMessage = event.message;
			if (event.type === "message_end") run.liveMessage = undefined;
			if (event.type === "tool_execution_start") run.tools.set(event.toolCallId, { label: `${event.toolName} ${compactArgs(event.args)}`, output: "" });
			if (event.type === "tool_execution_update") run.tools.set(event.toolCallId, {
				label: run.tools.get(event.toolCallId)?.label ?? event.toolName, output: extractResultText(event.partialResult).slice(-64000),
			});
			if (event.type === "tool_execution_end") run.tools.delete(event.toolCallId);
			run.activity.detail = [...run.tools.values()].at(-1)?.label;
			this.publish(run.activity, false);
		});
	}
	private async stop(run: Run) {
		this.poll();
		if (!this.current(run) || !active(run.status)) throw new Error("This run has ended; refresh activity before stopping another run.");
		if (run.status === "stopping") return;
		const previous = run.status;
		run.status = "stopping"; run.activity.status = "stopping"; this.publish(run.activity, false);
		try {
			if (previous !== "queued" && run.session?.abort) await run.session.abort();
			else await this.stopRpc(run.identity.agentId);
			if (!this.current(run)) return;
			run.cancelled = true;
			this.poll();
		} catch (error) {
			if (this.current(run) && run.status === "stopping") { run.status = previous; run.activity.status = previous; this.publish(run.activity, false); }
			throw error;
		}
	}
	private stopRpc(agentId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const requestId = randomUUID();
			let timer: ReturnType<typeof setTimeout>;
			const finish = (error?: Error) => { clearTimeout(timer); unsubscribe(); this.pendingStops.delete(cancel); error ? reject(error) : resolve(); };
			const cancel = () => finish(new Error("Session closed."));
			const unsubscribe = this.bus.on(`subagents:rpc:stop:reply:${requestId}`, (value: unknown) => {
				const reply = object(value);
				finish(reply?.success === true ? undefined : new Error(string(reply?.error) ?? "Could not stop subagent."));
			});
			timer = setTimeout(() => finish(new Error("Subagent extension did not respond to Stop.")), 5000); timer.unref?.();
			this.pendingStops.add(cancel);
			try { this.bus.emit("subagents:rpc:stop", { requestId, agentId }); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
		});
	}
	forget(activityId: string) { const id = activityId.replace(/^agent:/, ""); this.runs.get(id)?.unsubscribe?.(); this.runs.delete(id); }
	dispose() {
		this.disposed = true;
		for (const cancel of [...this.pendingStops]) cancel();
		for (const unsubscribe of this.listeners) unsubscribe();
		for (const run of this.runs.values()) run.unsubscribe?.();
		this.runs.clear(); this.listeners = [];
	}
}
