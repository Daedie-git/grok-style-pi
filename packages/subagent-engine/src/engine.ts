// The engine: one per root Pi session runtime. It owns the registry, stores and backend, and implements the Agent,
// SendMessage and TaskStop behaviors shared by the root tools and every child's installer.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRuntime, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { InProcessBackend, type SessionSpec } from "./backends/in-process.ts";
import { Control, limitsFromEnv, type Conversation } from "./control.ts";
import { compileToolSurface, type ToolLite } from "./context/capabilities.ts";
import { resolveEffort, resolveModel, roleDefaultEffort, type ModelLite } from "./context/model.ts";
import { childSystemPrompt, contextFilePolicy, taskMessage } from "./context/prompt.ts";
import { discoverDefinitions, selectDefinition, type DefinitionSet } from "./definitions/discovery.ts";
import { launchResultText, noticeText } from "./policy/text.ts";
import { memoryDir, memoryIndex, memoryPathGuard } from "./memory.ts";
import { truncateResult } from "./results.ts";
import { buildForkEntries, writeForkSession } from "./context/fork.ts";
import { WorkflowTasks } from "./workflow-tool.ts";
import type { WorkflowProgress } from "./workflow/host.ts";
import type { WorkflowRunResult } from "./workflow/runtime.ts";
import { HerdrRuns, type HerdrRunsPort } from "./backends/herdr-runs.ts";
import { FORK_DIRECTIVE } from "./definitions/builtins.ts";
import { runInterruptedStopHooks, runStartHooks, type HookEnvironment } from "./hook-integration.ts";
import { cleanupWorktree, createWorktree, restoreWorktree, translationNote } from "./worktree.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { forkContextSkills, loadSkills, preloadSkills, skillAgentType, type SkillInfo } from "./skills.ts";
import { InboxStore } from "./store/inbox.ts";
import { TaskStore, type TaskHooks } from "./tasks/store.ts";
import { listMetas, writeMeta } from "./store/meta.ts";
import { Outbox } from "./store/outbox.ts";
import { agentFiles, newAgentId, newRunId, sessionDir } from "./store/paths.ts";
import type { AgentDefinition, AgentId, AgentMeta, Envelope, KilledBy, NoticePayload, NoticeRecord, RunHandle, RunId, RunOutcome, SendReceipt } from "./types.ts";

export const NOTICE_TYPE = "subagent-notification";
export const AUTO_BACKGROUND_MS = 120_000;
export const MAIN_MESSAGE_TYPE = "subagent-message";

/** Who is calling a tool: the root conversation, or a child agent through its installer. */
export interface Caller {
	agentId?: AgentId;
	depth: number;
	background: boolean;
	isFork: boolean;
	/** Agent(a,b) restriction from the caller's definition. */
	allowedAgentTypes?: string[];
	/** Tools granted only for agent memory, and the guard confining them to the memory directory (plan §11, §17.8). */
	memoryScoped?: string[];
	memoryGuard?: (toolName: string, args: Record<string, unknown>) => string | undefined;
	/** The compiled tool policy for this child; every call is checked against it, not the mutable active loadout. */
	allowedTools?: ReadonlySet<string>;
}

export const ROOT_CALLER: Caller = { depth: 0, background: false, isFork: false };

export interface AgentParams {
	description: string;
	prompt: string;
	/** Herdr panes only (plan §13): explicit opt-in to a pane, a saved machine, or the Claude Code runtime. */
	backend?: "in-process" | "pane";
	runtime?: "pi" | "claude-code";
	machine?: string;
	machine_cwd?: string;
	subagent_type?: string;
	model?: string;
	effort?: string;
	run_in_background?: boolean;
	name?: string;
	isolation?: string;
}

export interface ToolText {
	text: string;
	isError?: boolean;
	details?: Record<string, unknown>;
	/** Pi-shaped usage, attributed to the calling session once (foreground runs, plan §17.13). */
	usage?: PiUsage;
}

export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function piUsage(totals: import("./types.ts").UsageTotals): PiUsage {
	return {
		input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, totalTokens: totals.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totals.cost },
	};
}

export interface EngineDeps {
	env: Record<string, string | undefined>;
	agentDir: string;
	modelRuntime: () => Promise<ModelRuntime>;
	now?: () => number;
	/** Installs the child-side tools and policy handlers into a child session. Supplied by the extension wiring. */
	childInstaller: (engine: Engine, caller: Caller) => (pi: ExtensionAPI) => void;
	/** Test hook forwarded to the backend. */
	onSessionCreated?: (session: import("@earendil-works/pi-coding-agent").AgentSession, agentId: AgentId) => void;
	homeDir?: string;
	/** TaskCreated/TaskCompleted hook adapters (plan §9). */
	taskHooks?: (engine: Engine) => TaskHooks;
}

interface RootBinding {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sessionId: string;
	generation: number;
	ready: boolean;
	uiPromptOpen: number;
}

/** Engine-internal launches (Workflow agent() calls): extra denies and installers, never a model-visible tool call. */
export interface InternalSpawn {
	extraDenied: string[];
	workflow?: AgentMeta["workflow"];
	installers: import("@earendil-works/pi-coding-agent").ExtensionFactory[];
	/** Tools the installers register that must stay in the child's policy regardless of its definition's tool list. */
	extraTools?: string[];
	/** Ends the child at the next turn boundary when true, whatever its sibling tools decided (re-review RR05). */
	shouldEndTurn?: () => boolean;
}

interface ParentContext {
	branch: SessionEntry[];
	systemPrompt: string;
	tools: string[];
	sessionFile?: string;
	leafId?: string;
}

interface RunRecord {
	handle: RunHandle;
	agentId: AgentId;
	/** A foreground caller received the result directly; its notice is passive. */
	deliveredSynchronously: boolean;
	background: boolean;
}

export class Engine {
	readonly control: Control;
	private backend?: InProcessBackend;
	private root?: RootBinding;
	private generation = 0;
	private outbox?: Outbox;
	private readonly inboxes = new Map<AgentId, InboxStore>();
	private readonly runs = new Map<RunId, RunRecord>();
	private definitionCache?: { at: number; set: DefinitionSet };
	private readonly now: () => number;
	private sweepTimer?: ReturnType<typeof setInterval>;
	private readonly listeners = new Set<(event: EngineEvent) => void>();

	private deps: EngineDeps;

	/**
	 * Rebind runtime-scoped dependencies after a reload handover: children created from now on must use the new runtime's
	 * policy (autonomy) and installers, not closures captured by the runtime that created this engine.
	 */
	rebindRuntime(deps: Pick<EngineDeps, "childInstaller"> & Partial<Pick<EngineDeps, "taskHooks">>): void {
		this.deps = { ...this.deps, ...deps };
		this.tasks = undefined;
	}

	constructor(deps: EngineDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.resetBound();
		this.control = new Control(limitsFromEnv(deps.env), {
			persist: (meta) => this.persistMeta(meta),
			inboxOf: (agentId) => this.inbox(agentId),
			newRunId,
			now: this.now,
		});
	}

	// ---- Root lifecycle ----

	/** The root session this engine serves. It outlives individual bindings (a reload rebinds the same session). */
	sessionId?: string;
	private projectTrusted = false;
	private bound!: Promise<void>;
	private markBound!: () => void;

	private resetBound(): void {
		this.bound = new Promise((resolve) => { this.markBound = resolve; });
	}

	async bindRoot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
		this.generation++;
		const sessionId = ctx.sessionManager.getSessionId();
		if (this.sessionId && this.sessionId !== sessionId) throw new Error("An engine serves one root session; create a new engine for another session.");
		const first = this.sessionId === undefined;
		this.sessionId = sessionId;
		this.projectTrusted = ctx.isProjectTrusted();
		this.root = { pi, ctx, sessionId, generation: this.generation, ready: false, uiPromptOpen: 0 };
		if (first) {
			mkdirSync(sessionDir(this.deps.agentDir, sessionId), { recursive: true });
			this.outbox = new Outbox(join(sessionDir(this.deps.agentDir, sessionId), "outbox.jsonl"));
			this.restorePersisted(sessionId);
			this.reconcileReceipts();
		}
		this.outbox!.recover();
		this.receiptCursor = 0;
		this.recoverMainInbox();
		this.backend ??= new InProcessBackend({
			modelRuntime: await this.deps.modelRuntime(), now: this.now, onSessionCreated: this.deps.onSessionCreated,
			onBudgetExhausted: (agentId) => this.preventContinuation(agentId, "budget"),
			onHostEnded: (agentId) => this.refuseQueuedInput(agentId, "The agent ended its work before it could use this message."),
		});
		this.sweepTimer ??= setInterval(() => void this.sweep(), 5000);
		this.sweepTimer.unref?.();
		this.root.ready = true;
		this.markBound();
		this.observeReceipts();
		void this.deliverRoot();
	}

	/** Reload handover (plan §17.11): keep children running; a new extension runtime adopts this engine and rebinds. */
	detachRoot(): void {
		this.root = undefined;
		this.resetBound();
	}

	/**
	 * Rebuild the registry from disk for a root session this process has not served yet (process restart, /resume).
	 * Runs recorded as running belonged to a process that no longer exists, so they are marked failed.
	 */
	private restorePersisted(sessionId: string): void {
		for (const meta of listMetas(sessionDir(this.deps.agentDir, sessionId))) {
			if (this.control.get(meta.agentId)) continue;
			// Finished pane runs keep only their receipt routing, so a replayed notice can still release its source (re-review RR06).
			if (meta.backend === "herdr") {
				for (const summary of meta.runs) {
					if (summary.status === "running") continue;
					try {
						this.paneRuns.restoreTerminal(meta, summary.runId);
						// A destination commitment whose metadata write failed is still durable in the outbox (RR06 follow-up).
						if (this.outbox?.acknowledgedRun(meta.agentId, summary.runId)) this.paneRuns.acknowledgeDestination(meta.agentId, summary.runId);
					} catch (receiptError) {
						this.reportDiagnostics(meta.agentId, [`Could not restore the receipt of pane run ${summary.runId}: ${(receiptError as Error).message}`]);
					}
				}
			}
			// A Herdr pane outlives this process: re-attach its still-running run instead of failing it (pre-push review #3).
			const paneRun = meta.backend === "herdr" && meta.herdr ? meta.runs.findLast((run) => run.status === "running") : undefined;
			if (paneRun) {
				const restored = this.control.restoreActive(meta, paneRun.runId);
				// A durable user stop whose cancellation never reached the pane is carried over and re-sent on attach.
				if (meta.stoppedByUser && restored.active) restored.active.cancelRequested = "user";
				try {
					this.paneRuns.restore(meta, paneRun.runId);
					if (restored.active?.cancelRequested) this.cancelRun(meta.agentId, restored.active.cancelRequested);
					continue;
				} catch (restoreError) {
					this.control.rollbackSpawn(meta.agentId, paneRun.runId);
					this.reportDiagnostics(meta.agentId, [`Could not reattach the pane run: ${(restoreError as Error).message}`]);
				}
			}
			let changed = false;
			for (const run of meta.runs) {
				if (run.status !== "running") continue;
				Object.assign(run, { status: "failed", classification: "failed", endedAt: this.now(), resultText: run.resultText ?? "Interrupted: the session that ran this agent ended." });
				changed = true;
			}
			this.control.restore(meta);
			if (changed) this.persistMeta(meta);
		}
	}

	async shutdownRoot(reason: string): Promise<void> {
		const binding = this.root;
		this.root = undefined;
		this.resetBound();
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = undefined;
		void binding; // a detached engine (reload handover that was never adopted) still owns and must stop its children
		await Promise.race([this.workflowTasks?.stopAll(), new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
		for (const conversation of this.control.conversations.values()) {
			if (!conversation.active) continue;
			for (const agentId of this.control.requestStop(conversation.meta.agentId, "session-end")) this.cancelRun(agentId, "session-end");
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled([
				...[...this.runs.values()].map((run) => run.handle.execution),
				// Teardown after settlement (stop hooks, worktree cleanup) is part of shutting down.
				...[...this.control.conversations.values()].flatMap((conversation) => conversation.exiting ? [conversation.exiting] : []),
			]),
			new Promise((resolve) => { timer = setTimeout(resolve, 5000); }),
		]);
		clearTimeout(timer);
		await this.backend?.disposeAll(reason === "reload" ? "reload" : "quit");
		this.paneRuns.dispose();
	}

	notePrompt(open: boolean): void {
		if (!this.root) return;
		this.root.uiPromptOpen = Math.max(0, this.root.uiPromptOpen + (open ? 1 : -1));
		if (!open) void this.deliverRoot();
	}

	/** Called after the root persists entries; acknowledges notices whose custom_message entry is now in history. */
	observeReceipts(): void {
		const root = this.root;
		if (!root || !this.outbox) return;
		// Only entries appended since the last check are scanned; the cursor resets on every root binding (reload, resume).
		const all = root.ctx.sessionManager.getEntries() as { type: string; customType?: string; details?: unknown }[];
		if (this.receiptCursor > all.length) this.receiptCursor = 0;
		const entries = all.slice(this.receiptCursor);
		this.receiptCursor = all.length;
		const keys = this.outbox.observePersisted(entries);
		if (keys.length > 0) this.ackNotices(keys);
		this.observeMainReceipts(entries);
	}

	private receiptCursor = 0;

	subscribe(listener: (event: EngineEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// ---- Definitions ----

	async definitions(): Promise<DefinitionSet> {
		const cached = this.definitionCache;
		if (cached && this.now() - cached.at < 2000) return cached.set;
		const ctx = this.requireRoot().ctx;
		const set = await discoverDefinitions({
			cwd: ctx.cwd, agentDir: this.deps.agentDir, projectTrusted: ctx.isProjectTrusted(),
			forkEnabled: this.forkEnabled(), flagJson: this.deps.env.PI_AGENTS_JSON, policyDir: this.deps.env.PI_AGENTS_POLICY_DIR,
			homeDir: this.deps.homeDir,
		});
		this.definitionCache = { at: this.now(), set };
		return set;
	}

	forkEnabled(): boolean {
		const value = this.deps.env.PI_SUBAGENT_FORK;
		return value === "1" || value === "true";
	}

	// ---- Agent ----

	async spawn(params: AgentParams, caller: Caller, invocation: { toolCallId: string; signal?: AbortSignal; ctx: ExtensionContext; origin?: "user" | "model"; internal?: InternalSpawn }): Promise<ToolText> {
		const root = this.requireRoot();
		const skillRequest = params.subagent_type?.trim().startsWith("skill:") ?? false;
		if (!params.description?.trim() || (!params.prompt?.trim() && !skillRequest)) return error("Agent needs a description and a prompt.");
		const set = await this.definitions();
		const requestedType = params.subagent_type?.trim() || "general-purpose";
		// Skill-scoped children are fresh agents built from a context:fork skill, not conversation forks (plan §16.9).
		const skill = requestedType.startsWith("skill:") ? this.skillDefinition(set, requestedType.slice("skill:".length), invocation.origin ?? "model") : undefined;
		if (skill && "error" in skill) return error(skill.error);
		const selected = skill ? { definition: skill.definition } : selectDefinition(set, requestedType);
		if (!selected.definition) return error(("error" in selected && selected.error) || `Unknown agent type "${requestedType}".`);
		const definition = invocation.internal
			? { ...selected.definition, disallowedTools: [...selected.definition.disallowedTools, ...invocation.internal.extraDenied] }
			: selected.definition;
		if (skill) params = { ...params, prompt: [skill.skill.content, params.prompt ?? ""].filter((part) => part.trim()).join("\n\n") };
		if (!params.prompt?.trim()) return error("Agent needs a prompt.");
		if (caller.allowedAgentTypes && !caller.allowedAgentTypes.includes(definition.agentType)) {
			return error(`This agent may only launch: ${caller.allowedAgentTypes.join(", ")}.`);
		}
		// The caller's current definition can only narrow the subtypes it launched with (re-review RR02).
		if (caller.agentId) {
			const decision = await this.currentCapability(caller.agentId, "Agent");
			if (decision && "error" in decision) return error(decision.error);
			if (decision && !decision.surface.active.includes("Agent")) return error(`The current definition of "${decision.agentType}" no longer allows Agent.`);
			const current = decision?.surface.allowedAgentTypes;
			if (current && !current.includes(definition.agentType)) return error(`This agent may only launch: ${current.join(", ") || "no agent types"}.`);
		}
		const isFork = definition.builtIn === "fork";
		if (isFork && caller.isFork) return error("A fork cannot start another fork.");
		if (params.isolation && params.isolation !== "worktree") return error(`Isolation "${params.isolation}" is not supported. Use "worktree" or omit it.`);
		const isolate = params.isolation === "worktree" || definition.isolation === "worktree";
		// A fork inherits the caller's own conversation: the root's, or the calling agent's (plan §2.2).
		const parent = isFork ? this.parentContext(caller, invocation.ctx) : undefined;
		if (isFork && !parent) return error("The calling conversation is not available to fork.");
		const pane = params.backend === "pane" || Boolean(params.machine?.trim()) || params.runtime === "claude-code";
		if (pane && !this.paneRuns.available()) return error("Herdr panes are only available when running inside Herdr.");
		if (pane && (isFork || isolate || invocation.internal || skill)) return error("Forks, worktree isolation, workflow agents and skill agents run in-process; omit backend/machine/runtime.");
		const name = params.name?.trim();
		if (name && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) return error("Agent names use letters, digits, underscores and hyphens, starting with a letter.");
		if (name === "main") return error(`"main" is reserved for the main conversation.`);
		const background = definition.background === true || params.run_in_background !== false;

		const parentModel = invocation.ctx.model;
		if (!parentModel) return error("No model is selected for this session.");
		const available = invocation.ctx.modelRegistry.getAvailable();
		const modelChoice = resolveModel({
			invocation: params.model, definition: definition.model, env: this.deps.env, isFork,
			parent: liteModel(parentModel), available: available.map(liteModel),
		});
		const model = invocation.ctx.modelRegistry.find(modelChoice.model.provider, modelChoice.model.id) ?? parentModel;
		const parentThinking = (caller.agentId ? this.backend?.session(caller.agentId)?.thinkingLevel : undefined) ?? root.pi.getThinkingLevel();
		const effortChoice = resolveEffort({
			invocation: params.effort, definition: definition.effort, roleDefault: roleDefaultEffort(definition.agentType),
			parent: parentThinking, env: this.deps.env, isFork,
		});

		const agentId = newAgentId();
		const files = agentFiles(this.deps.agentDir, root.sessionId, agentId);
		const meta: AgentMeta = {
			agentId, agentType: definition.agentType, description: params.description.trim(), rootSessionId: root.sessionId,
			spawnDepth: caller.depth + 1, cwd: invocation.ctx.cwd, sessionFile: files.sessionFile, taskListId: this.taskListId(),
			backend: "in-process", definition, stopGeneration: 0, runs: [], toolUseId: invocation.toolCallId,
			model: { requested: params.model, effective: `${model.provider}/${model.id}` },
			effort: { requested: params.effort, effective: effortChoice.effort ?? parentThinking },
		};
		if (name) meta.name = name;
		if (caller.agentId) { meta.parentAgentId = caller.agentId; meta.ownerAgentId = caller.agentId; }
		if (definition.builtIn) meta.isBuiltIn = true;
		if (isFork) meta.isFork = true;
		if (invocation.internal?.workflow) meta.workflow = invocation.internal.workflow;
		if (skill) meta.skill = { name: skill.skill.name, path: skill.skill.path, scope: skill.skill.allowedTools ?? [] };
		if (pane) meta.backend = "herdr";
		const reserved = this.control.reserveSpawn({ meta, background, uncapped: Boolean(invocation.internal) });
		if ("error" in reserved) return error(reserved.error);
		if (pane) return this.spawnHerdr(meta, reserved.runId, params, definition, background, invocation);

		let handle: RunHandle;
		const startAbortSource: KilledBy = invocation.internal ? "parent" : "user";
		// An abort while the child session initializes is recorded on the reservation and forwarded once a handle exists.
		const earlyAbort = () => { for (const id of this.control.requestStop(agentId, startAbortSource)) this.cancelRun(id, startAbortSource); };
		try {
			const notes: string[] = [];
			if (isolate) {
				const worktree = await createWorktree({ cwd: invocation.ctx.cwd, stateRoot: join(this.deps.agentDir, "subagents"), agentId });
				meta.worktree = { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit };
				meta.originCwd = invocation.ctx.cwd;
				meta.cwd = worktree.path;
				const note = translationNote(invocation.ctx.cwd, worktree.path);
				if (note) notes.push(note);
				this.persistMeta(meta);
			}
			const thinking = (effortChoice.effort ?? parentThinking) as ThinkingLevel;
			let prompt: string;
			if (parent) {
				const built = buildForkEntries({
					branch: parent.branch, spawningToolCallId: invocation.toolCallId, directive: FORK_DIRECTIVE(params.prompt),
					childSessionId: agentId, cwd: meta.cwd, parentSessionFile: parent.sessionFile, now: () => new Date(this.now()).toISOString(),
				});
				// The directive is delivered as the run's prompt, not as a stored entry.
				built.entries.pop();
				writeForkSession(meta.sessionFile, built);
				meta.forkParent = { sessionFile: parent.sessionFile ?? "", leafId: parent.leafId ?? "" };
				prompt = [FORK_DIRECTIVE(params.prompt), ...notes].join("\n\n");
			} else {
				const skills = definition.skills.length > 0 ? preloadSkills(definition.skills, loadSkills({ agentDir: this.deps.agentDir, cwd: meta.cwd, projectTrusted: this.projectTrusted })) : [];
				const start = await runStartHooks(this.hookEnvironment(), meta);
				prompt = [taskMessage({ prompt: params.prompt, preloadedSkills: skills }), ...notes, ...start.contextMessages.map((text) => `Additional context from a start hook:\n${text}`)].join("\n\n");
			}
			const sessionSpec = this.sessionSpec(meta, definition, model, thinking, background, parent, invocation.internal?.extraTools);
			if (invocation.internal) {
				sessionSpec.installers.push(...invocation.internal.installers);
				sessionSpec.shouldEndTurn = invocation.internal.shouldEndTurn;
			}
			// A stop that arrived during setup (start hooks, worktree) must not be lost before a handle exists.
			const pendingStop = this.control.get(agentId)?.active?.cancelRequested;
			if (pendingStop || invocation.signal?.aborted) {
				this.settle(agentId, reserved.runId, killedOutcome(pendingStop ?? "user"));
				return error("The agent was stopped before it started.");
			}
			handle = this.launch(meta.agentId, reserved.runId, sessionSpec, prompt, background, definition.maxTurns);
			if (!background) invocation.signal?.addEventListener("abort", earlyAbort, { once: true });
			this.forwardPendingStop(agentId, reserved.runId, handle);
			await handle.started;
			if (!background) invocation.signal?.removeEventListener("abort", earlyAbort);
			this.forwardPendingStop(agentId, reserved.runId, handle);
		} catch (launchError) {
			this.control.rollbackSpawn(agentId, reserved.runId);
			if (meta.worktree) await cleanupWorktree({ ...meta.worktree, repoRoot: meta.originCwd ?? invocation.ctx.cwd }).catch(() => undefined);
			return error(`Could not start the agent: ${(launchError as Error).message}`);
		}
		this.emit({ type: "spawned", agentId, runId: reserved.runId, meta });
		if (background) {
			return { text: launchResultText({ agentId, name, description: meta.description, background: true }), details: { agentId, runId: reserved.runId, status: "running", background: true } };
		}
		// Foreground: the caller waits; its abort cancels the child.
		const record = this.runs.get(reserved.runId)!;
		const abortSource: KilledBy = invocation.internal ? "parent" : "user";
		const onAbort = () => { for (const id of this.control.requestStop(agentId, abortSource)) this.cancelRun(id, abortSource); };
		invocation.signal?.addEventListener("abort", onAbort, { once: true });
		if (invocation.signal?.aborted) onAbort();
		try {
			const handoff = this.autoBackgroundMs(invocation.ctx, invocation.toolCallId);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const raced = await Promise.race([
				handle.execution.then((outcome) => ({ kind: "done" as const, outcome })),
				...(handoff ? [new Promise<{ kind: "background" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "background" }), handoff); })] : []),
			]);
			clearTimeout(timer);
			// Recheck after winning the race: a run that finished on the timer tick returns its real result (plan §4.2, L7).
			if (raced.kind === "background" && this.control.get(agentId)?.active?.runId === reserved.runId && this.control.setBackground(agentId, reserved.runId)) {
				record.deliveredSynchronously = false;
				record.background = true;
				invocation.signal?.removeEventListener("abort", onAbort);
				return { text: launchResultText({ agentId, name, description: meta.description, background: true }), details: { agentId, runId: reserved.runId, status: "running", background: true, autoBackgrounded: true } };
			}
			let outcome = raced.kind === "done" ? raced.outcome : await handle.execution;
			void record;
			// A foreground caller waits for the conversation's report, not one run: an agent parked on its own children (or
			// continuing with late messages) reports when it is finally done (review R07). Billing still sums every run.
			const settledRuns = [outcome];
			outcome = await this.awaitConversationReport(agentId, outcome, (extra) => settledRuns.push(extra));
			if (settledRuns.length > 1) outcome = { ...outcome, usage: { ...outcome.usage, billable: sumUsage(settledRuns.map((run) => run.usage.billable)) } };
			const result = truncateResult(outcome.resultText);
			const failed = outcome.status !== "completed" && !(outcome as { foregroundRecovered?: boolean }).foregroundRecovered;
			const body = [result.text || "(The agent returned no text.)", outcome.note ? `\n[${outcome.note}]` : ""].join("");
			return {
				text: `${body}\n\nagentId: ${agentId} (use SendMessage to continue this agent)`, isError: failed && outcome.status !== "killed" ? true : undefined,
				details: { agentId, runId: reserved.runId, status: outcome.status, classification: outcome.classification, usage: outcome.usage, background: false, resultText: result.text, error: outcome.error },
				usage: piUsage(outcome.usage.billable),
			};
		} finally {
			invocation.signal?.removeEventListener("abort", onAbort);
		}
	}

	// ---- SendMessage ----

	async sendMessage(params: { to: string; message: string; summary?: string }, caller: Caller, toolCallId: string): Promise<SendReceipt> {
		const to = params.to?.trim() ?? "";
		const text = params.message ?? "";
		if (!to || /[\r\n]/.test(to) || to.length > 128) return { success: false, message: "`to` must be a single agent name or id." };
		if (to === "*") return { success: false, message: "Broadcast is not supported. Send to one agent." };
		if (!text.trim()) return { success: false, message: "The message is empty." };
		if (looksLikeProtocolFrame(text)) return { success: false, message: "Structured protocol messages are not supported. Send plain text." };
		const callerConversation = caller.agentId ? this.control.get(caller.agentId) : undefined;
		if (callerConversation?.active?.cancelRequested || callerConversation?.meta.stoppedByUser) return { success: false, message: "You are being stopped; messages cannot be sent." };
		const summary = params.summary?.trim().slice(0, 200) || undefined;
		if (to === "main") {
			if (!caller.agentId) return { success: false, message: "You are the main conversation; there is no one to send to as main." };
			// Durable, deduplicated acceptance; delivery goes through the guarded root drain like notices (review R08).
			const accepted = this.mainInbox().accept({ acceptanceKey: `main:${caller.agentId}:${toolCallId}`, from: caller.agentId, to: "main", text, summary });
			if ("conflict" in accepted) return { success: false, message: "This tool call was already used for a different message." };
			void this.deliverRoot();
			return { success: true, delivery: "main", envelopeId: accepted.envelope.id, message: accepted.duplicate ? "Already queued for the main conversation." : "Queued for the main conversation." };
		}
		const resolved = this.control.resolveTarget(caller.agentId ?? "main", to);
		if ("error" in resolved) return { success: false, message: resolved.error };
		const agentId = resolved.agentId;
		if (agentId === caller.agentId) return { success: false, message: "An agent cannot message itself." };
		const accepted = this.inbox(agentId).accept({ acceptanceKey: `send:${toolCallId}`, from: caller.agentId ?? "main", to: agentId, text, summary });
		if ("conflict" in accepted) return { success: false, message: "This tool call was already used for a different message." };
		const envelope = accepted.envelope;
		if (accepted.duplicate && envelope.state !== "pending") return { success: true, delivery: "queued", envelopeId: envelope.id, agentId, message: "Already accepted." };
		return this.dispatchEnvelope(agentId, envelope);
	}

	// ---- TaskStop ----

	async stop(target: string, caller: Caller, source: KilledBy = "parent"): Promise<ToolText> {
		const id = target?.trim();
		if (!id) return error("Give the agent id to stop.");
		if (!caller.agentId && this.workflowTasks?.has(id)) return this.workflowTasks.stop(id)!;
		const resolved = this.control.resolveTarget(caller.agentId ?? "main", id);
		if ("error" in resolved) return error(resolved.error);
		const conversation = this.control.get(resolved.agentId)!;
		// Authorization matches the original: the main conversation may stop any agent; an agent may stop only its own record.
		if (caller.agentId && caller.agentId !== conversation.meta.agentId) return error("Only the main conversation can stop other agents.");
		if (!conversation.active) {
			if (conversation.exiting) {
				const record = [...this.runs.values()].find((run) => run.agentId === resolved.agentId);
				record?.handle.cancel(source);
				return { text: `Re-sent the stop signal to ${resolved.agentId}; it is still shutting down.` };
			}
			return error(`Agent ${resolved.agentId} is not running.`);
		}
		const cancelled = this.control.requestStop(resolved.agentId, source);
		for (const agentId of cancelled) this.cancelRun(agentId, agentId === resolved.agentId ? source : source === "user" ? "user" : "parent");
		this.resendFailedStops(resolved.agentId, cancelled);
		return { text: `Stopping ${resolved.agentId}${cancelled.length > 1 ? ` and ${cancelled.length - 1} of its subagents` : ""}.`, details: { agentId: resolved.agentId, stopped: cancelled } };
	}

	/** Compatibility read of a run's outcome (get_subagent_result). Earlier runs stay readable from their persisted summaries. */
	async readResult(target: string, caller: Caller, options: { runId?: string; wait?: boolean; signal?: AbortSignal }): Promise<ToolText> {
		const resolved = this.control.resolveTarget(caller.agentId ?? "main", target?.trim() ?? "");
		if ("error" in resolved) return error(resolved.error);
		const conversation = this.control.get(resolved.agentId)!;
		const runs = conversation.meta.runs;
		const run = options.runId ? runs.find((candidate) => candidate.runId === options.runId) : runs.at(-1);
		if (!run) return error(options.runId ? `No run ${options.runId} for ${resolved.agentId}.` : `Agent ${resolved.agentId} has no runs.`);
		if (run.status === "running" && options.wait) {
			const record = this.runs.get(run.runId);
			if (record) {
				await Promise.race([
					record.handle.execution.catch(() => undefined),
					new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true })),
				]);
			}
		}
		const status = run.status === "running" ? "running" : `${run.status}${run.classification ? ` (${run.classification})` : ""}`;
		const body = run.status === "running" ? "Still running; you will be notified when it finishes." : run.resultText || "(No report text.)";
		return { text: `Agent ${resolved.agentId}, run ${run.runId}: ${status}\n\n${body}`, details: { agentId: resolved.agentId, runId: run.runId, status: run.status } };
	}

	private tasks?: TaskStore;

	/** The shared task list for this root session; children reach the same list (plan §10, M4). */
	taskStore(): TaskStore {
		if (!this.sessionId) throw new Error("The subagent engine is not bound to a session.");
		this.tasks ??= new TaskStore({ root: join(this.deps.agentDir, "tasks"), listId: this.taskListId(), hooks: this.deps.taskHooks?.(this), now: this.now });
		return this.tasks;
	}

	// ---- Workflow (plan §18) ----

	private workflowTasks?: WorkflowTasks;
	private outputTokens = 0;

	workflows(): WorkflowTasks {
		this.workflowTasks ??= new WorkflowTasks({ engine: this, agentDir: this.deps.agentDir, env: this.deps.env });
		return this.workflowTasks;
	}

	/** The session output-token ledger read by a workflow's budget.spent() (root turns plus every child run). */
	sessionOutputTokens(): number {
		return this.outputTokens;
	}

	noteRootOutputTokens(tokens: number): void {
		if (Number.isFinite(tokens) && tokens > 0) this.outputTokens += tokens;
	}

	emitWorkflowProgress(taskId: string, runId: string, event: WorkflowProgress): void {
		this.emit({ type: "workflow-progress", taskId, runId, event });
	}

	/** A finished workflow reports to the root through the same durable outbox as agents (run-aware notice identity). */
	recordWorkflowCompletion(input: { taskId: string; runId: string; name: string; status: "running" | "completed" | "failed" | "killed"; result: WorkflowRunResult; journalFile: string }): void {
		this.emit({ type: "workflow-settled", taskId: input.taskId, runId: input.runId, status: input.status });
		const outbox = this.outbox;
		const sessionId = this.sessionId;
		if (!outbox || !sessionId) return;
		const summary = JSON.stringify({ result: input.result.result, agentCount: input.result.agentCount, failures: input.result.failures, logs: input.result.logs.slice(-20), error: input.result.error, durationMs: Math.round(input.result.durationMs) }, null, 2);
		const report = truncateResult(summary, 12_000);
		const status = input.status === "killed" ? "killed" : input.status === "failed" ? "failed" : "completed";
		outbox.create({
			rootSessionId: sessionId, agentId: input.taskId, runId: input.runId, kind: status === "killed" ? "stopped" : status === "failed" ? "terminal_failure" : "terminal_result",
			destination: "root", passive: false,
			payload: {
				agentId: input.taskId, description: input.name, status, resultText: report.text,
				resultTruncated: report.truncated, transcriptPath: input.journalFile, resumable: true, failure: input.result.error,
				workflow: { name: input.name, runId: input.runId, taskId: input.taskId, agentCount: input.result.agentCount, failures: input.result.failures.length },
			},
		});
		void this.deliverRoot();
	}

	/** Forward a stop that was requested before this run had a handle (setup, session creation, pane spawn). */
	private forwardPendingStop(agentId: AgentId, runId: RunId, handle: RunHandle): void {
		const active = this.control.get(agentId)?.active;
		if (active?.runId === runId && active.cancelRequested) {
			this.runAborts.get(runId)?.abort();
			handle.cancel(active.cancelRequested);
		}
	}

	/** Resolves once a conversation's post-settlement teardown (stop hooks, worktree cleanup) has finished. */
	async teardown(agentId: AgentId): Promise<void> {
		await this.control.get(agentId)?.exiting;
	}

	/** Read-only view of every known agent for UI projections; never exposes the mutable registry (review arch #5). */
	agentSnapshots(): AgentSnapshot[] {
		return [...this.control.conversations.values()].map((conversation) => {
			const meta = conversation.meta;
			const run = meta.runs.at(-1);
			const snapshot: AgentSnapshot = {
				agentId: meta.agentId, agentType: meta.agentType, description: meta.description, backend: meta.backend,
				disposition: conversation.disposition, running: Boolean(conversation.active), runId: conversation.active?.runId ?? run?.runId,
				status: run?.status, startedAt: conversation.active?.startedAt ?? run?.startedAt, endedAt: run?.endedAt,
				model: meta.model?.effective, effort: meta.effort?.effective, depth: meta.spawnDepth,
			};
			if (meta.name) snapshot.name = meta.name;
			if (meta.ownerAgentId) snapshot.ownerAgentId = meta.ownerAgentId;
			if (meta.workflow) snapshot.workflow = { ...meta.workflow };
			return snapshot;
		});
	}

	private readonly extensionSlots = new Map<string, Set<string>>();
	private readonly cancelFailed = new Set<RunId>();

	/** Live-launch accounting for one declared extension id, shared across registrations and reload adoption. */
	extensionAccounting(extensionId: string): Set<string> {
		let slots = this.extensionSlots.get(extensionId);
		if (!slots) { slots = new Set(); this.extensionSlots.set(extensionId, slots); }
		return slots;
	}

	/** User-source stop of a whole workflow (activity panel). */
	userStopWorkflow(taskId: string): boolean {
		const result = this.workflowTasks?.stop(taskId);
		return Boolean(result && !result.isError);
	}

	/** User-source stop (activity panel, commands). */
	async userStop(agentId: AgentId): Promise<void> {
		const fresh = this.control.requestStop(agentId, "user");
		for (const id of fresh) this.cancelRun(id, "user");
		this.resendFailedStops(agentId, fresh);
		this.emit({ type: "stopped", agentId });
	}

	/**
	 * Fail closed when a stopped conversation's definition is no longer offered or trusted (plan §17.7, §16.5).
	 * Built-ins and forks always remain available; a stored snapshot is a record of what ran, not a grant.
	 */
	private async continuationRefusal(conversation: Conversation, reserved = false): Promise<string | undefined> {
		const definition = conversation.meta.definition;
		if (conversation.meta.isFork) return undefined;
		if (!this.root) return undefined;
		if (conversation.meta.skill) {
			const skill = forkContextSkills(loadSkills({ agentDir: this.deps.agentDir, cwd: this.root.ctx.cwd, projectTrusted: this.projectTrusted }), "user").find((candidate) => candidate.name === conversation.meta.skill!.name);
			if (!skill) return `The skill "${conversation.meta.skill.name}" is no longer available, so this agent cannot continue.`;
			if (JSON.stringify(skill.allowedTools ?? []) !== JSON.stringify(conversation.meta.skill.scope)) return `The skill "${conversation.meta.skill.name}" changed its tool scope; start a new agent instead.`;
			return undefined;
		}
		if (definition.source === "built-in") return undefined;
		const set = await this.definitions();
		const current = set.active.get(definition.agentType);
		if (!current) return `The agent type "${definition.agentType}" is no longer available, so this agent cannot continue.`;
		if (current.source !== definition.source) return `The agent type "${definition.agentType}" now comes from a different source; start a new agent instead.`;
		return undefined;
	}

	/**
	 * Opt-in automatic foreground→background handoff (PI_AUTO_BACKGROUND_TASKS, 120 s). Suppressed while the calling assistant
	 * message has any tool call after this Agent call: releasing the Agent call would let that later call run while the child
	 * still works (plan §17.12). Pi's public tool info has no executionMode, so every later sibling counts.
	 */
	private autoBackgroundMs(ctx: ExtensionContext, toolCallId: string): number | undefined {
		const value = this.deps.env.PI_AUTO_BACKGROUND_TASKS;
		if (value !== "1" && value !== "true") return undefined;
		const branch = ctx.sessionManager.getBranch() as { type: string; message?: { role?: string; content?: { type?: string; id?: string }[] } }[];
		for (let index = branch.length - 1; index >= 0; index--) {
			const message = branch[index].type === "message" ? branch[index].message : undefined;
			if (message?.role !== "assistant") continue;
			const calls = (message.content ?? []).filter((block) => block.type === "toolCall");
			const position = calls.findIndex((call) => call.id === toolCallId);
			if (position >= 0) return position === calls.length - 1 ? AUTO_BACKGROUND_MS : undefined;
		}
		return AUTO_BACKGROUND_MS;
	}

	/** A context:fork skill the user may run directly. */
	userForkSkill(name: string): SkillInfo | undefined {
		const cwd = this.root?.ctx.cwd;
		if (!cwd) return undefined;
		return forkContextSkills(loadSkills({ agentDir: this.deps.agentDir, cwd, projectTrusted: this.projectTrusted }), "user").find((skill) => skill.name === name);
	}

	/** Fork-context skills offered to the model as `skill:<name>` agent types (never disable-model-invocation skills). */
	modelSkills(): SkillInfo[] {
		const cwd = this.root?.ctx.cwd;
		if (!cwd) return [];
		return forkContextSkills(loadSkills({ agentDir: this.deps.agentDir, cwd, projectTrusted: this.projectTrusted }), "model");
	}

	private skillDefinition(set: DefinitionSet, name: string, origin: "user" | "model"): { definition: AgentDefinition; skill: SkillInfo } | { error: string } {
		const cwd = this.root?.ctx.cwd ?? process.cwd();
		const skill = forkContextSkills(loadSkills({ agentDir: this.deps.agentDir, cwd, projectTrusted: this.projectTrusted }), origin).find((candidate) => candidate.name === name);
		if (!skill) return { error: origin === "model" ? `No skill "${name}" can be run as an agent by the model.` : `No context:fork skill named "${name}".` };
		const base = selectDefinition(set, skill.agent ?? "general-purpose");
		if (!base.definition) return { error: base.error ?? `The skill's agent type "${skill.agent}" is not available.` };
		const definition: AgentDefinition = {
			...base.definition, agentType: skillAgentType(skill.name), description: skill.description,
			tools: skill.allowedTools ?? base.definition.tools, model: skill.model ?? base.definition.model, effort: skill.effort ?? base.definition.effort,
			skills: [], builtIn: undefined,
		};
		return { definition, skill };
	}

	// ---- Herdr panes (plan §13, §17.6; review R04 R06 R15–R17): HerdrRuns owns the pane lifecycle ----

	private readonly paneRuns: HerdrRuns = new HerdrRuns({
		trackRun: (agentId, runId, handle, background) => {
			// Engine run handles cancel synchronously; pane cancellation failures surface as diagnostics instead of vanishing.
			// A failed send keeps the stop intent and marks the run so the next public Stop re-sends it (re-review RR07).
			const tracked: RunHandle = { ...handle, cancel: (source) => {
				void handle.cancel(source).then(() => { this.cancelFailed.delete(runId); }, (cancelError: unknown) => {
					this.cancelFailed.add(runId);
					this.reportDiagnostics(agentId, [`Pane cancellation failed: ${(cancelError as Error).message}`]);
					this.emit({ type: "stop-failed", agentId, runId });
				});
			} };
			this.trackRun(agentId, runId, tracked, background);
		},
		settle: (agentId, runId, outcome) => this.settle(agentId, runId, outcome),
		persist: (meta) => this.persistMeta(meta),
		forwardPendingStop: async (agentId, runId, handle) => {
			const active = this.control.get(agentId)?.active;
			if (active?.runId !== runId || !active.cancelRequested) return;
			this.runAborts.get(runId)?.abort();
			await handle.cancel(active.cancelRequested);
		},
		backgroundRun: (agentId, runId) => {
			this.control.setBackground(agentId, runId);
			const record = this.runs.get(runId);
			if (record) { record.background = true; record.deliveredSynchronously = false; }
		},
		includeEnvelopes: (agentId, runId, ids) => { for (const id of ids) this.inbox(agentId).setState(id, "included", { runId }); },
		emit: (event) => this.emit(event),
		diagnostic: (message) => this.emit({ type: "diagnostics", agentId: "herdr", messages: [message] }),
	});

	/** Attach (or, after a reload, re-attach) the Herdr transport; identity routing is restored before notices flow. */
	attachHerdr(port: HerdrRunsPort): () => void {
		const detach = this.paneRuns.rebind(port);
		// Re-send stops that were requested while no transport could carry them (restore, reload handover).
		for (const conversation of this.control.conversations.values()) {
			if (conversation.meta.backend === "herdr" && conversation.active?.cancelRequested) this.cancelRun(conversation.meta.agentId, conversation.active.cancelRequested);
		}
		return detach;
	}

	herdrAvailable(): boolean {
		return this.paneRuns.available();
	}

	private async spawnHerdr(meta: AgentMeta, runId: RunId, params: AgentParams, definition: AgentDefinition, background: boolean,
		invocation: { toolCallId: string; signal?: AbortSignal; ctx: ExtensionContext }): Promise<ToolText> {
		const result = await this.paneRuns.spawn(meta, runId, {
			prompt: params.prompt, description: meta.description, subagentType: definition.agentType, cwd: invocation.ctx.cwd, runInBackground: background,
			runtime: params.runtime, name: meta.name, model: params.model, thinking: params.effort, projectTrusted: this.projectTrusted,
			definitionsCwd: invocation.ctx.cwd, machine: params.machine?.trim() || undefined, machineCwd: params.machine_cwd,
		}, invocation.ctx, { background, signal: invocation.signal });
		return { text: result.text, isError: result.isError, details: result.details };
	}

	private async continueHerdr(conversation: Conversation, runId: RunId): Promise<void> {
		const ids = new Set(conversation.active!.envelopeIds);
		const envelopes = this.inbox(conversation.meta.agentId).undelivered().filter((envelope) => ids.has(envelope.id) || ids.size === 0);
		const prompt = envelopes.map((envelope) => envelope.text).join("\n\n---\n\n") || "Continue.";
		if (!this.paneRuns.available()) {
			this.settle(conversation.meta.agentId, runId, failedOutcome("Herdr panes are not available in this session."));
			return;
		}
		await this.paneRuns.resume(conversation.meta, runId, prompt, this.requireRoot().ctx, envelopes.map((envelope) => envelope.id));
	}

	/**
	 * Finish destination handoffs a restart interrupted (re-review 3): a persisted root notice is already in root history, and an
	 * owner notice whose envelope the owner's inbox accepted is already delivered. Both complete their acknowledgement, which
	 * also releases a pane source. Unconfirmed records stay as they are; nothing is acknowledged speculatively.
	 */
	private reconcileReceipts(): void {
		const keys: string[] = [];
		for (const record of this.outbox?.unfinished() ?? []) {
			if (record.destination === "root" ? record.state === "persisted" : this.inbox(record.destination).hasAcceptance(`notice:${record.key}`)) keys.push(record.key);
		}
		if (keys.length > 0) this.ackNotices(keys);
	}

	/** Mark engine notices acknowledged and release any Herdr notice that was waiting on them (plan §17.6). */
	private ackNotices(keys: string[]): void {
		this.outbox?.mark(keys, "acknowledged");
		for (const key of keys) {
			const notice = this.outbox?.identity(key);
			if (!notice) continue;
			// Every successful destination acknowledgement (root history or an owner's inbox) makes the run evictable.
			const conversation = this.control.get(notice.agentId);
			if (conversation) conversation.notified = true;
			this.paneRuns.acknowledgeDestination(notice.agentId, notice.runId);
		}
	}


	// ---- Internals: fork parents, hooks and prevention ----

	private parentContext(caller: Caller, ctx: ExtensionContext): ParentContext | undefined {
		if (caller.agentId) {
			const session = this.backend?.session(caller.agentId);
			if (!session) return undefined;
			return {
				branch: session.sessionManager.getBranch(), systemPrompt: session.systemPrompt, tools: session.getActiveToolNames(),
				sessionFile: session.sessionManager.getSessionFile(), leafId: session.sessionManager.getLeafId() ?? undefined,
			};
		}
		const root = this.requireRoot();
		return {
			branch: ctx.sessionManager.getBranch(), systemPrompt: ctx.getSystemPrompt(), tools: root.pi.getActiveTools(),
			sessionFile: ctx.sessionManager.getSessionFile(), leafId: ctx.sessionManager.getLeafId() ?? undefined,
		};
	}

	/** Common hook fields for root-level events (task hooks). */
	rootHookContext(): { rootSessionId: string; cwd: string; sessionFile: string } {
		const root = this.root;
		return { rootSessionId: this.sessionId ?? "", cwd: root?.ctx.cwd ?? process.cwd(), sessionFile: root?.ctx.sessionManager.getSessionFile() ?? "" };
	}

	hookEnvironment(): HookEnvironment {
		return { agentDir: this.deps.agentDir, projectTrusted: this.projectTrusted, env: this.deps.env };
	}

	private readonly stopHookAttempted = new Set<RunId>();
	private readonly prevented = new Set<RunId>();

	reportDiagnostics(agentId: AgentId, messages: string[]): void {
		this.emit({ type: "diagnostics", agentId, messages });
	}

	private readonly runAborts = new Map<RunId, AbortController>();

	/** A per-run signal that outlives Pi's low-level run, aborted by any cancellation of that run (stop hooks use it). */
	runSignal(runId: RunId): AbortSignal | undefined {
		return this.runAborts.get(runId)?.signal;
	}

	noteStopHookAttempted(runId: RunId): void {
		this.stopHookAttempted.add(runId);
	}

	/** Whether the child's active run may take another model turn (checked before a stop-hook retry). */
	turnAllowed(agentId: AgentId): boolean {
		const budget = this.backend?.budget(agentId);
		// A host-ended run (exhausted workflow handbacks) admits no stop-hook retry either (rereview follow-up, RR05).
		if (budget?.ended) return false;
		return !budget?.maxTurns || budget.turns < budget.maxTurns;
	}

	/**
	 * Stop-hook prevention (plan §17.2, §17.2a): clear the child's queue, return every envelope that was submitted but not yet
	 * included in a request to pending, and fence the run. Finalization then reserves a later continuation for them.
	 */
	/** A host-ended run: drop its queue and refuse, explicitly, the input it can no longer use (no continuation). */
	private refuseQueuedInput(agentId: AgentId, reason: string): void {
		this.backend?.clearQueue(agentId);
		const inbox = this.inbox(agentId);
		for (const envelope of inbox.undelivered()) {
			if (envelope.state === "submitted" || envelope.state === "persisted" || envelope.state === "prepared") inbox.setState(envelope.id, "refused", { refusedReason: reason });
		}
	}

	preventContinuation(agentId: AgentId, cause: "stop-hook" | "budget" = "stop-hook"): void {
		const runId = this.control.get(agentId)?.active?.runId;
		// Only a stop hook's continue:false classifies the run as prevented; a budget stop stays partial-max-turns.
		if (runId && cause === "stop-hook") this.prevented.add(runId);
		this.backend?.clearQueue(agentId);
		const inbox = this.inbox(agentId);
		for (const envelope of inbox.undelivered()) {
			if (envelope.state === "submitted" || envelope.state === "persisted" || envelope.state === "prepared") inbox.setState(envelope.id, "pending");
		}
	}

	// ---- Internals: launching and settling ----

	private sessionSpec(meta: AgentMeta, definition: AgentDefinition, model: Model<any>, thinking: ThinkingLevel, background: boolean, parent?: ParentContext, extraTools: string[] = []): SessionSpec {
		if (parent) { meta.forkSystemPrompt = parent.systemPrompt; meta.forkParentTools = parent.tools; }
		const forkPrompt = meta.isFork ? meta.forkSystemPrompt : undefined;
		const caller: Caller = { agentId: meta.agentId, depth: meta.spawnDepth, background, isFork: Boolean(meta.isFork) };
		const memory = definition.memory ? memoryDir(definition.memory, { agentDir: this.deps.agentDir, cwd: meta.cwd, agentType: definition.agentType }) : undefined;
		if (memory) caller.memoryGuard = memoryPathGuard(memory);
		const policy = contextFilePolicy(definition);
		return {
			agentId: meta.agentId, cwd: meta.cwd, agentDir: this.deps.agentDir, sessionFile: meta.sessionFile, model, thinkingLevel: thinking,
			projectTrusted: this.projectTrusted, depth: meta.spawnDepth,
			systemPrompt: forkPrompt !== undefined
				? { mode: "exact", text: forkPrompt }
				: { mode: "preamble", text: childSystemPrompt({ definition, cwd: meta.cwd, isBackground: background, memoryIndex: memory ? memoryIndex(memory) : undefined }) },
			noContextFiles: policy === "none",
			installers: [this.deps.childInstaller(this, caller)],
			selectTools: (tools: ToolInfo[]) => {
				const surface = compileToolSurface({
					definition, available: tools.map(toolLite), depth: meta.spawnDepth, maxDepth: this.control.limits.maxDepth,
					background, isFork: Boolean(meta.isFork), parentTools: meta.forkParentTools, memoryTools: memory ? ["read", "write", "edit"] : undefined,
				});
				caller.allowedAgentTypes = surface.allowedAgentTypes;
				caller.memoryScoped = surface.memoryScoped;
				// Host-installed handback tools (StructuredOutput) are always part of an internal child's policy.
				for (const name of extraTools) if (tools.some((tool) => tool.name === name) && !surface.active.includes(name)) surface.active.push(name);
				caller.allowedTools = new Set(surface.active);
				if (surface.unavailable.length > 0) meta.missingTools = surface.unavailable;
				return surface.active;
			},
		};
	}

	private launch(agentId: AgentId, runId: RunId, spec: SessionSpec, prompt: string, background: boolean, maxTurns?: number): RunHandle {
		const handle = this.requireBackend().run(spec, { runId, prompt, background, maxTurns, stallTimeoutMs: stallTimeout(this.deps.env) });
		return this.trackRun(agentId, runId, handle, background);
	}

	/** Register a run handle from any backend: settlement, events and cancellation all flow through the same paths. */
	private trackRun(agentId: AgentId, runId: RunId, handle: RunHandle, background: boolean): RunHandle {
		// A foreground caller receives the result in its tool call, so its notice is passive from the start (no race with settle).
		this.runs.set(runId, { handle, agentId, deliveredSynchronously: !background, background });
		this.control.markRunning(agentId, runId, handle);
		this.runAborts.set(runId, new AbortController());
		handle.subscribe((event) => {
			if (event.type === "envelope") this.inbox(agentId).setState(event.envelopeId, event.state);
			this.emit({ type: "run-event", agentId, runId, event });
		});
		handle.execution.then(
			(outcome) => this.settle(agentId, runId, outcome),
			(launchError) => this.settle(agentId, runId, failedOutcome(String((launchError as Error)?.message ?? launchError))),
		);
		return handle;
	}

	private settle(agentId: AgentId, runId: RunId, outcome: RunOutcome): void {
		this.cancelFailed.delete(runId);
		try {
			this.settleRun(agentId, runId, outcome);
		} catch (settleError) {
			// Settling after the root unbinds (shutdown) must not surface as an unhandled rejection.
			if (this.root) throw settleError;
		}
	}

	private settleRun(agentId: AgentId, runId: RunId, outcome: RunOutcome): void {
		const record = this.runs.get(runId);
		const conversation = this.control.get(agentId);
		if (!conversation) return;
		if (this.prevented.delete(runId) && outcome.status === "completed") outcome.classification = "prevented";
		this.noteRootOutputTokens(outcome.usage.billable.output);
		this.runAborts.delete(runId);
		const result = truncateResult(outcome.resultText);
		const finalized = this.control.finalize(agentId, runId, outcome, result);
		this.runs.delete(runId);
		if (!finalized) return;
		this.emit({ type: "settled", agentId, runId, outcome });
		const attempted = this.stopHookAttempted.delete(runId);
		// While a foreground caller is still waiting for this conversation, its reports stay passive (the caller receives them).
		const passive = Boolean(record?.deliveredSynchronously) || this.foregroundWaiters.has(agentId);
		const exiting = this.afterSettle(conversation, runId, outcome, result, finalized, passive, attempted).catch(() => undefined);
		if (!finalized.continuation) {
			// reserveContinuation defers while this is set, so a new run never starts against a checkout being cleaned up.
			const fence = exiting.then(() => {
				if (conversation.exiting !== fence) return;
				if (this.control.exited(agentId)) this.wake(agentId);
			});
			conversation.exiting = fence;
		}
	}

	/** Work after the settlement transaction: interrupted stop hooks, worktree cleanup, then reporting and wakes. */
	private async afterSettle(conversation: Conversation, runId: RunId, outcome: RunOutcome, result: { text: string; truncated: boolean },
		finalized: NonNullable<ReturnType<Control["finalize"]>>, deliveredSynchronously: boolean, stopHookAttempted: boolean): Promise<void> {
		const meta = conversation.meta;
		if (!stopHookAttempted && outcome.status !== "completed") await runInterruptedStopHooks(this.hookEnvironment(), meta, result.text);
		let worktree: NoticePayload["worktree"];
		const final = finalized.disposition === "evictable" || finalized.disposition === "stopped";
		if (meta.worktree && final && !meta.worktreeCleanlyRemoved) {
			// Never while parked or continuing: the conversation may still need its checkout (plan §12).
			const cleaned = await cleanupWorktree({ ...meta.worktree, repoRoot: meta.originCwd ?? meta.cwd }).catch((cleanupError) => ({ removed: false, kept: true, reason: String(cleanupError), commits: [] as string[] }));
			if (cleaned.removed) meta.worktreeCleanlyRemoved = true;
			this.persistMeta(meta);
			worktree = { ...meta.worktree, kept: cleaned.kept };
		}
		if (finalized.report) {
			const payload: NoticePayload = {
				agentId: meta.agentId, description: meta.description, status: outcome.status, classification: outcome.classification,
				resultText: result.text, resultTruncated: result.truncated, transcriptPath: meta.sessionFile, usage: outcome.usage,
				killedBy: outcome.killedBy, resumable: !meta.stoppedByUser, resumePending: Boolean(finalized.continuation),
				failure: outcome.error,
			};
			if (meta.name) payload.name = meta.name;
			if (worktree) payload.worktree = worktree;
			this.route(conversation, runId, finalized.report, payload, deliveredSynchronously);
		}
		if (finalized.continuation) void this.startContinuation(meta.agentId, finalized.continuation);
		for (const waiting of finalized.wakes) this.wake(waiting);
	}

	/** Route a run's report to its owner agent when one is eligible, else to the root (plan §4.3, §16.2). */
	private route(conversation: Conversation, runId: RunId, kind: NonNullable<ReturnType<Control["finalize"]>>["report"] & string, payload: NoticePayload, passive: boolean): void {
		const outbox = this.outbox;
		const sessionId = this.sessionId;
		if (!outbox || !sessionId) return;
		const { owner, edge } = this.control.beginRouting(conversation.meta.agentId, runId);
		if (owner && passive) {
			// The owner already received this result through its own Agent tool call: record it, never wake or queue input.
			const notice = outbox.create({ rootSessionId: sessionId, agentId: conversation.meta.agentId, runId, kind, destination: owner.meta.agentId, passive, payload });
			this.ackNotices([notice.key]);
			if (edge) this.control.releaseEdge(edge);
			return;
		}
		if (owner) {
			const notice = outbox.create({ rootSessionId: sessionId, agentId: conversation.meta.agentId, runId, kind, destination: owner.meta.agentId, passive, payload });
			const accepted = this.inbox(owner.meta.agentId).accept({
				acceptanceKey: `notice:${notice.key}`, from: conversation.meta.agentId, to: owner.meta.agentId, text: noticeText(payload), noticeKey: notice.key,
			});
			if (!("conflict" in accepted)) {
				this.ackNotices([notice.key]);
				if (edge) this.control.releaseEdge(edge);
				if (!accepted.duplicate) void this.dispatchEnvelope(owner.meta.agentId, accepted.envelope);
				return;
			}
		}
		if (edge) this.control.releaseEdge(edge);
		outbox.create({ rootSessionId: sessionId, agentId: conversation.meta.agentId, runId, kind, destination: "root", passive, payload });
		void this.deliverRoot();
	}

	/** Deliver an accepted envelope: into the live run, or by reserving a continuation (plan §8, §16.1). */
	private async dispatchEnvelope(agentId: AgentId, envelope: Envelope): Promise<SendReceipt> {
		const conversation = this.control.get(agentId);
		if (conversation && !conversation.active) {
			const refusal = await this.continuationRefusal(conversation);
			if (refusal) {
				this.inbox(agentId).setState(envelope.id, "refused", { refusedReason: refusal });
				return { success: false, agentId, message: refusal };
			}
		}
		const reservation = this.control.reserveContinuation(agentId, envelope.noticeKey ? "wake" : "continue", [envelope.id]);
		switch (reservation.kind) {
			case "live": {
				const record = this.runs.get(reservation.runId);
				const delivered = record ? await record.handle.deliver(envelope) : { ok: false as const, reason: "not-running" as const, message: "" };
				if (delivered.ok) {
					if (this.control.get(agentId)?.meta.backend !== "herdr") this.inbox(agentId).setState(envelope.id, "submitted");
					return { success: true, delivery: "queued", envelopeId: envelope.id, agentId, message: "Queued for the agent's next tool round. This confirms delivery, not that the agent has acted on it." };
				}
				if (delivered.reason === "unsupported") {
					this.inbox(agentId).setState(envelope.id, "refused", { refusedReason: delivered.message });
					return { success: false, agentId, message: delivered.message };
				}
				// The run is settling; finalization re-reads the inbox and continues with this message.
				return { success: true, delivery: "pending-continuation", envelopeId: envelope.id, agentId, message: "The agent is finishing; it will continue with this message." };
			}
			case "reserved":
				this.startContinuation(agentId, reservation.runId);
				return { success: true, delivery: "resumed", envelopeId: envelope.id, agentId, message: "The agent was idle; it is resuming with this message. You will be notified when it finishes." };
			case "deferred":
				return { success: true, delivery: "pending-continuation", envelopeId: envelope.id, agentId, message: reservation.reason };
			case "refused":
				this.inbox(agentId).setState(envelope.id, "refused", { refusedReason: reservation.reason });
				return { success: false, agentId, message: reservation.reason };
		}
	}

	private async startContinuation(agentId: AgentId, runId: RunId): Promise<void> {
		// A continuation needs the live root context (model registry); during a reload handover it waits for the rebind.
		await this.bound;
		const conversation = this.control.get(agentId);
		if (!conversation?.active || conversation.active.runId !== runId) return;
		// A stop that arrived while waiting for the root fences every backend before anything launches (re-review RR01).
		if (this.stopFenced(agentId, runId)) return;
		if (conversation.meta.backend === "herdr") {
			await this.continueHerdr(conversation, runId);
			return;
		}
		// Every reserved run (explicit message, finalization continuation, owner wake, admission retry) is revalidated here.
		const refusal = await this.continuationRefusal(conversation, true);
		if (this.stopFenced(agentId, runId)) return;
		if (refusal) {
			const inbox = this.inbox(agentId);
			for (const envelope of inbox.undelivered()) inbox.setState(envelope.id, "refused", { refusedReason: refusal });
			this.settle(agentId, runId, failedOutcome(refusal));
			return;
		}
		const ids = new Set(conversation.active!.envelopeIds);
		const envelopes = this.inbox(agentId).undelivered().filter((envelope) => ids.has(envelope.id) || ids.size === 0);
		const prompt = envelopes.map((envelope) => envelope.text).join("\n\n---\n\n") || "Continue.";
		// The stored definition is provenance, not authority: the current definition can only narrow it (review R03).
		const definition = await this.currentDefinition(conversation.meta);
		if (this.stopFenced(agentId, runId)) return;
		const root = this.requireRoot();
		const model = this.modelFor(conversation, root.ctx);
		if (!model) {
			this.settle(agentId, runId, failedOutcome("The agent's model is no longer available."));
			return;
		}
		if (conversation.meta.worktree && conversation.meta.worktreeCleanlyRemoved) {
			const restored = await restoreWorktree({ worktree: { ...conversation.meta.worktree, repoRoot: conversation.meta.originCwd ?? conversation.meta.cwd }, worktreeCleanlyRemoved: true });
			if ("error" in restored) {
				// Removal only happens for verified-unchanged worktrees, so a fresh checkout loses no work.
				try {
					const fresh = await createWorktree({ cwd: conversation.meta.originCwd ?? conversation.meta.cwd, stateRoot: join(this.deps.agentDir, "subagents"), agentId });
					conversation.meta.worktree = { path: fresh.path, branch: fresh.branch, baseCommit: fresh.baseCommit };
					conversation.meta.cwd = fresh.path;
				} catch (createError) {
					this.settle(agentId, runId, failedOutcome(`The agent's worktree was removed and could not be recreated: ${(createError as Error).message}`));
					return;
				}
			}
			conversation.meta.worktreeCleanlyRemoved = false;
			this.persistMeta(conversation.meta);
			if (this.stopFenced(agentId, runId)) return;
		}
		const spec = this.sessionSpec(conversation.meta, definition, model, (conversation.meta.effort?.effective ?? "medium") as ThinkingLevel, true);
		const handle = this.launch(agentId, runId, spec, prompt, true, definition.maxTurns);
		this.forwardPendingStop(agentId, runId, handle);
		for (const envelope of envelopes) this.inbox(agentId).setState(envelope.id, "submitted", { runId });
		// Inclusion is acknowledged only once a provider request carrying the prompt was dispatched (review R05, plan §17.3).
		handle.subscribe((event) => {
			if (event.type !== "dispatched") return;
			// A context transform that removed the input is an explicit refusal, never a silent inclusion and never a retry loop.
			if (event.promptIncluded === false) {
				for (const envelope of envelopes) this.inbox(agentId).setState(envelope.id, "refused", { runId, refusedReason: "The message could not be confirmed in the agent's request (a context transform removed or rewrote it); send it again if it is still needed." });
				this.reportDiagnostics(agentId, ["The continuation message could not be confirmed in the agent's request after context transforms; it was not marked delivered."]);
				return;
			}
			for (const envelope of envelopes) this.inbox(agentId).setState(envelope.id, "included", { runId });
		});
		handle.started.catch((startError) => this.settle(agentId, runId, failedOutcome(String((startError as Error).message))));
	}

	private readonly foregroundWaiters = new Set<AgentId>();

	/**
	 * Wait until a conversation has a final report: not parked, no continuation running or reserved. Returns the last run's
	 * outcome; `onRun` receives every additional settled run (for usage). Resolves immediately when the first run was final.
	 */
	private async awaitConversationReport(agentId: AgentId, first: RunOutcome, onRun: (outcome: RunOutcome) => void): Promise<RunOutcome> {
		const pending = () => {
			const conversation = this.control.get(agentId);
			return Boolean(conversation && (conversation.active || conversation.disposition === "parked"));
		};
		if (!pending()) return first;
		this.foregroundWaiters.add(agentId);
		try {
			let last = first;
			await new Promise<void>((resolve) => {
				let done = false;
				const finish = () => { if (done) return; done = true; unsubscribe(); clearInterval(watch); resolve(); };
				const check = () => {
					const conversation = this.control.get(agentId);
					// A parked owner that is stopped never settles again; its stop ends the wait (pre-push review #2).
					if (conversation && !conversation.active && (conversation.meta.stoppedByUser || conversation.disposition === "stopped")) {
						// Keep the usage the conversation already incurred (recheck #3).
						if (last.status !== "killed") last = { ...killedOutcome(conversation.meta.stoppedByUser ? "user" : "parent"), usage: last.usage };
						finish();
						return;
					}
					if (!pending()) finish();
				};
				const unsubscribe = this.subscribe((event) => {
					if (event.type === "settled" && event.agentId === agentId) {
						last = event.outcome;
						onRun(event.outcome);
					}
					if ((event.type === "settled" || event.type === "stopped") && (event.agentId === agentId || event.type === "settled")) setImmediate(check);
				});
				const watch = setInterval(check, 1000);
				watch.unref?.();
				check();
			});
			return last;
		} finally {
			this.foregroundWaiters.delete(agentId);
		}
	}

	/** A stop that arrived while a reserved continuation was being set up ends it before it can dispatch (review R02). */
	private stopFenced(agentId: AgentId, runId: RunId): boolean {
		const conversation = this.control.get(agentId);
		const active = conversation?.active;
		if (!active || active.runId !== runId) return true;
		const stoppedBy = active.cancelRequested ?? (conversation!.meta.stoppedByUser ? "user" : undefined);
		if (!stoppedBy) return false;
		this.settle(agentId, runId, killedOutcome(stoppedBy));
		return true;
	}

	/** The current same-source definition narrows the historical one: tool grants intersect, denies accumulate. */
	private async currentDefinition(meta: AgentMeta): Promise<AgentDefinition> {
		const historical = meta.definition;
		if (historical.source === "built-in" || meta.isFork || meta.skill) return historical;
		const current = (await this.definitions()).active.get(historical.agentType);
		if (!current || current.source !== historical.source) return historical;
		const tools = historical.tools === undefined ? current.tools
			: current.tools === undefined ? historical.tools
			: historical.tools.filter((tool) => current.tools!.includes(tool));
		return { ...historical, tools, disallowedTools: [...new Set([...historical.disallowedTools, ...current.disallowedTools])] };
	}

	/**
	 * Live authorization (plan §16.4, review R03): a tool call is checked against the agent's *current* definition, so
	 * narrowing a definition revokes the grant even for a retained session. Fails closed when the definition disappeared.
	 */
	async toolRevocation(agentId: AgentId, toolName: string): Promise<string | undefined> {
		if (toolName === "StructuredOutput") return undefined;
		const decision = await this.currentCapability(agentId, toolName);
		if (!decision) return undefined;
		if ("error" in decision) return decision.error;
		return decision.surface.active.includes(toolName) ? undefined : `The current definition of "${decision.agentType}" no longer allows ${toolName}.`;
	}

	/**
	 * The current capability decision for one tool of a user-defined agent, compiled from the same inputs as its launch
	 * (scoped memory included), so live admission and spawn-time grants agree (re-review RR02, RR08). Undefined when the
	 * agent's capabilities are fixed for its lifetime (built-in, fork, skill, pane).
	 */
	private async currentCapability(agentId: AgentId, toolName: string): Promise<{ surface: ReturnType<typeof compileToolSurface>; agentType: string } | { error: string } | undefined> {
		const meta = this.control.get(agentId)?.meta;
		if (!meta) return undefined;
		const historical = meta.definition;
		if (historical.source === "built-in" || meta.isFork || meta.skill || meta.backend !== "in-process") return undefined;
		// An expired snapshot is refreshed before admission, never evaluated stale (pre-push review #1).
		let set: DefinitionSet;
		try {
			set = await this.definitions();
		} catch {
			return { error: "The agent's current definition could not be verified, so the tool call was blocked." };
		}
		const current = set.active.get(historical.agentType);
		if (!current || current.source !== historical.source) return { error: "This agent's definition is no longer available, so it can no longer use tools." };
		const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName)?.[1];
		const surface = compileToolSurface({
			definition: current, available: [{ name: toolName, mcpServer: mcp }], depth: meta.spawnDepth, maxDepth: this.control.limits.maxDepth, background: false, isFork: false,
			memoryTools: current.memory ? ["read", "write", "edit"] : undefined,
		});
		return { surface, agentType: historical.agentType };
	}

	private wake(agentId: AgentId): void {
		const pending = this.inbox(agentId).undelivered();
		const reservation = this.control.reserveContinuation(agentId, "wake", pending.map((envelope) => envelope.id));
		if (reservation.kind === "reserved") this.startContinuation(agentId, reservation.runId);
	}

	/** Re-signal runs under agentId whose earlier cancellation never reached them; the stop intent is already durable (re-review RR07). */
	private resendFailedStops(agentId: AgentId, fresh: readonly AgentId[]): void {
		for (const id of [...this.control.descendants(agentId), agentId]) {
			const active = this.control.get(id)?.active;
			if (!active || fresh.includes(id) || !this.cancelFailed.delete(active.runId)) continue;
			this.cancelRun(id, active.cancelRequested ?? "user");
		}
	}

	private cancelRun(agentId: AgentId, source: KilledBy): void {
		const active = this.control.get(agentId)?.active;
		if (!active) return;
		this.runAborts.get(active.runId)?.abort();
		this.runs.get(active.runId)?.handle.cancel(source);
	}

	// ---- Root delivery (plan §7, §16.10) ----

	private delivering = false;

	private async deliverRoot(): Promise<void> {
		const root = this.root;
		const outbox = this.outbox;
		if (!root || !outbox || !root.ready || this.delivering) return;
		if (root.generation !== this.generation || root.uiPromptOpen > 0) return;
		const pending = outbox.pending("root").filter((notice) => notice.state === "pending");
		const mainMessages = this.mainInbox().undelivered().filter((envelope) => envelope.state === "pending");
		if (pending.length === 0 && mainMessages.length === 0) return;
		this.delivering = true;
		try {
			for (const envelope of mainMessages) {
				const options = root.ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" as const };
				const content = `Message from agent ${envelope.from}${envelope.summary ? ` (${envelope.summary})` : ""}:\n\n${envelope.text}`;
				root.pi.sendMessage({ customType: MAIN_MESSAGE_TYPE, content, display: true, details: { from: envelope.from, envelopeId: envelope.id } }, options);
				this.mainInbox().setState(envelope.id, "submitted");
			}
			const passive = pending.filter((notice) => notice.passive);
			const active = pending.filter((notice) => !notice.passive);
			for (const group of [passive, active]) {
				if (group.length === 0) continue;
				const idle = root.ctx.isIdle();
				const isPassive = group === passive;
				const content = group.map((notice) => noticeText(notice.payload)).join("\n\n");
				const options = isPassive ? { triggerTurn: false } : idle ? { triggerTurn: true } : { deliverAs: "steer" as const };
				root.pi.sendMessage({ customType: NOTICE_TYPE, content, display: true, details: { noticeKeys: group.map((notice) => notice.key) } }, options);
				outbox.mark(group.map((notice) => notice.key), "submitted");
			}
		} finally {
			this.delivering = false;
		}
	}

	private mainMessages?: InboxStore;

	/** Durable inbox for agent → main messages in this root session. */
	private mainInbox(): InboxStore {
		if (!this.sessionId) throw new Error("The subagent engine is not bound to a session.");
		this.mainMessages ??= new InboxStore(join(sessionDir(this.deps.agentDir, this.sessionId), "main-inbox.jsonl"));
		return this.mainMessages;
	}

	/** A main-directed message is delivered once its custom_message entry is in root history. */
	private observeMainReceipts(entries: readonly { type: string; customType?: string; details?: unknown }[]): void {
		for (const entry of entries) {
			if (entry.type !== "custom_message" || entry.customType !== MAIN_MESSAGE_TYPE) continue;
			const id = (entry.details as { envelopeId?: unknown } | undefined)?.envelopeId;
			// Receipts inherited from another root (a branched or forked session) belong to that root's inbox (re-review RR09).
			if (typeof id === "string" && this.mainInbox().has(id)) this.mainInbox().setState(id, "included");
		}
	}

	/** On (re)binding: main messages submitted but never persisted go back to pending. */
	private recoverMainInbox(): void {
		for (const envelope of this.mainInbox().undelivered()) if (envelope.state === "submitted") this.mainInbox().setState(envelope.id, "pending");
	}

	private async sendToMain(from: AgentId, text: string, summary?: string): Promise<void> {
		await this.bound;
		const root = this.requireRoot();
		const options = root.ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" as const };
		root.pi.sendMessage({ customType: MAIN_MESSAGE_TYPE, content: `Message from agent ${from}${summary ? ` (${summary})` : ""}:\n\n${text}`, display: true, details: { from } }, options);
	}

	// ---- Maintenance ----

	private async sweep(): Promise<void> {
		for (const conversation of this.control.evictable()) {
			// A stopped conversation stays stopped; only its live resources go.
			if (conversation.disposition !== "stopped") conversation.disposition = "evictable";
			conversation.evictAt = undefined;
			await this.backend?.dispose(conversation.meta.agentId);
			this.paneRuns.evict(conversation.meta.agentId);
		}
		void this.deliverRoot();
	}

	// ---- Helpers ----

	inbox(agentId: AgentId): InboxStore {
		let inbox = this.inboxes.get(agentId);
		if (!inbox) {
			const sessionId = this.sessionId;
			if (!sessionId) throw new Error("The subagent engine is not bound to a session.");
			inbox = new InboxStore(agentFiles(this.deps.agentDir, sessionId, agentId).inboxFile);
			this.inboxes.set(agentId, inbox);
		}
		return inbox;
	}

	private persistMeta(meta: AgentMeta): void {
		const files = agentFiles(this.deps.agentDir, meta.rootSessionId, meta.agentId);
		writeMeta(files.metaFile, meta);
	}

	private taskListId(): string {
		return this.deps.env.PI_TASK_LIST_ID?.trim() || this.sessionId!;
	}

	private modelFor(conversation: Conversation, ctx: ExtensionContext): Model<any> | undefined {
		const effective = conversation.meta.model?.effective;
		if (!effective) return ctx.model;
		const slash = effective.indexOf("/");
		return ctx.modelRegistry.find(effective.slice(0, slash), effective.slice(slash + 1)) ?? undefined;
	}

	private requireRoot(): RootBinding {
		if (!this.root) throw new Error("The subagent engine is not bound to a session.");
		return this.root;
	}

	private requireBackend(): InProcessBackend {
		if (!this.backend) throw new Error("The subagent engine backend is not ready.");
		return this.backend;
	}

	private emit(event: EngineEvent): void {
		for (const listener of this.listeners) {
			try { listener(event); } catch {}
		}
	}
}

export interface AgentSnapshot {
	agentId: AgentId;
	agentType: string;
	description: string;
	name?: string;
	backend: AgentMeta["backend"];
	disposition: string;
	running: boolean;
	runId?: RunId;
	status?: string;
	startedAt?: number;
	endedAt?: number;
	model?: string;
	effort?: string;
	depth: number;
	ownerAgentId?: AgentId;
	workflow?: NonNullable<AgentMeta["workflow"]>;
}

export type EngineEvent =
	| { type: "spawned"; agentId: AgentId; runId: RunId; meta: AgentMeta }
	| { type: "run-event"; agentId: AgentId; runId: RunId; event: import("./types.ts").BackendEvent }
	| { type: "settled"; agentId: AgentId; runId: RunId; outcome: RunOutcome }
	| { type: "diagnostics"; agentId: AgentId; messages: string[] }
	| { type: "stopped"; agentId: AgentId }
	| { type: "stop-failed"; agentId: AgentId; runId: RunId }
	| { type: "workflow-progress"; taskId: string; runId: string; event: WorkflowProgress }
	| { type: "workflow-settled"; taskId: string; runId: string; status: string };

function error(text: string): ToolText {
	return { text, isError: true };
}

function liteModel(model: Model<any>): ModelLite {
	return { provider: model.provider, id: model.id, name: model.name };
}

function toolLite(tool: ToolInfo): ToolLite {
	const source = (tool as { sourceInfo?: { source?: string } }).sourceInfo?.source;
	const match = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(tool.name);
	return { name: tool.name, source, mcpServer: match?.[1] };
}

function stallTimeout(env: Record<string, string | undefined>): number {
	const value = Number(env.PI_SUBAGENT_STALL_TIMEOUT_MS);
	return Number.isFinite(value) && value > 0 ? value : 600_000;
}

function looksLikeProtocolFrame(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return false;
	try {
		const parsed = JSON.parse(trimmed) as { type?: unknown };
		return typeof parsed?.type === "string" && /shutdown|plan_approval|permission|mode_set/.test(parsed.type);
	} catch {
		return false;
	}
}

function sumUsage(totals: import("./types.ts").UsageTotals[]): import("./types.ts").UsageTotals {
	return totals.reduce((sum, item) => ({
		input: sum.input + item.input, output: sum.output + item.output, cacheRead: sum.cacheRead + item.cacheRead,
		cacheWrite: sum.cacheWrite + item.cacheWrite, totalTokens: sum.totalTokens + item.totalTokens, cost: sum.cost + item.cost,
	}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
}

function killedOutcome(killedBy: KilledBy): RunOutcome {
	return { ...failedOutcome("Stopped before it started."), status: "killed", classification: "killed", killedBy };
}

function failedOutcome(message: string): RunOutcome {
	return {
		status: "failed", classification: "failed", resultText: "", error: message, durationMs: 0,
		usage: { billable: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, latestFootprint: 0, liveMetric: 0, modelTransitions: [] },
		toolStats: { toolUses: 0, byTool: {} },
	};
}

export type { NoticeRecord };
