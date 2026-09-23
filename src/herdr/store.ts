import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RunRef, RunSnapshot, ExecutionEvent } from "./state.ts";
import type { StoreOperations } from "./worker.ts";

export type { RunRef, RunSnapshot, ExecutionEvent } from "./state.ts";

export interface HerdrTask {
	id: string;
	herdrName: string;
	paneId: string;
	type: string;
	description: string;
	prompt: string;
	instructions?: string;
	allowedTools?: string[];
	maxTurns?: number;
	depth: number;
	model?: string;
	thinking?: string;
	parentPaneId?: string;
	createdAt: string;
}

export interface AgentRecord extends HerdrTask {
	currentRunId: string;
	/** A pane alone is not an execution identity. Only this session may attach. */
	sessionFile: string;
	sessionId?: string;
}

export type LaunchStage = "reserved" | "creating" | "pane-created" | "starting-pi" | "published" | "cleanup" | "closed" | "ambiguous";

export interface LaunchRecord extends RunRef {
	stage: LaunchStage;
	owner: string;
	tabId?: string;
	paneId?: string;
	direction?: "right" | "down";
	error?: string;
	updatedAt: number;
}

export interface Command extends RunRef {
	id: string;
	type: "prompt" | "steer" | "abort";
	text: string;
	state: "queued" | "dispatching" | "delivered";
}

export interface ChildBinding {
	agent: AgentRecord;
	token: string;
	run: RunSnapshot;
	ambiguous: boolean;
}

export interface CompletionNotice extends RunRef {
	id: string;
	agent: AgentRecord;
	run: RunSnapshot;
}

export function herdrSubagentRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "grok-style-pi", "herdr-subagents");
}

/** SQLite and all lock contention live in a worker, never in Pi's rendering thread. */
export class HerdrStore {
	private worker: Worker;
	private sequence = 0;
	private closed = false;
	private failure?: Error;
	private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

	constructor(root: string) {
		this.worker = new Worker(new URL("./worker-entry.mjs", import.meta.url), {
			workerData: { root }, execArgv: [],
		});
		this.worker.on("message", (reply: { id: number; value?: unknown; error?: string }) => {
			const pending = this.pending.get(reply.id);
			if (!pending) return;
			this.pending.delete(reply.id);
			if (reply.error) pending.reject(new Error(reply.error));
			else pending.resolve(reply.value);
			if (this.pending.size === 0) this.worker.unref();
		});
		const fail = (error: Error) => {
			this.failure ??= error;
			for (const pending of this.pending.values()) pending.reject(this.failure);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", () => fail(new Error("Herdr control worker closed")));
		this.worker.unref();
	}

	private call<K extends keyof StoreOperations>(operation: K, ...args: Parameters<StoreOperations[K]>): Promise<ReturnType<StoreOperations[K]>> {
		if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error("Herdr store closed"));
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.worker.ref();
			this.worker.postMessage({ id, operation, args });
		});
	}

	assertProtocolReady() { return this.call("assertProtocolReady"); }
	reserveAgent(task: HerdrTask, sessionFile: string, owner: string, now: number) { return this.call("reserveAgent", task, sessionFile, owner, now); }
	findAgent(id: string) { return this.call("findAgent", id); }
	agentForSession(paneId: string, sessionFile: string) { return this.call("agentForSession", paneId, sessionFile); }
	claimMaintenance(token: string, now: number) { return this.call("claimMaintenance", token, now); }
	activeRuns() { return this.call("activeRuns"); }
	finishMaintenance(token: string, observations: Array<{ ref: RunRef; alive: boolean }>, now: number) { return this.call("finishMaintenance", token, observations, now); }
	listAgents() { return this.call("listAgents"); }
	read(ref: RunRef) { return this.call("read", ref); }
	beginRun(agentId: string, previousRunId: string, prompt: string, notify: boolean, now: number) { return this.call("beginRun", agentId, previousRunId, prompt, notify, now); }
	publish(ref: RunRef, prompt: string, notify: boolean, now: number) { return this.call("publish", ref, prompt, notify, now); }
	steer(ref: RunRef, text: string) { return this.call("steer", ref, text); }
	requestCancellation(ref: RunRef, now: number) { return this.call("requestCancellation", ref, now); }
	expireUnacceptedRun(ref: RunRef, now: number) { return this.call("expireUnacceptedRun", ref, now); }
	recordPaneClosed(ref: RunRef, now: number) { return this.call("recordPaneClosed", ref, now); }
	attach(paneId: string, sessionFile: string, sessionId: string) { return this.call("attach", paneId, sessionFile, sessionId); }
	claimNextCommand(agentId: string, token: string, streaming: boolean) { return this.call("claimNextCommand", agentId, token, streaming); }
	commandDelivered(command: Command, token: string) { return this.call("commandDelivered", command, token); }
	authorizeInput(ref: RunRef, commandId: string, token: string) { return this.call("authorizeInput", ref, commandId, token); }
	recordExecutionEvent(ref: RunRef, token: string, event: ExecutionEvent, now: number) { return this.call("recordExecutionEvent", ref, token, event, now); }
	recoverableLaunches() { return this.call("recoverableLaunches"); }
	launches() { return this.call("launches"); }
	recordLaunch(ref: RunRef, owner: string, stage: LaunchStage, facts: { paneId?: string; tabId?: string; direction?: "right" | "down"; error?: string }, now: number) { return this.call("recordLaunch", ref, owner, stage, facts, now); }
	claimLaunchRecovery(ref: RunRef, previousOwner: string, owner: string, now: number) { return this.call("claimLaunchRecovery", ref, previousOwner, owner, now); }
	failLaunch(ref: RunRef, owner: string, error: string, stopped: boolean, now: number) { return this.call("failLaunch", ref, owner, error, stopped, now); }
	notices(parentPaneId: string) { return this.call("notices", parentPaneId); }
	acknowledgeNotice(runId: string) { return this.call("acknowledgeNotice", runId); }
	retireOwner(owner: string) { return this.call("retireOwner", owner); }
	ownerRetired(owner: string) { return this.call("ownerRetired", owner); }
	releasePlacement(ref: RunRef) { return this.call("releasePlacement", ref); }
	tryPlacementLock(owner: string) { return this.call("tryPlacementLock", owner); }
	releasePlacementLock(owner: string) { return this.call("releasePlacementLock", owner); }

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.worker.terminate();
	}
}
