import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { HerdrClient, HerdrAgentRef } from "./client.ts";
import { parseAgentFile } from "./agent-file.ts";
import { HerdrStore, type StoreChannelFactory, type AgentRecord, type LaunchRecord, type CompletionNotice, type HerdrTask } from "./store.ts";
import { isTerminal, type RunRef, type RunSnapshot } from "./state.ts";
import { taskMessage } from "./child.ts";
import { claudeArgs, claudePrompt, claudeTools } from "./claude.ts";

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
	inheritContext?: boolean;
	cwd: string;
	/** Where agent definitions are read, when `cwd` is on another machine. */
	definitionsCwd?: string;
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	sessionFile?: string;
	agentDir?: string;
}

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

export type Presence = "alive" | "dead" | "unknown";

/**
 * A Herdr name follows its agent across pane moves, which issue new pane IDs, but another process may take the
 * name after the agent exits. A name proves this agent only in its recorded pane or with its own session.
 */
export function agentPresence(record: Pick<AgentRecord, "herdrName" | "paneId" | "sessionFile" | "sessionId">, named: HerdrAgentRef | undefined): Presence {
	if (!named) return "dead";
	if (named.paneId === record.paneId) return "alive";
	if (named.session === undefined) return "unknown";
	return named.session === record.sessionFile || named.session === record.sessionId ? "alive" : "dead";
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

	resume(agentId: string, prompt: string, signal?: AbortSignal, notify = true): Promise<RunRef> {
		return this.track((async () => {
			const combined = this.signal(signal);
			check(combined);
			await this.store.assertProtocolReady();
			check(combined);
			const record = await this.resolve(agentId);
			check(combined);
			const previous = record.currentRunId;
			await this.locate(record, combined);
			check(combined);
			const ref = await this.store.beginRun(record.id, previous, prompt, notify, this.now());
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
				const agents = runs.length ? await this.deps.client.listAgents(this.stopping.signal) : [];
				check(this.stopping.signal);
				if (agents.some((agent) => !agent.paneId)) throw new Error("Herdr returned an incomplete agent listing");
				const named = new Map(agents.flatMap((agent) => agent.name ? [[agent.name, agent] as const] : []));
				const unnamedPanes = new Set(agents.filter((agent) => !agent.name).map((agent) => agent.paneId));
				const observations = runs.flatMap(({ agent, run }) => {
					const presence = agentPresence(agent, named.get(agent.herdrName));
					// An older/incomplete listing at the right pane is unknown, not proof of death.
					if (presence === "unknown" || (presence === "dead" && unnamedPanes.has(agent.paneId))) return [];
					return [{ ref: { agentId: run.agentId, runId: run.runId }, alive: presence === "alive" }];
				});
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
		// Unknown liveness is not proof of pane death. The CLI adapter throws for transport errors.
		if (agentPresence(record, await this.deps.client.getAgent(record.herdrName)) === "dead") await this.store.recordPaneClosed(ref, this.now());
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
		if (claude && process.platform === "win32") throw new Error("Claude Code subagents currently require Linux or macOS.");
		if (claude && request.inheritContext) throw new Error("Claude Code cannot inherit a Pi session. Provide context in prompt.");
		if (claude && (!this.deps.client.startClaude || !this.deps.client.promptAgent)) throw new Error("The Herdr client does not support Claude Code launches.");
		if (!request.paneId) throw new Error("Not inside a Herdr pane, so no subagent pane can be opened.");
		await this.store.assertProtocolReady();
		check(signal);
		const parent = request.sessionFile ? await this.store.agentForSession(request.paneId, request.sessionFile) : undefined;
		check(signal);
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > HERDR_MAX_DEPTH) throw new Error(`Subagent depth ${depth} exceeds the Herdr limit of ${HERDR_MAX_DEPTH}.`);
		if (request.inheritContext && (!request.sessionFile || !existsSync(request.sessionFile))) throw new Error("inherit_context was set, but this session has no file to clone.");
		const definition = loadAgent(request);
		const maxTurns = request.maxTurns ?? definition?.maxTurns;
		const thinking = request.thinking ?? definition?.thinking;
		const tools = allowedTools(request.isolated || definition?.isolated, definition?.tools);
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
				description: request.description, prompt: request.prompt, instructions: definition?.body || undefined,
				allowedTools: tools,
				maxTurns, model: request.model ?? definition?.model,
				thinking, parentPaneId: request.paneId,
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
			// Closing a pane changes the grid, so it must not interleave with another placement.
			const failure = paneId
				? await this.withPlacement(() => this.cleanup(ref!, paneId, message(error), signal.aborted, creationIssued), new AbortController().signal)
				: await this.cleanup(ref, paneId, message(error), signal.aborted, creationIssued);
			throw new Error(failure);
		}
	}

	/** Claims each prompt durably before terminal submission; an uncertain dispatch is never replayed. */
	private async serviceClaude(agentId: string, signal?: AbortSignal): Promise<void> {
		const binding = await this.store.claudeBinding(agentId);
		if (!binding || isTerminal(binding.run.phase)) return;
		if (binding.run.cancelRequested) {
			// Closing the owned pane is an explicit, confirmed stop; Esc alone is not execution evidence.
			await this.withPlacement(async () => {
				if (isTerminal((await this.read(binding.run)).phase)) return;
				await this.deps.client.closePane(binding.agent.paneId);
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
				const target = untracked.length <= 1 ? refill(grid) : undefined;
				// Existing unrelated panes still count toward the cap, even when their layout is unknown.
				return { newTab: false, tabId: request.tabId, ...(target ?? {
					paneId: request.paneId, direction: physical.length === 1 ? "right" : "down",
					column: live.find((launch) => launch.paneId === request.paneId)?.column ?? "left",
				}) };
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
			// A pane this runner did not place, or no longer tracks, leaves the grid shape unknown.
			const foreign = panes.some((item) => item.tabId === tabId && !live.some((launch) => launch.paneId === item.paneId));
			if (unknown || foreign || !live.length || needsNewTab(live.length)) continue;
			const target = refill(live);
			if (target) return { newTab: false, tabId, ...target };
		}
		return fresh;
	}

	private async recoverLaunches(): Promise<void> {
		for (const pending of await this.store.recoverableLaunches()) {
			if (pending.owner === this.owner || pending.stage === "published" || pending.stage === "closed" || pending.stage === "ambiguous") continue;
			if (ownerAlive(pending.owner) && !(await this.store.ownerRetired(pending.owner))) continue;
			if (!(await this.store.claimLaunchRecovery(pending, pending.owner, this.owner, this.now()))) continue;
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
			? await runner.resume(request.resume, request.prompt, deps.signal, request.runInBackground)
			: await runner.spawn(request, deps.signal);
		const record = await runner.resolve(ref.agentId);
		// An abort after publication still reaches the run; cancel() is idempotent for one already cancelled.
		const snapshot = deps.signal?.aborted ? await runner.cancel(ref) : await runner.read(ref);
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
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	return args;
}

function loadAgent(request: SpawnRequest) {
	for (const dir of [join(request.definitionsCwd ?? request.cwd, ".pi", "agents"), request.agentDir ? join(request.agentDir, "agents") : ""].filter(Boolean)) {
		const path = join(dir, `${request.subagentType}.md`);
		if (existsSync(path)) return parseAgentFile(readFileSync(path, "utf8"));
	}
	return undefined;
}

function formatStatus(record: AgentRecord, snapshot: RunSnapshot, machine?: string): string {
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
