import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrClient, HerdrAgentRef } from "./client.ts";
import { splitDirection } from "./client.ts";
import { parseAgentFile } from "./agent-file.ts";
import { HerdrStore, type AgentRecord, type CompletionNotice, type HerdrTask } from "./store.ts";
import { isTerminal, type RunRef, type RunSnapshot } from "./state.ts";
import { taskMessage } from "./child.ts";

export const HERDR_MAX_DEPTH = 3;
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const MAX_AGENTS_PER_TAB = 3;
const POLL_MS = 200;

export interface SpawnRequest {
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
	paneId: string;
	tabId?: string;
	sessionFile?: string;
	agentDir?: string;
}

export interface RunnerDeps {
	client: HerdrClient;
	root: string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	signal?: AbortSignal;
	/** The extension shares one runner across tools and session maintenance. */
	runner?: HerdrRunner;
}

export interface ToolText {
	text: string;
	details: Record<string, unknown>;
}

export function needsNewTab(agentsOnTab: number, limit = MAX_AGENTS_PER_TAB): boolean {
	return agentsOnTab >= limit;
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
	private owner = `${process.pid}:${randomUUID()}`;
	private stopping = new AbortController();
	private active = new Set<Promise<unknown>>();
	private maintenance?: Promise<void>;
	private closing?: Promise<void>;
	private now: () => number;
	private sleep: (ms: number) => Promise<void>;

	constructor(privateDeps: RunnerDeps) {
		this.deps = privateDeps;
		this.store = new HerdrStore(privateDeps.root);
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
			if (!(await this.deps.client.isAlive(record.herdrName))) throw new Error(`Agent ${agentId} is no longer running in Herdr pane ${record.paneId}.`);
			check(combined);
			const ref = await this.store.beginRun(record.id, previous, prompt, notify, this.now());
			if (combined.aborted) await this.cancel(ref);
			return ref;
		})());
	}

	async resolve(agentId: string): Promise<AgentRecord> {
		const record = await this.store.findAgent(agentId);
		if (!record) throw new Error(`Agent not found: "${agentId}". Legacy agents cannot be resumed with protocol 2.`);
		return record;
	}

	read(ref: RunRef): Promise<RunSnapshot> { return this.store.read(ref); }
	cancel(ref: RunRef): Promise<RunSnapshot> { return this.store.requestCancellation(ref, this.now()); }

	async steer(ref: RunRef, message: string): Promise<void> {
		const record = await this.resolve(ref.agentId);
		if (!(await this.deps.client.isAlive(record.herdrName))) throw new Error(`Agent ${record.id} is no longer running in Herdr.`);
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
				const names = new Set(agents.flatMap((agent) => agent.name ? [agent.name] : []));
				const unnamedPanes = new Set(agents.filter((agent) => !agent.name).map((agent) => agent.paneId));
				// An older/incomplete listing at the right pane is unknown, not proof of death.
				const observations = runs.flatMap(({ agent, run }) => !names.has(agent.herdrName) && unnamedPanes.has(agent.paneId) ? [] : [
					{ ref: { agentId: run.agentId, runId: run.runId }, alive: names.has(agent.herdrName) },
				]);
				await this.store.finishMaintenance(token, observations, this.now());
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
		if (!(await this.deps.client.isAlive(record.herdrName))) await this.store.recordPaneClosed(ref, this.now());
		else await this.store.expireUnacceptedRun(ref, this.now());
	}

	close(): Promise<void> {
		return this.closing ??= (async () => {
			this.stopping.abort();
			await Promise.allSettled([...this.active]);
			try { await this.store.retireOwner(this.owner); }
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
		if (!request.paneId) throw new Error("Not inside a Herdr pane, so no subagent pane can be opened.");
		await this.store.assertProtocolReady();
		check(signal);
		const parent = request.sessionFile ? await this.store.agentForSession(request.paneId, request.sessionFile) : undefined;
		check(signal);
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > HERDR_MAX_DEPTH) throw new Error(`Subagent depth ${depth} exceeds the Herdr limit of ${HERDR_MAX_DEPTH}.`);
		if (request.inheritContext && (!request.sessionFile || !existsSync(request.sessionFile))) throw new Error("inherit_context was set, but this session has no file to clone.");
		const definition = loadAgent(request);
		const base = herdrAgentName(request.name, request.subagentType);
		const sessionFile = join(this.deps.root, "sessions", `${randomUUID()}.jsonl`);
		let ref: RunRef | undefined;
		let task: HerdrTask | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			check(signal);
			const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
			const id = `${base.slice(0, 31 - suffix.length)}${suffix}`;
			if (await this.deps.client.isAlive(id)) continue;
			check(signal);
			task = {
				id, herdrName: id, paneId: "", depth, type: request.subagentType,
				description: request.description, prompt: request.prompt, instructions: definition?.body || undefined,
				allowedTools: allowedTools(request.isolated || definition?.isolated, definition?.tools),
				maxTurns: request.maxTurns ?? definition?.maxTurns, model: request.model ?? definition?.model,
				thinking: request.thinking ?? definition?.thinking, parentPaneId: request.paneId,
				createdAt: new Date(this.now()).toISOString(),
			};
			ref = await this.store.reserveAgent(task, sessionFile, this.owner, this.now());
			if (ref) break;
		}
		if (!ref || !task) throw new Error(`Could not reserve a Herdr agent name for ${base}`);
		let paneId: string | undefined;
		let published = false;
		let creationIssued = false;
		try {
			check(signal);
			await mkdir(join(this.deps.root, "sessions"), { recursive: true });
			check(signal);
			if (request.inheritContext) await copyFile(request.sessionFile!, sessionFile);
			else await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: task.createdAt, cwd: request.cwd }) + "\n", { flag: "wx" });
			check(signal);
			await this.withPlacement(async () => {
				await this.recoverLaunches();
				check(signal);
				const target = await this.choosePlacement(request, signal);
				await this.store.recordLaunch(ref!, this.owner, "creating", { tabId: target.tabId }, this.now());
				check(signal);
				// Once issued, pane creation is never blindly retried: its outcome may be ambiguous.
				creationIssued = true;
				const created = target.newTab
					? await this.deps.client.createTab({ cwd: request.cwd, label: request.description })
					: await this.deps.client.split({ paneId: request.paneId, direction: target.direction!, cwd: request.cwd });
				paneId = created.paneId;
				await this.store.recordLaunch(ref!, this.owner, "pane-created", { paneId, tabId: "tabId" in created && typeof created.tabId === "string" ? created.tabId : target.tabId }, this.now());
				check(signal);
			}, signal);
			check(signal);
			await this.store.recordLaunch(ref, this.owner, "starting-pi", {}, this.now());
			check(signal);
			task.paneId = paneId!;
			await this.deps.client.startPi({ name: task.id, paneId: paneId!, args: piArgs(task, sessionFile) });
			check(signal);
			await this.store.publish(ref, taskMessage(task), request.runInBackground, this.now());
			published = true;
			if (signal.aborted) { await this.cancel(ref); return ref; }
			await this.deps.client.showLabel(paneId!, paneLabel(task.id, task.model, task.thinking)).catch(() => undefined);
			if (signal.aborted) await this.cancel(ref);
			return ref;
		} catch (error) {
			if (published) { await this.cancel(ref); throw error; }
			const failure = await this.cleanup(ref, paneId, message(error), signal.aborted, creationIssued);
			throw new Error(failure);
		}
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

	private async choosePlacement(request: SpawnRequest, signal: AbortSignal): Promise<{ newTab: boolean; tabId?: string; direction?: "right" | "down" }> {
		if (!request.tabId) return { newTab: true };
		let observed: HerdrAgentRef[];
		try { observed = await this.deps.client.listAgents(); }
		catch { check(signal); return { newTab: true }; }
		check(signal);
		const launches = await this.store.launches();
		check(signal);
		const panes = new Set(observed.filter((item) => item.tabId === request.tabId && item.paneId).map((item) => item.paneId!));
		panes.add(request.paneId);
		let unknown = observed.filter((item) => item.tabId === request.tabId && !item.paneId).length;
		for (const pending of launches) {
			if (pending.tabId !== request.tabId || pending.stage === "closed") continue;
			if (pending.stage === "published" && pending.paneId && !panes.has(pending.paneId)) {
				const alive = await this.deps.client.isAlive(pending.agentId);
				check(signal);
				if (!alive) { await this.store.releasePlacement(pending); continue; }
			}
			if (pending.paneId) panes.add(pending.paneId);
			else unknown++;
		}
		if (needsNewTab(panes.size + unknown)) return { newTab: true };
		const layout = await this.deps.client.layout(request.paneId);
		check(signal);
		return { newTab: false, tabId: request.tabId, direction: splitDirection(layout) };
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

function ownerAlive(owner: string): boolean {
	const pid = Number(owner.split(":")[0]);
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
		const snapshot = await runner.read(ref);
		if (deps.signal?.aborted) return text(formatStatus(record, snapshot), { ...ref, paneId: record.paneId, status: snapshot.phase });
		if (request.runInBackground) return text(
			`Agent ${request.resume ? "resumed" : "started"} in a Herdr pane.\nAgent ID: ${ref.agentId}\nRun ID: ${ref.runId}\nPane: ${record.paneId}\nType: ${record.type}\nDescription: ${record.description}\n\nYou will be notified when this run completes.\nUse get_subagent_result for full results, or steer_subagent to send messages.\nDo not duplicate this agent's work.`,
			{ ...ref, status: "background", paneId: record.paneId },
		);
		return resultForRun(runner, record, ref, true, deps.signal);
	});
}

export async function readHerdrAgent(root: string, agentId: string, options: { wait?: boolean; verbose?: boolean; runId?: string }, deps: Omit<RunnerDeps, "root">): Promise<ToolText> {
	return usingRunner({ ...deps, root }, async (runner) => {
		const record = await runner.resolve(agentId);
		const ref = { agentId: record.id, runId: options.runId ?? record.currentRunId };
		const result = await resultForRun(runner, record, ref, options.wait === true, deps.signal);
		if (options.verbose) result.text += `\n\nFull conversation is in Herdr pane ${record.paneId}.`;
		return result;
	});
}

export async function steerHerdrAgent(root: string, agentId: string, messageText: string, deps: Omit<RunnerDeps, "root">): Promise<ToolText> {
	return usingRunner({ ...deps, root }, async (runner) => {
		const record = await runner.resolve(agentId);
		const ref = { agentId: record.id, runId: record.currentRunId };
		await runner.steer(ref, messageText);
		return text(`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\nPane: ${record.paneId}`, { ...ref });
	});
}

export function completionNotice(notice: CompletionNotice): string {
	const preview = (notice.run.result || notice.run.error || "No output.").slice(0, 500);
	return `Background agent ${notice.run.phase}: ${notice.agent.description}\nAgent ID: ${notice.agentId}\nRun ID: ${notice.runId}\nPane: ${notice.agent.paneId}\n\n${preview}\n\nUse get_subagent_result with agent_id "${notice.agentId}" and run_id "${notice.runId}" for full output.`;
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
	return text(formatStatus(record, snapshot), { ...ref, status: snapshot.phase, paneId: record.paneId });
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
	for (const dir of [join(request.cwd, ".pi", "agents"), request.agentDir ? join(request.agentDir, "agents") : ""].filter(Boolean)) {
		const path = join(dir, `${request.subagentType}.md`);
		if (existsSync(path)) return parseAgentFile(readFileSync(path, "utf8"));
	}
	return undefined;
}

function formatStatus(record: AgentRecord, snapshot: RunSnapshot): string {
	const header = `Agent: ${record.id}\nRun: ${snapshot.runId}\nType: ${record.type} | Status: ${snapshot.phase}\nDescription: ${record.description}\nPane: ${record.paneId}\n`;
	if (snapshot.cancelRequested && !isTerminal(snapshot.phase)) return `${header}\nCancellation requested; waiting for the child to stop.`;
	if (snapshot.phase === "blocked") return `${header}\nAgent is blocked in Herdr pane ${record.paneId}. Answer the prompt there.`;
	if (!isTerminal(snapshot.phase)) return `${header}\nAgent is still ${snapshot.phase}. Use wait: true or check back later.`;
	return `${header}\n${[snapshot.result, snapshot.error].filter(Boolean).join("\n\n") || "No output."}`;
}

function text(value: string, details: Record<string, unknown> = {}): ToolText { return { text: value, details }; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function check(signal: AbortSignal): void { if (signal.aborted) throw new Error("Stopped"); }
