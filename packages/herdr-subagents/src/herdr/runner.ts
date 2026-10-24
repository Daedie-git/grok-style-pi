import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { paneCreationRejected, type HerdrClient, type HerdrAgentRef, type HerdrPaneLayout } from "./client.ts";
import { defaultThinking, parseAgentFile } from "./agent-file.ts";
import { HerdrStore, type StoreChannelFactory, type AgentRecord, type LaunchRecord, type CompletionNotice, type HerdrTask } from "./store.ts";
import { isTerminal, type RunRef, type RunSnapshot } from "./state.ts";
import { taskMessage } from "./child.ts";
import { claudeArgs, claudeEnforceable, claudePrompt, claudeTools } from "./claude.ts";

export const HERDR_MAX_DEPTH = 3;
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const MAX_AGENTS_PER_TAB = 4;
const POLL_MS = 200;
const CLOSE_GRACE_MS = 2000;

export interface SpawnRequest {
	runtime?: "pi" | "claude-code";
	prompt: string;
	description: string;
	name?: string;
	subagentType: string;
	model?: string;
	thinking?: string;
	maxTurns?: number;
	runInBackground: boolean;
	resume?: string;
	isolated?: boolean;
	keep?: boolean;
	/** Parent decision; remote projects still resolve their own trust when the parent is trusted. */
	projectTrusted?: boolean;
	inheritContext?: boolean;
	cwd: string;
	/** Where agent definitions are read, when `cwd` is on another machine. */
	definitionsCwd?: string;
	/** A caller's resolved definition, used instead of an agent file. `allowedTools` undefined allows every tool. */
	resolved?: { instructions?: string; allowedTools?: string[] };
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	sessionFile?: string;
	agentDir?: string;
}

/** Placement and ownership of the invocation, not the saved child's execution directory. */
export type ResumeCaller = Pick<SpawnRequest, "paneId" | "tabId" | "workspaceId" | "sessionFile">;

export interface RunnerDeps {
	client: HerdrClient;
	root: string;
	/** Reaches a store other than the local worker over `root`, such as a saved machine's store over SSH. */
	channel?: StoreChannelFactory;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	signal?: AbortSignal;
	/** The extension shares one runner across tools and session maintenance. */
	runner?: HerdrRunner;
	/** Saved Herdr machine whose panes and store this runner uses. Omitted for the local server. */
	machine?: string;
	/** Finished unfocused panes expire at 1x after acknowledgement, otherwise 4x; zero disables both. */
	idleCloseSeconds?: number;
}

export interface ToolText {
	text: string;
	details: Record<string, unknown>;
}

export function needsNewTab(agentsOnTab: number, limit = MAX_AGENTS_PER_TAB): boolean {
	return agentsOnTab >= limit;
}

interface Placement {
	newTab: boolean;
	tabId?: string;
	paneId?: string;
	direction?: "right" | "down";
	column: "left" | "right";
}

/** Restores a two-column grid: one column splits right; otherwise the shorter column splits down. */
function refill(live: { paneId?: string; column?: "left" | "right" }[]): Pick<Placement, "paneId" | "direction" | "column"> | undefined {
	const left = live.filter((launch) => launch.column === "left");
	const right = live.filter((launch) => launch.column === "right");
	if (!left.length || !right.length) {
		const only = left.length ? left : right;
		// Two stacked panes cannot become columns by splitting right or down.
		if (only.length !== 1) return undefined;
		return { paneId: only[0].paneId, direction: "right", column: only === left ? "right" : "left" };
	}
	const shorter = left.length <= right.length ? left : right;
	return { paneId: shorter[0].paneId, direction: "down", column: shorter[0].column! };
}

/** Complete either two columns or two rows without adding a third strip. */
function refillLayout(layout: HerdrPaneLayout): Pick<Placement, "paneId" | "direction" | "column"> | undefined {
	const panes = layout.panes;
	if (panes.length === 1) return { paneId: panes[0].paneId, direction: "right", column: "right" };
	for (const axis of ["columns", "rows"] as const) {
		const primary = axis === "columns" ? "x" : "y";
		const extent = axis === "columns" ? "width" : "height";
		const secondary = axis === "columns" ? "y" : "x";
		const crossExtent = axis === "columns" ? "height" : "width";
		const positions = [...new Set(panes.map((pane) => pane[primary]))].sort((a, b) => a - b);
		if (positions.length !== 2) continue;
		const groups = positions.map((position) => panes.filter((pane) => pane[primary] === position).sort((a, b) => a[secondary] - b[secondary]));
		if (groups.some((group) => group.length > 2 || group.some((pane) => pane[extent] !== group[0][extent])
			|| (group.length === 2 && group[0][secondary] + group[0][crossExtent] > group[1][secondary]))) continue;
		const [first, second] = groups;
		if (first[0][primary] + first[0][extent] > second[0][primary] || first[0][secondary] !== second[0][secondary]) continue;
		if (first.at(-1)![secondary] + first.at(-1)![crossExtent] !== second.at(-1)![secondary] + second.at(-1)![crossExtent]) continue;
		const index = first.length <= second.length ? 0 : 1;
		if (groups[index].length >= 2) return undefined;
		return {
			paneId: groups[index][0].paneId,
			direction: axis === "columns" ? "down" : "right",
			column: axis === "columns" && index === 0 ? "left" : "right",
		};
	}
	return undefined;
}

export type Presence = "alive" | "dead" | "unknown";

/**
 * A Herdr name follows its agent across pane moves, which issue new pane IDs, but another process may take the
 * name, or the pane, after the agent exits. A reported session decides; without one, only the recorded pane does.
 */
export function agentPresence(record: Pick<AgentRecord, "herdrName" | "paneId" | "sessionFile" | "sessionId">, named: HerdrAgentRef | undefined): Presence {
	if (!named) return "dead";
	if (named.session !== undefined) return sameSession(named.session, record) ? "alive" : "dead";
	return named.paneId === record.paneId ? "alive" : "unknown";
}

/** Session files have unique names, and Claude reports its session ID or a transcript named after it. */
function sameSession(reported: string, record: Pick<AgentRecord, "sessionFile" | "sessionId">): boolean {
	const file = (path: string) => path.split(/[\\/]/).pop();
	return file(reported) === file(record.sessionFile) || (!!record.sessionId && reported.includes(record.sessionId));
}

/** Native shells have no agent session; missing or malformed occupant evidence is not a proven shell. */
function uncertainSession(pane: HerdrAgentRef): boolean {
	return !pane.paneId || ((!pane.session || !pane.session.trim()) && pane.plainShell !== true);
}

/** Remote agent IDs carry their machine so later tool calls route back to it. Agent names never contain `@`. */
export function qualifiedAgentId(id: string, machine?: string): string {
	return machine ? `${id}@${machine}` : id;
}

export function splitAgentId(value: string): { id: string; machine?: string } {
	const at = value.indexOf("@");
	return at < 0 ? { id: value } : { id: value.slice(0, at), machine: value.slice(at + 1) };
}

function paneText(paneId: string, machine?: string): string {
	return machine ? `${paneId} on ${machine}` : paneId;
}

export function paneLabel(id: string, model?: string, thinking?: string): string {
	const detail = [model?.split("/").pop(), thinking].filter(Boolean).join("-");
	return [id.replace(/^herdr-/, ""), detail].filter(Boolean).join(" · ");
}

export function herdrAgentName(preferred: string | undefined, fallback: string): string {
	const raw = (preferred?.trim() || fallback).toLowerCase();
	let slug = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
	if (!/^[a-z]/.test(slug)) slug = `a${slug ? `-${slug}` : "gent"}`;
	slug = slug.slice(0, 31).replace(/-+$/g, "");
	return /^[a-z][a-z0-9_-]{0,30}$/.test(slug) ? slug : "agent";
}

/** Owns launch effects and recovery. Waiters only observe immutable run identities. */
export class HerdrRunner {
	readonly store: HerdrStore;
	readonly machine?: string;
	/** Stable local identity used by remote stores to scope caller-session notice routes. */
	readonly machineId = MACHINE;
	/** The machine part lets a runner on another machine sharing this store tell that it cannot probe the PID. */
	readonly owner = `${process.pid}:${randomUUID()}:${MACHINE}`;
	private stopping = new AbortController();
	private active = new Set<Promise<unknown>>();
	private maintenance?: Promise<void>;
	private closing?: Promise<void>;
	private now: () => number;
	private sleep: (ms: number) => Promise<void>;

	constructor(privateDeps: RunnerDeps) {
		this.deps = privateDeps;
		this.store = new HerdrStore(privateDeps.channel ?? privateDeps.root);
		this.machine = privateDeps.machine;
		this.now = privateDeps.now ?? Date.now;
		this.sleep = privateDeps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}
	private deps: RunnerDeps;

	spawn(request: SpawnRequest, signal?: AbortSignal): Promise<RunRef> {
		return this.track(this.launch(request, this.signal(signal)));
	}

	resume(agentId: string, prompt: string, signal?: AbortSignal, notify = true, caller?: ResumeCaller): Promise<RunRef> {
		return this.track((async () => {
			const combined = this.signal(signal);
			check(combined);
			await this.store.assertProtocolReady();
			check(combined);
			const ref = await this.withPlacement(async () => {
				let record = await this.resolve(agentId);
				check(combined);
				if (record.paneClose) {
					await this.recoverPaneClose(record, undefined, combined);
					record = await this.resolve(agentId);
					check(combined);
					if (record.paneClose) {
						if (!(await this.store.lifecycleAllowed())) throw new Error(`Agent ${record.id} has a pending pane close while lifecycle is quarantined. After old workers drain, use lifecycle-upgrade.mjs before resuming.`);
						throw new Error(`Agent ${record.id} has a pending pane close whose outcome Herdr cannot confirm. The pane will not be reopened without proof of its session's departure.`);
					}
				}
				const parent = caller ? await this.managedCaller(caller) : undefined;
				if (parent?.id === record.id) throw new Error("An agent cannot adopt its own conversation.");
				const previous = record.currentRunId;
				const value = await this.read({ agentId: record.id, runId: previous });
				if (!isTerminal(value.phase)) throw new Error(`Agent ${record.id} is still running. Use steer_subagent or get_subagent_result.`);
				if (record.runtime === "claude-code" && (record.nonResumable || value.phase === "stopped" || value.cancelRequested)) throw new Error(`Claude Code agent ${record.id} is no longer running: its cancelled conversation cannot resume.`);
				// An unpublished cold launch still owns its pane. Recovery must never kill a newly accepted run.
				if ((await this.store.launches()).some((launch) => launch.agentId === record.id && !["published", "closed"].includes(launch.stage))) {
					throw new Error(`Cannot resume ${record.id}: an earlier pane launch is unresolved. Inspect Herdr before retrying.`);
				}
				const named = await this.deps.client.getAgent(record.herdrName, combined);
				const presence = agentPresence(record, named);
				if (presence === "unknown") await this.locate(record, combined);
				if (presence === "dead") {
					await this.assertColdResumeAllowed(record.id);
					await this.assertDeparted(record, combined);
					await this.coldResume(record, combined, caller);
				}
				check(combined);
				const ownership = caller ? {
					parentPaneId: caller.paneId, parentSessionFile: caller.sessionFile, parentAgentId: parent?.id,
					parentTabId: caller.tabId, parentWorkspaceId: caller.workspaceId, parentMachine: this.machine ? MACHINE : undefined,
				} : undefined;
				// Adoption and the previous-run CAS must commit together, including against legacy callers.
				return this.store.beginRun(record.id, previous, prompt, notify, this.now(), ownership);
			}, combined);
			const record = await this.resolve(ref.agentId);
			try {
				if (combined.aborted) await this.cancel(ref);
				else if (record.runtime === "claude-code") await this.serviceClaude(record.id, combined);
			} catch (error) {
				if (combined.aborted) await this.cancel(ref);
				throw error;
			}
			return ref;
		})());
	}

	async resolve(agentId: string): Promise<AgentRecord> {
		const record = await this.store.findAgent(agentId);
		if (!record) throw new Error(`Agent not found: "${agentId}". Legacy agents cannot be resumed with protocol 2.`);
		return record;
	}

	read(ref: RunRef): Promise<RunSnapshot> { return this.store.read(ref); }
	async cancel(ref: RunRef): Promise<RunSnapshot> {
		const value = await this.store.requestCancellation(ref, this.now());
		if (!isTerminal(value.phase) && (await this.resolve(ref.agentId)).runtime === "claude-code") await this.serviceClaude(ref.agentId);
		return this.read(ref);
	}

	async steer(ref: RunRef, message: string): Promise<void> {
		const record = await this.resolve(ref.agentId);
		if (record.runtime === "claude-code") throw new Error("Live steering is not supported for Claude Code. Wait for the run to finish, then use Agent with resume.");
		await this.locate(record);
		// The transactional check still targets the captured run after the asynchronous liveness check.
		await this.store.steer(ref, message);
	}

	async wait(ref: RunRef, signal?: AbortSignal): Promise<RunSnapshot> {
		const combined = this.signal(signal);
		for (;;) {
			check(combined);
			const value = await this.read(ref);
			if (isTerminal(value.phase) || value.phase === "blocked") return value;
			await this.sleep(POLL_MS);
		}
	}

	/** One batched observation per fleet interval. The lease fences late replies after failover. */
	maintain(): Promise<void> {
		if (this.maintenance) return this.maintenance;
		this.maintenance = this.track((async () => {
			const token = randomUUID();
			if (!(await this.store.claimMaintenance(token, this.now()))) return;
			try {
				const runs = await this.store.activeRuns();
				const candidates = await this.store.lifecycleCandidates();
				const agents = runs.length || candidates.length ? await this.deps.client.listAgents(this.stopping.signal) : [];
				check(this.stopping.signal);
				if (agents.some((agent) => !agent.paneId)) throw new Error("Herdr returned an incomplete agent listing");
				const named = new Map(agents.flatMap((agent) => agent.name ? [[agent.name, agent] as const] : []));
				const unnamedPanes = new Set(agents.filter((agent) => !agent.name).map((agent) => agent.paneId));
				const observations = runs.flatMap(({ agent, run }) => {
					// A durable close intent owns settlement, including when closePane killed its caller.
					if (agent.paneClose) return [];
					// A live conversation can move and be renamed without losing its run or binding.
					const presence = agents.some((item) => item.session !== undefined && sameSession(item.session, agent))
						? "alive" : agentPresence(agent, named.get(agent.herdrName));
					// An older/incomplete listing at the right pane is unknown, not proof of death.
					if (presence === "unknown" || (presence === "dead" && unnamedPanes.has(agent.paneId))) return [];
					return [{ ref: { agentId: run.agentId, runId: run.runId }, alive: presence === "alive" }];
				});
				if (candidates.length) await this.reap(token);
				await this.store.finishMaintenance(token, observations, this.now());
				for (const { agent } of runs) if (agent.runtime === "claude-code") await this.serviceClaude(agent.id, this.stopping.signal);
				if (await this.store.tryPlacementLock(token)) {
					try { await this.recoverLaunches(); }
					finally { await this.store.releasePlacementLock(token); }
				}
			} catch (error) {
				await this.store.finishMaintenance(token, [], this.now());
				throw error;
			}
		})()).finally(() => { this.maintenance = undefined; });
		return this.maintenance;
	}

	/** Explicit lifecycle maintenance; never performed by read() or wait(). */
	reconcile(ref?: RunRef): Promise<void> {
		if (ref) return this.track(this.reconcileRun(ref));
		if (this.maintenance) return this.maintenance;
		this.maintenance = this.track((async () => {
			let failure: unknown;
			const token = randomUUID();
			try {
				if (await this.store.tryPlacementLock(token)) {
					try { await this.recoverLaunches(); }
					finally { await this.store.releasePlacementLock(token); }
				}
			} catch (error) { failure = error; }
			for (const record of await this.store.listAgents()) {
				if (this.stopping.signal.aborted) return;
				try { await this.reconcileRun({ agentId: record.id, runId: record.currentRunId }); }
				catch (error) { failure ??= error; }
			}
			if (failure) throw failure;
		})()).finally(() => { this.maintenance = undefined; });
		return this.maintenance;
	}

	private async reconcileRun(ref: RunRef): Promise<void> {
		const value = await this.read(ref);
		if (isTerminal(value.phase) || !value.deadline) return;
		const record = await this.resolve(ref.agentId);
		if (record.paneClose) return;
		// Unknown liveness is not proof of pane death. The CLI adapter throws for transport errors.
		const namedPresence = agentPresence(record, await this.deps.client.getAgent(record.herdrName));
		const sessionAlive = namedPresence === "dead" && (await this.deps.client.listAgents()).some((item) => item.paneId && item.session !== undefined && sameSession(item.session, record));
		if (namedPresence === "dead" && !sessionAlive) await this.store.recordPaneClosed(ref, this.now());
		else await this.store.expireUnacceptedRun(ref, this.now());
	}

	close(): Promise<void> {
		return this.closing ??= (async () => {
			this.stopping.abort();
			// A stalled remote channel must not hold shutdown. Closing the store rejects whatever still waits, and the
			// remote worker retires this owner when its channel ends.
			const bounded = <T>(work: Promise<T>) => this.deps.channel
				? Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())])
				: work;
			await bounded(Promise.allSettled([...this.active]));
			try { await bounded(this.store.retireOwner(this.owner)); }
			finally { await this.store.close(); }
		})();
	}

	private signal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.stopping.signal]) : this.stopping.signal;
	}

	private track<T>(promise: Promise<T>): Promise<T> {
		this.active.add(promise);
		void promise.then(() => this.active.delete(promise), () => this.active.delete(promise));
		return promise;
	}

	private async launch(request: SpawnRequest, signal: AbortSignal): Promise<RunRef> {
		check(signal);
		const claude = request.runtime === "claude-code";
		if (claude && this.machine) throw new Error("Claude Code subagents currently support local Herdr panes only.");
		if (claude && request.inheritContext) throw new Error("Claude Code cannot inherit a Pi session. Provide context in prompt.");
		if (claude && (!this.deps.client.startClaude || !this.deps.client.promptAgent)) throw new Error("The Herdr client does not support Claude Code launches.");
		if (!request.paneId) throw new Error("Not inside a Herdr pane, so no subagent pane can be opened.");
		await this.store.assertProtocolReady();
		check(signal);
		const parent = await this.managedCaller(request);
		check(signal);
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > HERDR_MAX_DEPTH) throw new Error(`Subagent depth ${depth} exceeds the Herdr limit of ${HERDR_MAX_DEPTH}.`);
		if (request.inheritContext && (!request.sessionFile || !existsSync(request.sessionFile))) throw new Error("inherit_context was set, but this session has no file to clone.");
		const definition = request.resolved ? undefined : loadAgent(request);
		if (definition?.isolation && definition.isolation !== "off") throw new Error(`Agent-file isolation: ${definition.isolation} is not supported by Herdr subagents. No pane was opened.`);
		const maxTurns = request.maxTurns ?? definition?.maxTurns;
		const thinking = request.thinking ?? definition?.thinking ?? defaultThinking(request.subagentType);
		// Claude Code enforces only its mapped tools, so a resolved policy loses its other grants there.
		const tools = request.resolved
			? claude ? request.resolved.allowedTools?.filter(claudeEnforceable) : request.resolved.allowedTools
			: allowedTools(definition?.isolated ?? request.isolated, definition?.tools);
		if (claude && maxTurns != null) throw new Error("max_turns is not supported by interactive Claude Code. Omit it.");
		if (claude && thinking && !["low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error("Claude Code thinking maps to --effort: low, medium, high, xhigh, or max.");
		if (claude && definition?.tools) claudeTools(definition.tools);
		if (claude && tools) claudeTools(tools);
		const sessionId = randomUUID();
		const base = herdrAgentName(request.name, request.subagentType);
		let ref: RunRef | undefined;
		let task: HerdrTask | undefined;
		let sessionFile: string | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			check(signal);
			const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
			const id = `${base.slice(0, 31 - suffix.length)}${suffix}`;
			if (await this.deps.client.isAlive(id)) continue;
			check(signal);
			task = {
				runtime: request.runtime, id, herdrName: id, paneId: "", depth, type: request.subagentType,
				description: request.description, prompt: request.prompt, instructions: (request.resolved ? request.resolved.instructions : definition?.body) || undefined,
				allowedTools: tools,
				projectTrusted: request.projectTrusted === false ? false : this.machine ? undefined : request.projectTrusted,
				maxTurns, model: request.model ?? definition?.model,
				thinking, parentPaneId: request.paneId, parentAgentId: parent?.id,
				cwd: request.cwd, parentSessionFile: request.sessionFile,
				parentTabId: request.tabId, parentWorkspaceId: request.workspaceId,
				parentMachine: this.machine ? MACHINE : undefined,
				idleCloseSeconds: this.deps.idleCloseSeconds ?? 900,
				keep: request.keep ?? definition?.keep,
				createdAt: new Date(this.now()).toISOString(),
			};
			// The store creates the file on its own machine. A failed reservation leaves only an unused empty session.
			sessionFile ??= await this.store.createSession(
				{ type: "session", version: 3, id: sessionId, timestamp: task.createdAt, cwd: request.cwd },
				request.inheritContext ? request.sessionFile : undefined,
			);
			check(signal);
			ref = await this.store.reserveAgent(task, sessionFile, this.owner, this.now());
			if (ref) break;
		}
		if (!ref || !task) throw new Error(`Could not reserve a Herdr agent name for ${base}`);
		let paneId: string | undefined;
		let published = false;
		let creationIssued = false;
		try {
			check(signal);
			await this.withPlacement(async () => {
				await this.recoverLaunches();
				check(signal);
				const target = await this.choosePlacement(request, signal);
				await this.store.recordLaunch(ref!, this.owner, "creating", { tabId: target.tabId, direction: target.direction, column: target.column, workspaceId: request.workspaceId }, this.now());
				check(signal);
				// Once issued, pane creation is never blindly retried: its outcome may be ambiguous.
				creationIssued = true;
				const created: { paneId: string; tabId?: string; workspaceId?: string } = target.newTab
					? await this.deps.client.createTab({ cwd: request.cwd, label: request.description, workspaceId: request.workspaceId })
					: await this.deps.client.split({ paneId: target.paneId!, direction: target.direction!, cwd: request.cwd });
				paneId = created.paneId;
				// A tab opened without a known workspace records where Herdr put it, so later spawns can refill it.
				const workspaceId = request.workspaceId ?? created.workspaceId;
				await this.store.recordLaunch(ref!, this.owner, "pane-created", { paneId, tabId: created.tabId ?? target.tabId, workspaceId }, this.now());
				check(signal);
			}, signal);
			check(signal);
			await this.store.recordLaunch(ref, this.owner, "starting-pi", {}, this.now());
			check(signal);
			task.paneId = paneId!;
			if (claude) {
				await this.store.attach(paneId!, sessionFile!, sessionId);
				await this.deps.client.startClaude!({ name: task.id, paneId: paneId!, args: claudeArgs(task, sessionId, this.deps.root) }, signal);
			} else await this.deps.client.startPi({ name: task.id, paneId: paneId!, args: piArgs(task, sessionFile!) }, signal);
			check(signal);
			await this.store.publish(ref, taskMessage(task), request.runInBackground, this.now());
			published = true;
			if (claude && !signal.aborted) await this.serviceClaude(task.id, signal);
			if (signal.aborted) { await this.cancel(ref); return ref; }
			await this.deps.client.showLabel(paneId!, paneLabel(task.id, task.model, task.thinking)).catch(() => undefined);
			if (signal.aborted) await this.cancel(ref);
			return ref;
		} catch (error) {
			if (published) { await this.cancel(ref); throw error; }
			if (!paneId && paneCreationRejected(error)) creationIssued = false;
			// Closing a pane changes the grid, so it must not interleave with another placement.
			const failure = paneId
				? await this.withPlacement(() => this.cleanup(ref!, paneId, message(error), signal.aborted, creationIssued), new AbortController().signal)
				: await this.cleanup(ref, paneId, message(error), signal.aborted, creationIssued);
			throw new Error(failure);
		}
	}

	/** Placement lock covers the terminal-run CAS, pane effects, and publication of the follow-up run. */
	private async coldResume(record: AgentRecord, signal: AbortSignal, caller?: ResumeCaller): Promise<void> {
		await this.assertColdResumeAllowed(record.id);
		if (!(await this.store.coldResumeReady(record.id))) throw new Error(`Agent ${record.id} is no longer running and cannot resume cold: its saved session or working directory is unavailable, or this conversation was stopped.`);
		if (record.runtime === "claude-code" && !this.deps.client.startClaude) throw new Error("The Herdr client does not support Claude Code launches.");
		const previous = { agentId: record.id, runId: record.currentRunId };
		await this.recoverLaunches();
		const launches = await this.store.launches();
		let launch = launches.find((item) => item.agentId === record.id && item.stage !== "closed")
			?? launches.find((item) => item.agentId === record.id);
		if (!launch || !["published", "closed"].includes(launch.stage)) throw new Error(`Cannot reopen ${record.id}: an earlier pane launch is unresolved. Inspect Herdr before retrying.`);
		const request: SpawnRequest = {
			prompt: "", description: record.description, subagentType: record.type, runInBackground: true,
			cwd: record.cwd!, paneId: caller?.paneId ?? record.parentPaneId ?? "", tabId: caller ? caller.tabId : record.parentTabId,
			workspaceId: caller ? caller.workspaceId : record.parentWorkspaceId,
		};
		let herdrName = record.herdrName;
		for (let attempt = 0; await this.deps.client.isAlive(herdrName); attempt++) {
			check(signal);
			if (attempt >= 100) throw new Error(`Could not reserve a Herdr name to reopen ${record.id}`);
			const suffix = `-r${attempt + 1}`;
			herdrName = `${record.id.slice(0, 31 - suffix.length)}${suffix}`;
		}
		const target = await this.choosePlacement(request, signal);
		check(signal);
		let paneId: string | undefined;
		let rebound = false;
		let creationIssued = false;
		let startupIssued = false;
		try {
			// The original launch retains this fleet's grid history across all of its runs.
			if (launch) {
				await this.store.recordLaunch(launch, launch.owner, "creating", {
					paneId: undefined, tabId: target.tabId, direction: target.direction, column: target.column, workspaceId: request.workspaceId,
				}, this.now());
				// Transfer the now-unpublished launch before issuing any external effect, so this attempt is recoverable.
				if (!(await this.store.claimLaunchRecovery(launch, launch.owner, this.owner, this.now()))) throw new Error("Cold resume launch ownership changed");
				launch = { ...launch, owner: this.owner };
			}
			await this.assertColdResumeAllowed(record.id);
			creationIssued = true;
			const created = target.newTab
				? await this.deps.client.createTab({ cwd: request.cwd, label: record.description, workspaceId: request.workspaceId })
				: await this.deps.client.split({ paneId: target.paneId!, direction: target.direction!, cwd: request.cwd });
			paneId = created.paneId;
			check(signal);
			await this.store.rebindPane(record.id, record.currentRunId, paneId, herdrName);
			rebound = true;
			if (launch) await this.store.recordLaunch(launch, launch.owner, "pane-created", {
				paneId, tabId: (created as { tabId?: string }).tabId ?? target.tabId,
				workspaceId: request.workspaceId ?? (created as { workspaceId?: string }).workspaceId,
			}, this.now());
			check(signal);
			if (record.runtime === "claude-code") {
				await this.store.attach(paneId, record.sessionFile, record.sessionId!);
				const args = claudeArgs(record, record.sessionId!, this.deps.root);
				args[0] = "--resume";
				startupIssued = true;
				await this.deps.client.startClaude!({ name: herdrName, paneId, args }, signal);
			} else {
				startupIssued = true;
				await this.deps.client.startPi({ name: herdrName, paneId, args: piArgs(record, record.sessionFile) }, signal);
			}
			check(signal);
			if (launch) await this.store.recordLaunch(launch, launch.owner, "published", {}, this.now());
			await this.deps.client.showLabel(paneId, paneLabel(record.id, record.model, record.thinking)).catch(() => undefined);
		} catch (error) {
			if (paneId) {
				// A live cold-start process may accept legacy work after any run-ID check. Only a proven empty
				// shell is safe to close once startup was issued; a lost response is not a failed launch.
				let cleanupUnsafe: string | undefined;
				if (startupIssued) {
					let shell: HerdrAgentRef | undefined;
					try { shell = await this.deps.client.getPane?.(paneId); } catch {}
					if (shell?.paneId !== paneId || shell.plainShell !== true || shell.session !== undefined) cleanupUnsafe = "startup may still host the saved session";
				}
				const current = await this.resolve(record.id);
				const currentRun = await this.read({ agentId: current.id, runId: current.currentRunId });
				if (current.currentRunId !== previous.runId || !isTerminal(currentRun.phase) || current.paneClose
					|| (rebound && (current.paneId !== paneId || current.herdrName !== herdrName))) cleanupUnsafe = "execution ownership changed";
				if (cleanupUnsafe) {
					const failure = `${message(error)}. Cold resume cleanup withheld for pane ${paneId}: ${cleanupUnsafe}. The unresolved launch reservation is retained.`;
					if (launch) await this.store.recordLaunch(launch, launch.owner, "ambiguous", { paneId, error: failure }, this.now());
					throw new Error(failure);
				}
				// This pane is still owned by this attempt, not inferred from a stale agent name.
				try { await this.deps.client.closePane(paneId); }
				catch (closeError) { throw new Error(`${message(error)}. Cold resume cleanup failed for pane ${paneId}: ${message(closeError)}`); }
				if (rebound) await this.store.parkAgent(previous, paneId, this.now());
				if (launch) await this.store.recordLaunch(launch, launch.owner, "closed", {}, this.now());
			} else if (launch) await this.store.recordLaunch(launch, launch.owner, creationIssued && !paneCreationRejected(error) ? "ambiguous" : "closed", { error: message(error) }, this.now());
			throw error;
		}
	}

	private async assertColdResumeAllowed(agentId: string): Promise<void> {
		if (!(await this.store.lifecycleAllowed())) throw new Error(`Cannot cold-resume ${agentId} while lifecycle upgrades are quarantined. Drain old workers and use lifecycle-upgrade.mjs to confirm the upgrade before retrying. Warm resume remains available.`);
	}

	/** External closes stay inside both the placement lock and the maintenance lease. */
	private async reap(token: string): Promise<void> {
		await this.withPlacement(async () => {
			if (!(await this.store.lifecycleAllowed())) return;
			if (!(await this.store.maintenanceValid(token, this.now()))) return;
			const panes = await this.deps.client.listPanes({ signal: this.stopping.signal });
			if (panes.some((pane) => !pane.paneId)) throw new Error("Herdr returned an incomplete pane listing");
			const records = await this.store.listAgents();
			for (const { agent, run, acknowledged } of await this.store.lifecycleCandidates()) {
				check(this.stopping.signal);
				if (agent.paneClose && !(await this.recoverPaneClose(agent, token))) continue;
				const idleSeconds = agent.idleCloseSeconds ?? this.deps.idleCloseSeconds ?? 900;
				if (agent.paneState === "parked" || !agent.cwd) continue;
				const ownerGone = await this.ownerDeparted(agent, records, this.stopping.signal);
				// Closing active Claude is cancellation, which permanently destroys resumability. Preserve it.
				if (ownerGone && agent.runtime === "claude-code" && !isTerminal(run.phase)) continue;
				if (!ownerGone && !isTerminal(run.phase)) continue;
				const named = await this.deps.client.getAgent(agent.herdrName, this.stopping.signal);
				// An explicit matching session is required for destructive effects; same-pane inference is insufficient.
				if (!named?.paneId || named.session === undefined || agentPresence(agent, named) !== "alive") continue;
				const pane = panes.find((item) => item.paneId === named.paneId);
				if (!pane) continue;
				if (pane.focused === true || ["working", "blocked"].includes(named.status ?? "")) {
					await this.store.notePaneActivity({ agentId: agent.id, runId: run.runId }, this.now());
					if (!ownerGone) continue;
				}
				const idleMs = idleSeconds * 1000 * (acknowledged ? 1 : 4);
				if (!ownerGone && (agent.keep || idleSeconds <= 0 || pane.focused !== false || !["idle", "done"].includes(named.status ?? "")
					|| this.now() - Math.max(run.updatedAt, agent.lastActivityAt ?? 0) < idleMs)) continue;
				const current = await this.resolve(agent.id);
				if (current.currentRunId !== run.runId || current.paneState === "parked") continue;
				const ref = { agentId: agent.id, runId: run.runId };
				if (!ownerGone && !isTerminal((await this.read(ref)).phase)) continue;
				if (!(await this.store.maintenanceValid(token, this.now()))) return;
				if (!(await this.store.preparePaneClose(ref, agent.paneId, ownerGone, this.now()))) continue;
				try {
					if (ownerGone && !(await this.ownerDeparted(agent, records, this.stopping.signal))) {
						if (!(await this.store.lifecycleAllowed())) return;
						await this.store.abortPaneClose(ref, agent.paneId);
						continue;
					}
					// Readiness may read large transcripts. Refresh physical evidence after it, not before it.
					const live = await this.deps.client.getAgent(agent.herdrName, this.stopping.signal);
					const freshPanes = await this.deps.client.listPanes({ signal: this.stopping.signal });
					const fresh = freshPanes.find((item) => item.paneId === live?.paneId);
					const ownerSession = agent.parentSessionFile;
					// This is newer than ownerDeparted's inventory: never ignore a returned or uncertain owner here.
					const ownerMayBePresent = ownerGone && (!ownerSession || freshPanes.some((item) => uncertainSession(item)
						|| (item.session !== undefined && sameSession(item.session, { sessionFile: ownerSession }))));
					if (ownerMayBePresent || !live?.paneId || live.paneId !== named.paneId || live.session === undefined || agentPresence(agent, live) !== "alive"
						|| !fresh || fresh.session === undefined || !sameSession(fresh.session, agent)
						|| (!ownerGone && (fresh.focused !== false || !["idle", "done"].includes(live.status ?? "") || !["idle", "done"].includes(fresh.status ?? "")))) {
						if (!(await this.store.lifecycleAllowed())) return;
						await this.store.abortPaneClose(ref, agent.paneId);
						if (!ownerGone) await this.store.notePaneActivity(ref, this.now());
						continue;
					}
					if (!(await this.store.maintenanceValid(token, this.now()))) {
						if (!(await this.store.lifecycleAllowed())) return;
						await this.store.abortPaneClose(ref, agent.paneId);
						return;
					}
					// A newly quarantined database retains its durable intent for explicit upgrade recovery.
					if (!(await this.store.lifecycleAllowed())) return;
					await this.deps.client.closePane(live.paneId);
					// Closing this runner's own pane may kill it here. The intent survives in the store.
					check(this.stopping.signal);
					if (ownerGone) await this.store.closeOwnedAgent(ref, agent.paneId, this.now());
					else await this.store.parkAgent(ref, agent.paneId, this.now());
				} catch (error) {
					// A failed reply is not proof of failed closure. Roll back only after positive live-session evidence.
					if (!this.stopping.signal.aborted) await this.recoverPaneClose(await this.resolve(agent.id), token);
					throw error;
				}
			}
		}, this.stopping.signal);
	}

	private async managedCaller(caller: ResumeCaller): Promise<AgentRecord | undefined> {
		if (!caller.sessionFile || this.machine) return undefined;
		return await this.store.agentForSession(caller.paneId, caller.sessionFile)
			?? (await this.store.listAgents()).find((record) => sameSession(caller.sessionFile!, record));
	}

	/** Managed conversations own children independently of their current pane address. */
	private async ownerDeparted(agent: AgentRecord, records: AgentRecord[], signal: AbortSignal): Promise<boolean> {
		if (this.machine || agent.parentMachine || agent.parentPaneId?.includes("/") || !agent.parentSessionFile) return false;
		const saved = records.find((record) => agent.parentAgentId ? record.id === agent.parentAgentId : record.sessionFile === agent.parentSessionFile);
		const managed = saved ? await this.resolve(saved.id) : undefined;
		if (managed?.paneState === "parked" || managed?.paneClose) return false;
		if (managed) {
			const named = await this.deps.client.getAgent(managed.herdrName, signal);
			if (agentPresence(managed, named) !== "dead") return false;
		}
		const paneId = managed?.paneId ?? agent.parentPaneId;
		if (!paneId || !this.deps.client.getPane) return false;
		const parentSession = { sessionFile: agent.parentSessionFile };
		const parent = await this.deps.client.getPane(paneId, signal);
		if (parent && (uncertainSession(parent) || (parent.session !== undefined && sameSession(parent.session, parentSession)))) return false;
		// Losing the old alias or replacing its occupant does not prove the conversation departed.
		const panes = await this.deps.client.listPanes({ signal });
		const agents = await this.deps.client.listAgents(signal);
		check(signal);
		if ([...panes, ...agents].some((item) => uncertainSession(item)
			|| (item.session !== undefined && sameSession(item.session, parentSession)))) return false;
		// An absent alias that still appears in the inventory is inconsistent, not proof of departure.
		return parent !== undefined || !panes.some((pane) => pane.paneId === paneId);
	}

	/** A lost/reused name alone never authorizes a second process on the saved conversation. */
	private async assertDeparted(record: AgentRecord, signal: AbortSignal): Promise<void> {
		if (!this.deps.client.getPane) throw new Error(`Agent ${record.id} is no longer running under its saved Herdr name; cannot reopen because Herdr cannot verify the original pane's departure.`);
		if (await this.sessionPresence(record, signal) !== "dead") {
			throw new Error(`Cannot reopen ${record.id}: the original session may still be live; Herdr's session inventory does not prove departure.`);
		}
	}

	/** Shared departure evidence for reopening and settlement: a lost name or alias is never enough. */
	private async sessionPresence(record: AgentRecord, signal: AbortSignal): Promise<Presence> {
		if (!this.deps.client.getPane) return "unknown";
		const pane = await this.deps.client.getPane(record.paneId, signal);
		const agents = await this.deps.client.listAgents(signal);
		const panes = await this.deps.client.listPanes({ signal });
		check(signal);
		const inventory = [...(pane ? [pane] : []), ...agents, ...panes];
		if (inventory.some((item) => item.paneId && item.session !== undefined && sameSession(item.session, record))) return "alive";
		return inventory.some(uncertainSession) ? "unknown" : "dead";
	}

	/** Returns true only when an interrupted close was rolled back with positive live-session evidence. */
	private async recoverPaneClose(agent: AgentRecord, token?: string, signal = this.stopping.signal): Promise<boolean> {
		const intent = agent.paneClose;
		if (!intent) return true;
		if (!(await this.store.lifecycleAllowed())) return false;
		if (intent.runId !== agent.currentRunId) return false;
		const named = await this.deps.client.getAgent(agent.herdrName, signal);
		check(signal);
		const namedLive = named?.paneId && named.session !== undefined && agentPresence(agent, named) === "alive";
		const presence = namedLive ? "alive" : await this.sessionPresence(agent, signal);
		if (presence === "unknown") return false;
		if (token && !(await this.store.maintenanceValid(token, this.now()))) return false;
		if (!(await this.store.lifecycleAllowed())) return false;
		const ref = { agentId: agent.id, runId: intent.runId };
		if (presence === "alive") {
			await this.store.abortPaneClose(ref, intent.paneId);
			return true;
		}
		if (intent.ownerGone) await this.store.closeOwnedAgent(ref, intent.paneId, this.now());
		else await this.store.parkAgent(ref, intent.paneId, this.now());
		return false;
	}

	/** Claims each prompt durably before terminal submission; an uncertain dispatch is never replayed. */
	private async serviceClaude(agentId: string, signal?: AbortSignal): Promise<void> {
		const binding = await this.store.claudeBinding(agentId);
		if (!binding || isTerminal(binding.run.phase)) return;
		if (binding.run.cancelRequested) {
			// Closing the owned pane is an explicit, confirmed stop; Esc alone is not execution evidence.
			await this.withPlacement(async () => {
				if (isTerminal((await this.read(binding.run)).phase)) return;
				// Close the agent where it is now. An exited agent has nothing to stop, and its old pane may host another process.
				const named = await this.deps.client.getAgent(binding.agent.herdrName, signal);
				const presence = agentPresence(binding.agent, named);
				if (presence === "unknown") throw new Error(`Cannot cancel ${agentId}: Herdr agent ${binding.agent.herdrName} is in pane ${named!.paneId}, not ${binding.agent.paneId}, and reports no session to confirm it.`);
				if (presence === "alive") await this.deps.client.closePane(named!.paneId!);
				await this.store.recordPaneClosed(binding.run, this.now());
			}, signal ?? this.stopping.signal);
			return;
		}
		const command = await this.store.claimNextCommand(agentId, binding.token, false);
		if (!command) return;
		try {
			// Target the verified pane: the name alone could reach another process that took it.
			const paneId = await this.locate(binding.agent, signal);
			await this.deps.client.promptAgent!(paneId, claudePrompt(command), signal);
			await this.store.commandDelivered(command, binding.token);
		} catch (error) {
			// Cancellation wins even before execution confirmation: close the owned pane
			// before terminalizing this dispatched run, so no live task escapes cancellation.
			if (signal?.aborted) {
				await this.cancel(command);
				throw error;
			}
			const value = await this.read(command);
			// Durable hook receipt repairs a lost CLI reply without pretending another
			// submission hook has allowed execution. The execution deadline remains bounded.
			if (value.accepted || value.inputReceived) return;
			await this.store.recordExecutionEvent(command, binding.token, {
				type: "failed", error: `Claude prompt submission was not confirmed; it will not be retried. The pane may still be live: ${message(error)}`,
			}, this.now());
			throw error;
		}
	}

	/** The pane currently hosting this agent. Throws unless Herdr proves it is the launched process. */
	private async locate(record: AgentRecord, signal?: AbortSignal): Promise<string> {
		const named = await this.deps.client.getAgent(record.herdrName, signal);
		const presence = agentPresence(record, named);
		if (presence === "dead") throw new Error(`Agent ${record.id} is no longer running in Herdr pane ${record.paneId}.`);
		if (presence === "unknown") throw new Error(`Herdr agent ${record.herdrName} is now in pane ${named!.paneId}, not ${record.paneId}, and Herdr reports no session to confirm it is the same agent.`);
		return named!.paneId!;
	}

	private async withPlacement<T>(body: () => Promise<T>, signal: AbortSignal): Promise<T> {
		// Separate token per acquisition also serializes calls sharing this worker.
		const token = randomUUID();
		for (;;) {
			check(signal);
			if (await this.store.tryPlacementLock(token)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		try { check(signal); return await body(); }
		finally { await this.store.releasePlacementLock(token); }
	}

	private async observedPlacement(tabId: string, physical: HerdrAgentRef[], live: LaunchRecord[], fallback: ReturnType<typeof refill>, signal: AbortSignal): Promise<ReturnType<typeof refill>> {
		// A reservation not yet visible in Herdr must keep its recorded column until it appears.
		if (!this.deps.client.paneLayout || !physical.length || !live.every((launch) => physical.some((pane) => pane.paneId === launch.paneId))) return fallback;
		try {
			const layout = await this.deps.client.paneLayout(physical[0].paneId!, signal);
			check(signal);
			const consistent = layout.tabId === tabId && layout.panes.length === physical.length
				&& physical.every((pane) => layout.panes.some((item) => item.paneId === pane.paneId));
			return consistent ? refillLayout(layout) : undefined;
		} catch { check(signal); return undefined; }
	}

	private async choosePlacement(request: SpawnRequest, signal: AbortSignal): Promise<Placement> {
		const fresh: Placement = { newTab: true, column: "left" };
		// Without the caller's workspace, a managed tab could belong to another project.
		if (!request.workspaceId) return fresh;
		let panes: HerdrAgentRef[];
		try { panes = await this.deps.client.listPanes({ workspaceId: request.workspaceId, signal }); }
		catch { check(signal); return fresh; }
		check(signal);
		const launches = await this.store.launches();
		check(signal);
		// Fill the caller's tab first, counting all physical panes and unpublished reservations.
		if (request.tabId && panes.some((pane) => pane.tabId === request.tabId && pane.paneId === request.paneId)) {
			const physical = panes.filter((pane) => pane.tabId === request.tabId);
			const pending = launches.filter((launch) => launch.tabId === request.tabId && launch.stage !== "closed");
			const live: LaunchRecord[] = [];
			let unknown = false;
			for (const launch of pending) {
				if (launch.stage === "published" && launch.paneId && !physical.some((pane) => pane.paneId === launch.paneId)) {
					const alive = await this.deps.client.isAlive(launch.agentId);
					check(signal);
					if (!alive) { await this.store.releasePlacement(launch); continue; }
				}
				if (!launch.paneId || !launch.column || launch.stage === "cleanup") unknown = true;
				live.push(launch);
			}
			const untracked = physical.filter((pane) => !live.some((launch) => launch.paneId === pane.paneId));
			if (!unknown && !needsNewTab(live.length + untracked.length)) {
				// A single untracked pane is the original root of this tab's grid.
				const grid = [...live, ...untracked.map((pane) => ({ paneId: pane.paneId, column: "left" as const }))];
				const target = await this.observedPlacement(request.tabId, physical, live, untracked.length <= 1 ? refill(grid) : undefined, signal);
				// Never guess a downward split: that repeatedly stacks panes in an unknown layout.
				if (target) return { newTab: false, tabId: request.tabId, ...target };
			}
		}
		// After the caller's tab fills, reuse grid tabs this fleet created in the same workspace.
		const tabs = new Set(launches.filter((launch) => launch.tabId && launch.column && !launch.direction && launch.workspaceId === request.workspaceId).map((launch) => launch.tabId!));
		for (const tabId of tabs) {
			const pendingOnTab = launches.filter((launch) => launch.tabId === tabId && launch.stage !== "closed");
			const live: LaunchRecord[] = [];
			let unknown = false;
			for (const pending of pendingOnTab) {
				// A shell left by an exited agent still occupies its pane; only a vanished pane frees the slot.
				if (pending.stage === "published" && pending.paneId && !panes.some((item) => item.paneId === pending.paneId)) {
					const alive = await this.deps.client.isAlive(pending.agentId);
					check(signal);
					if (!alive) { await this.store.releasePlacement(pending); continue; }
				}
				// A pane under cleanup may be closing and cannot be split.
				if (pending.paneId && pending.column && pending.stage !== "cleanup") live.push(pending);
				else unknown = true;
			}
			const physical = panes.filter((item) => item.tabId === tabId);
			const untracked = physical.filter((pane) => !live.some((launch) => launch.paneId === pane.paneId));
			if (unknown || needsNewTab(live.length + untracked.length)) continue;
			const target = await this.observedPlacement(tabId, physical, live, untracked.length ? undefined : refill(live), signal);
			if (target) return { newTab: false, tabId, ...target };
		}
		return fresh;
	}

	private async recoverLaunches(): Promise<void> {
		if (!(await this.store.lifecycleAllowed())) return;
		for (const pending of await this.store.recoverableLaunches()) {
			if (pending.owner === this.owner || pending.stage === "published" || pending.stage === "closed" || pending.stage === "ambiguous") continue;
			if (ownerAlive(pending.owner) && !(await this.store.ownerRetired(pending.owner))) continue;
			if (!(await this.store.claimLaunchRecovery(pending, pending.owner, this.owner, this.now()))) continue;
			if (!(await this.store.lifecycleAllowed())) return;
			await this.cleanup(pending, pending.paneId, "Launch interrupted before task publication", false);
		}
	}

	private async cleanup(ref: RunRef, paneId: string | undefined, error: string, stopped: boolean, creationIssued?: boolean): Promise<string> {
		const pending = (await this.store.launches()).find((item) => item.runId === ref.runId)!;
		if (paneId) {
			await this.store.recordLaunch(ref, this.owner, "cleanup", { paneId, error }, this.now());
			try { await this.deps.client.closePane(paneId); }
			catch (closeError) {
				const failure = `${error}. Cleanup failed for pane ${paneId}: ${message(closeError)}. The pane may still be live; the reservation is retained.`;
				await this.store.recordLaunch(ref, this.owner, "cleanup", { error: failure }, this.now());
				await this.store.failLaunch(ref, this.owner, failure, false, this.now());
				return failure;
			}
			await this.store.recordLaunch(ref, this.owner, "closed", { error }, this.now());
		} else {
			const ambiguous = creationIssued !== false && (pending.stage === "creating" || pending.stage === "ambiguous");
			if (ambiguous) error += ". Pane creation outcome is unknown; the placement reservation is retained. Inspect Herdr before retrying.";
			await this.store.recordLaunch(ref, this.owner, ambiguous ? "ambiguous" : "closed", { error }, this.now());
			if (ambiguous) stopped = false;
		}
		await this.store.failLaunch(ref, this.owner, error, stopped, this.now());
		return error;
	}
}

/** Stable across hostname changes, and distinct for machines that share a hostname. */
function machineIdentity(): string {
	for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
		try {
			const id = readFileSync(path, "utf8").trim();
			if (id) return id;
		} catch {}
	}
	return hostname().replaceAll(":", "-");
}
const MACHINE = machineIdentity();

function ownerAlive(owner: string): boolean {
	const [process_, , machine] = owner.split(":");
	// A PID on another machine cannot be probed here; only retirement proves that owner is gone.
	if (machine && machine !== MACHINE) return true;
	const pid = Number(process_);
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Tool formatting stays outside the coordination interface. */
export async function spawnHerdrAgent(request: SpawnRequest, deps: RunnerDeps): Promise<ToolText> {
	return usingRunner(deps, async (runner) => {
		const ref = request.resume
			? await runner.resume(request.resume, request.prompt, deps.signal, request.runInBackground, request)
			: await runner.spawn(request, deps.signal);
		const record = await runner.resolve(ref.agentId);
		let snapshot = await runner.read(ref);
		// An abort after publication still reaches the run; cancel() is idempotent for one already cancelled.
		if (deps.signal?.aborted) snapshot = await runner.cancel(ref);
		const shown = { ...ref, agentId: qualifiedAgentId(ref.agentId, runner.machine) };
		if (deps.signal?.aborted) return text(formatStatus(record, snapshot, runner.machine), { ...shown, paneId: record.paneId, status: snapshot.phase });
		if (request.runInBackground) return text(
			`Agent ${request.resume ? "resumed" : "started"} in a Herdr pane.\nAgent ID: ${shown.agentId}\nRun ID: ${ref.runId}\nPane: ${paneText(record.paneId, runner.machine)}\nRuntime: ${record.runtime ?? "pi"}\nType: ${record.type}\nDescription: ${record.description}\n\nYou will be notified when this run completes.\nUse get_subagent_result for full results.${record.runtime === "claude-code" ? " After completion, use Agent with resume for follow-up work; live steering is unsupported." : " Use steer_subagent to send messages."}\nDo not duplicate this agent's work.`,
			{ ...shown, status: "background", paneId: record.paneId },
		);
		return resultForRun(runner, record, ref, true, deps.signal);
	});
}

export async function readHerdrAgent(root: string, agentId: string, options: { wait?: boolean; verbose?: boolean; runId?: string }, deps: Omit<RunnerDeps, "root">): Promise<ToolText> {
	return usingRunner({ ...deps, root }, async (runner) => {
		const record = await runner.resolve(agentId);
		const ref = { agentId: record.id, runId: options.runId ?? record.currentRunId };
		const result = await resultForRun(runner, record, ref, options.wait === true, deps.signal);
		if (options.verbose) result.text += `\n\nFull conversation is in Herdr pane ${paneText(record.paneId, runner.machine)}.`;
		return result;
	});
}

export async function steerHerdrAgent(root: string, agentId: string, messageText: string, deps: Omit<RunnerDeps, "root">): Promise<ToolText> {
	return usingRunner({ ...deps, root }, async (runner) => {
		const record = await runner.resolve(agentId);
		const ref = { agentId: record.id, runId: record.currentRunId };
		await runner.steer(ref, messageText);
		return text(`Steering message sent to agent ${qualifiedAgentId(record.id, runner.machine)}. The agent will process it after its current tool execution.\nPane: ${paneText(record.paneId, runner.machine)}`, { ...ref, agentId: qualifiedAgentId(ref.agentId, runner.machine) });
	});
}

export function completionNotice(notice: CompletionNotice, machine?: string): string {
	const preview = (notice.run.result || notice.run.error || "No output.").slice(0, 500);
	const agentId = qualifiedAgentId(notice.agentId, machine);
	return `Background agent ${notice.run.phase}: ${notice.agent.description}\nAgent ID: ${agentId}\nRun ID: ${notice.runId}\nPane: ${paneText(notice.agent.paneId, machine)}\n\n${preview}\n\nUse get_subagent_result with agent_id "${agentId}" and run_id "${notice.runId}" for full output.`;
}

async function resultForRun(runner: HerdrRunner, record: AgentRecord, ref: RunRef, wait: boolean, signal?: AbortSignal): Promise<ToolText> {
	let snapshot: RunSnapshot;
	try {
		if (wait && !signal?.aborted) await runner.reconcile(ref);
		snapshot = wait ? await runner.wait(ref, signal) : await runner.read(ref);
	}
	catch (error) {
		if (!signal?.aborted) throw error;
		// Cancellation is an explicit tool action on the captured run, not a side effect of waiting.
		snapshot = await runner.cancel(ref);
	}
	if (isTerminal(snapshot.phase)) await runner.store.acknowledgeNotice(ref.runId);
	return text(formatStatus(record, snapshot, runner.machine), { ...ref, agentId: qualifiedAgentId(ref.agentId, runner.machine), status: snapshot.phase, paneId: record.paneId });
}

async function usingRunner(deps: RunnerDeps, body: (runner: HerdrRunner) => Promise<ToolText>): Promise<ToolText> {
	const runner = deps.runner ?? new HerdrRunner(deps);
	let busy = false;
	// Standalone callers need lifecycle maintenance too; the extension owns it for its shared runner.
	const timer = deps.runner ? undefined : setInterval(() => {
		if (busy) return;
		busy = true;
		void runner.maintain().catch(() => undefined).finally(() => { busy = false; });
	}, POLL_MS);
	timer?.unref();
	try { return await body(runner); }
	catch (error) { return text(message(error), { status: "error" }); }
	finally {
		if (timer) clearInterval(timer);
		if (!deps.runner) await runner.close();
	}
}

function allowedTools(restrict: boolean | undefined, listed: string[] | undefined): string[] | undefined {
	return restrict ? (listed ?? BUILTIN_TOOLS).filter((tool) => BUILTIN_TOOLS.includes(tool)) : listed;
}

function piArgs(task: HerdrTask, sessionFile: string): string[] {
	const args = ["--session", sessionFile];
	if (task.projectTrusted !== undefined) args.push(task.projectTrusted ? "--approve" : "--no-approve");
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	return args;
}

function loadAgent(request: SpawnRequest) {
	for (const dir of [request.projectTrusted === false ? "" : join(request.definitionsCwd ?? request.cwd, ".pi", "agents"), request.agentDir ? join(request.agentDir, "agents") : ""].filter(Boolean)) {
		const path = join(dir, `${request.subagentType}.md`);
		if (existsSync(path)) return parseAgentFile(readFileSync(path, "utf8"));
	}
	return undefined;
}

export function formatStatus(record: AgentRecord, snapshot: RunSnapshot, machine?: string): string {
	const pane = paneText(record.paneId, machine);
	const header = `Agent: ${qualifiedAgentId(record.id, machine)}\nRun: ${snapshot.runId}\nRuntime: ${record.runtime ?? "pi"}\nType: ${record.type} | Status: ${snapshot.phase}\nDescription: ${record.description}\nPane: ${pane}\n`;
	if (snapshot.cancelRequested && !isTerminal(snapshot.phase)) return `${header}\nCancellation requested; waiting for the child to stop.`;
	if (snapshot.phase === "blocked") return `${header}\nAgent is blocked in Herdr pane ${pane}. Answer the prompt there.`;
	if (!isTerminal(snapshot.phase)) return `${header}\nAgent is still ${snapshot.phase}. Use wait: true or check back later.`;
	return `${header}\n${[snapshot.result, snapshot.error].filter(Boolean).join("\n\n") || "No output."}`;
}

function text(value: string, details: Record<string, unknown> = {}): ToolText { return { text: value, details }; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function check(signal: AbortSignal): void { if (signal.aborted) throw new Error("Stopped"); }
