import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RunRef, RunSnapshot, ExecutionEvent } from "./state.ts";
import type { StoreOperations } from "./worker.ts";

export type { RunRef, RunSnapshot, ExecutionEvent } from "./state.ts";

export interface HerdrTask {
	/** Missing on existing records means Pi. */
	runtime?: "pi" | "claude-code";
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
	/** Grid column in a runner-created tab; set only on launches placed by column. */
	column?: "left" | "right";
	workspaceId?: string;
	error?: string;
	updatedAt: number;
}

export type LaunchFacts = Partial<Pick<LaunchRecord, "paneId" | "tabId" | "direction" | "column" | "workspaceId" | "error">>;

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

/** Raised whenever the parent and a remote worker would disagree on store operations; both ends must match. */
export const HERDR_REMOTE_PROTOCOL = 1;

export function herdrSubagentRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "grok-style-pi", "herdr-subagents");
}

interface StoreRequest { id: number; operation: string; args: unknown[] }
interface StoreReply { id: number; value?: unknown; error?: string }

/** Carries store requests to the process that owns the SQLite files. Replies may arrive in any order. */
export interface StoreChannel {
	post(request: StoreRequest): void;
	/** Keeps the Pi process alive only while calls are pending. */
	hold(active: boolean): void;
	close(): Promise<void>;
}

export interface StoreEvents {
	reply(reply: StoreReply): void;
	fail(error: Error): void;
}

export type StoreChannelFactory = (events: StoreEvents) => StoreChannel;

/** SQLite and all lock contention live in a worker, never in Pi's rendering thread. */
export function workerChannel(root: string): StoreChannelFactory {
	return (events) => {
		const worker = new Worker(new URL("./worker-entry.mjs", import.meta.url), {
			// node:sqlite is required here; its experimental notice otherwise overwrites Pi's UI.
			// Scope suppression to this database worker, never the parent Pi process.
			workerData: { root }, execArgv: ["--disable-warning=ExperimentalWarning", "--disable-warning=UNDICI-EHPA"],
		});
		worker.on("message", events.reply);
		worker.on("error", events.fail);
		worker.on("exit", () => events.fail(new Error("Herdr control worker closed")));
		worker.unref();
		return {
			post: (request) => worker.postMessage(request),
			hold: (active) => { if (active) worker.ref(); else worker.unref(); },
			close: async () => { await worker.terminate(); },
		};
	};
}

/**
 * Runs the same store worker on another machine, one JSON request or reply per line over SSH stdio.
 * The remote SQLite files stay authoritative for agents running there; closing the channel ends the
 * remote process, which also releases any placement lock it held.
 */
export function sshChannel(options: { target: string; node?: string; entry: string; root?: string }): StoreChannelFactory {
	return (events) => {
		const remote = [options.node ?? "node", "--disable-warning=ExperimentalWarning", "--disable-warning=UNDICI-EHPA", options.entry, ...(options.root ? [options.root] : [])];
		const child = spawn("ssh", [
			"-T", "-o", "BatchMode=yes",
			// A half-open connection must close the channel, or pending calls and a held placement lock hang.
			"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
			"--", options.target, remote.map(shellQuote).join(" ")], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		let closing = false;
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
		createInterface({ input: child.stdout }).on("line", (line) => {
			let reply: StoreReply;
			try { reply = JSON.parse(line) as StoreReply; }
			catch { return; } // Login banners and shell noise are not replies.
			if (typeof reply?.id === "number") events.reply(reply);
		});
		child.on("error", events.fail);
		child.on("close", (code) => {
			if (!closing) events.fail(new Error(`Herdr control channel to ${options.target} closed (${code ?? "signal"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
		});
		child.stdin.on("error", () => undefined);
		const handles = [child, child.stdin, child.stdout, child.stderr] as Array<{ ref?(): void; unref?(): void }>;
		const hold = (active: boolean) => { for (const handle of handles) active ? handle.ref?.() : handle.unref?.(); };
		hold(false);
		return {
			post: (request) => { child.stdin.write(JSON.stringify(request) + "\n"); },
			hold,
			close: async () => {
				closing = true;
				if (child.exitCode !== null || child.signalCode !== null) return;
				const closed = new Promise((resolve) => child.once("close", resolve));
				child.stdin.end();
				const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
				await closed;
				clearTimeout(timer);
			},
		};
	};
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export class HerdrStore {
	private channel: StoreChannel;
	private sequence = 0;
	private closed = false;
	private failure?: Error;
	private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

	constructor(source: string | StoreChannelFactory) {
		this.channel = (typeof source === "string" ? workerChannel(source) : source)({
			reply: (reply) => {
				const pending = this.pending.get(reply.id);
				if (!pending) return;
				this.pending.delete(reply.id);
				if (reply.error) pending.reject(new Error(reply.error));
				else pending.resolve(reply.value);
				if (this.pending.size === 0) this.channel.hold(false);
			},
			fail: (error) => {
				this.failure ??= error;
				for (const pending of this.pending.values()) pending.reject(this.failure);
				this.pending.clear();
				this.channel?.hold(false);
			},
		});
	}

	private call<K extends keyof StoreOperations>(operation: K, ...args: Parameters<StoreOperations[K]>): Promise<ReturnType<StoreOperations[K]>> {
		if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error("Herdr store closed"));
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.channel.hold(true);
			this.channel.post({ id, operation, args });
		});
	}

	get failed(): boolean { return this.failure !== undefined; }

	assertProtocolReady() { return this.call("assertProtocolReady"); }
	remoteProtocol() { return this.call("remoteProtocol"); }
	directoryStatus(path: string) { return this.call("directoryStatus", path); }
	createSession(header: Record<string, unknown>, copyFrom?: string) { return this.call("createSession", header, copyFrom); }
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
	claudeBinding(agentId: string) { return this.call("claudeBinding", agentId); }
	claudeHook(agentId: string, input: import("./claude.ts").ClaudeHookInput, now: number) { return this.call("claudeHook", agentId, input, now); }
	claimNextCommand(agentId: string, token: string, streaming: boolean) { return this.call("claimNextCommand", agentId, token, streaming); }
	commandDelivered(command: Command, token: string) { return this.call("commandDelivered", command, token); }
	authorizeInput(ref: RunRef, commandId: string, token: string) { return this.call("authorizeInput", ref, commandId, token); }
	recordExecutionEvent(ref: RunRef, token: string, event: ExecutionEvent, now: number) { return this.call("recordExecutionEvent", ref, token, event, now); }
	recoverableLaunches() { return this.call("recoverableLaunches"); }
	launches() { return this.call("launches"); }
	recordLaunch(ref: RunRef, owner: string, stage: LaunchStage, facts: LaunchFacts, now: number) { return this.call("recordLaunch", ref, owner, stage, facts, now); }
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
		await this.channel.close();
		// A call still waiting on a stalled remote channel would otherwise never settle.
		for (const pending of this.pending.values()) pending.reject(new Error("Herdr store closed"));
		this.pending.clear();
	}
}
