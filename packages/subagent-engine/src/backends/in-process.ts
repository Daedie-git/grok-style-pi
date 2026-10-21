// In-process backend: each subagent is a Pi AgentSession in this process (plan §4.2).
// One live session per agent is kept across runs until eviction; a continuation prompts the same session again.
import type { AgentSession, ExtensionFactory, ModelRuntime, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { runInChildScope } from "../child-context.ts";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { extractOutcome, retryableApiError, UsageTracker } from "../results.ts";
import type { AgentId, BackendCapabilities, BackendEvent, DeliveryResult, Envelope, KilledBy, RunHandle, RunId, RunOutcome } from "../types.ts";

export const IN_PROCESS_CAPABILITIES: BackendCapabilities = {
	liveDelivery: true, continuation: true, blockedState: false, maxTurns: true, worktree: true, fork: true, sharedTasks: true,
};

export interface SessionSpec {
	agentId: AgentId;
	/** Host predicate checked at every turn boundary; true ends the run (workflow handback exhaustion). */
	shouldEndTurn?: () => boolean;
	cwd: string;
	agentDir: string;
	sessionFile: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	projectTrusted: boolean;
	/** "preamble": the definition prompt replaces Pi's default preamble. "exact": a fork's inherited prompt, forced verbatim. */
	systemPrompt: { mode: "preamble" | "exact"; text: string };
	noContextFiles: boolean;
	/** Extension factories installed only in this child (the child installer). */
	installers: ExtensionFactory[];
	/** Computes the active tool names from what the child session can see. */
	selectTools: (tools: ToolInfo[]) => string[];
	depth: number;
}

export interface RunSpec {
	runId: RunId;
	prompt: string;
	maxTurns?: number;
	background: boolean;
	stallTimeoutMs: number;
}

export interface InProcessDeps {
	modelRuntime: ModelRuntime;
	now?: () => number;
	/** Test hook: called once per newly created child session (inject a fake stream function). */
	onSessionCreated?: (session: AgentSession, agentId: AgentId) => void;
	setTimer?: (fn: () => void, ms: number) => { cancel(): void };
	/** Called when the turn budget ends a run, so queued input can return to the durable inbox. */
	onBudgetExhausted?: (agentId: AgentId) => void;
	/** The host ended the run for good (shouldEndTurn): queued input can no longer run in it. */
	onHostEnded?: (agentId: AgentId) => void;
}

interface LiveChild {
	session: AgentSession;
	spec: SessionSpec;
	unsubscribe: () => void;
	current?: RunState;
}

interface RunState {
	runId: RunId;
	listeners: Set<(event: BackendEvent) => void>;
	tracker: UsageTracker;
	turns: number;
	maxTurns?: number;
	maxTurnsReached: boolean;
	killedBy?: KilledBy;
	toolsInFlight: number;
	lastProgress: number;
	pendingEnvelopes: Map<string, "submitted" | "persisted">;
	dispatched: boolean;
	prompt: string;
	/** Whether the first provider request still carried the prompt after every context transform. */
	promptIncluded?: boolean;
	/** Set once this run's prompt message carries its provenance tag. */
	inputTagged?: boolean;
}

export class InProcessBackend {
	readonly capabilities = IN_PROCESS_CAPABILITIES;
	private readonly live = new Map<AgentId, LiveChild>();
	private readonly now: () => number;

	private readonly deps: InProcessDeps;

	constructor(deps: InProcessDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	has(agentId: AgentId): boolean {
		return this.live.has(agentId);
	}

	session(agentId: AgentId): AgentSession | undefined {
		return this.live.get(agentId)?.session;
	}

	/** The active run's turn budget, for the stop-hook loop. */
	budget(agentId: AgentId): { turns: number; maxTurns?: number; ended: boolean } | undefined {
		const child = this.live.get(agentId);
		const state = child?.current;
		return state ? { turns: state.turns, maxTurns: state.maxTurns, ended: child!.spec.shouldEndTurn?.() ?? false } : undefined;
	}

	/** Drop queued steering/follow-up input; callers reconcile their durable inbox by identity (plan §17.2a). */
	clearQueue(agentId: AgentId): void {
		this.live.get(agentId)?.session.clearQueue();
	}

	/** Start a run, creating the child session on first use. */
	run(session: SessionSpec, run: RunSpec): RunHandle {
		const state: RunState = {
			runId: run.runId, listeners: new Set(), tracker: new UsageTracker(), turns: 0, maxTurns: run.maxTurns,
			maxTurnsReached: false, toolsInFlight: 0, lastProgress: this.now(), pendingEnvelopes: new Map(), dispatched: false,
			prompt: run.prompt,
		};
		const emit = (event: BackendEvent) => { for (const listener of state.listeners) listener(event); };
		let resolveStarted!: () => void;
		let rejectStarted!: (error: unknown) => void;
		const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
		const startedAt = this.now();
		const execution = (async (): Promise<RunOutcome> => {
			let child: LiveChild;
			try {
				child = await this.ensureSession(session);
			} catch (error) {
				rejectStarted(error);
				throw error;
			}
			if (child.current) {
				const error = new Error(`Agent ${session.agentId} already has an active run.`);
				rejectStarted(error);
				throw error;
			}
			child.current = state;
			if (state.killedBy) {
				// Cancelled while the session was being created: never contact the provider or run tools.
				child.current = undefined;
				resolveStarted();
				const outcome = extractOutcome({ messages: [], maxTurnsReached: false, background: run.background, aborted: { killedBy: state.killedBy }, durationMs: this.now() - startedAt, usage: state.tracker.snapshot() });
				emit({ type: "cancel-acknowledged" });
				emit({ type: "settled", outcome });
				return outcome;
			}
			const watchdog = this.armWatchdog(child, state, run.stallTimeoutMs);
			const firstIndex = child.session.messages.length;
			resolveStarted();
			emit({ type: "started" });
			let thrown: unknown;
			try {
				await child.session.prompt(run.prompt, { source: "extension", expandPromptTemplates: false });
			} catch (error) {
				thrown = error;
			} finally {
				watchdog.cancel();
				child.current = undefined;
			}
			const messages = child.session.messages.slice(firstIndex);
			const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
			const errorMessage = thrown ? String((thrown as Error).message ?? thrown) : lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage ?? "Model request failed." : undefined;
			const outcome = extractOutcome({
				messages, maxTurnsReached: state.maxTurnsReached, background: run.background,
				aborted: state.killedBy ? { killedBy: state.killedBy } : undefined,
				// Only an API error message can be a retryable cutoff; thrown setup errors never are (pre-push review #5).
				error: errorMessage && !state.killedBy ? { message: errorMessage, retryable: !thrown && retryableApiError(errorMessage) } : undefined,
				durationMs: this.now() - startedAt, usage: state.tracker.snapshot(),
			});
			if (state.killedBy === "watchdog") Object.assign(outcome, { classification: "stalled", status: "failed" });
			if (state.killedBy) emit({ type: "cancel-acknowledged" });
			emit({ type: "settled", outcome });
			return outcome;
		})();
		execution.catch(() => {});
		return {
			runId: run.runId,
			started,
			execution,
			deliver: (envelope) => this.deliver(session.agentId, state, envelope),
			cancel: (source) => {
				if (state.killedBy) return;
				state.killedBy = source;
				// Never awaited here: abort waits for the run to go idle.
				void this.live.get(session.agentId)?.session.abort();
			},
			subscribe: (listener) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
		};
	}

	/** Release a child's live session (eviction or shutdown). Emits session_shutdown before disposing. */
	async dispose(agentId: AgentId, reason: "quit" | "reload" = "quit"): Promise<void> {
		const child = this.live.get(agentId);
		if (!child) return;
		this.live.delete(agentId);
		child.unsubscribe();
		try {
			await Promise.race([
				child.session.extensionRunner.emit({ type: "session_shutdown", reason }),
				new Promise((resolve) => setTimeout(resolve, 3000)),
			]);
		} catch {}
		child.session.dispose();
	}

	async disposeAll(reason: "quit" | "reload" = "quit"): Promise<void> {
		await Promise.all([...this.live.keys()].map((agentId) => this.dispose(agentId, reason)));
	}

	private async ensureSession(spec: SessionSpec): Promise<LiveChild> {
		const existing = this.live.get(spec.agentId);
		if (existing) return existing;
		const settingsManager = SettingsManager.create(spec.cwd, spec.agentDir, { projectTrusted: spec.projectTrusted });
		const installers = [...spec.installers];
		if (spec.systemPrompt.mode === "exact") {
			// Registered last so it wins over other before_agent_start handlers (plan §2.2, v3 N3).
			const text = spec.systemPrompt.text;
			installers.push((pi) => { pi.on("before_agent_start", () => ({ systemPrompt: text })); });
		}
		const loader = new DefaultResourceLoader({
			cwd: spec.cwd, agentDir: spec.agentDir, settingsManager,
			systemPromptOverride: spec.systemPrompt.mode === "preamble" ? () => spec.systemPrompt.text : undefined,
			appendSystemPromptOverride: () => [],
			noContextFiles: spec.noContextFiles,
			extensionFactories: installers,
		});
		await runInChildScope({ agentId: spec.agentId, depth: spec.depth }, () => loader.reload());
		const { session } = await runInChildScope({ agentId: spec.agentId, depth: spec.depth }, () => createAgentSession({
			cwd: spec.cwd, agentDir: spec.agentDir, modelRuntime: this.deps.modelRuntime, model: spec.model, thinkingLevel: spec.thinkingLevel,
			settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(spec.sessionFile, undefined, spec.cwd),
		}));
		this.deps.onSessionCreated?.(session, spec.agentId);
		await runInChildScope({ agentId: spec.agentId, depth: spec.depth }, () => session.bindExtensions({ mode: "json" }));
		session.setActiveToolsByName(spec.selectTools(session.getAllTools()));
		const child: LiveChild = { session, spec, unsubscribe: () => {} };
		this.installTurnBudget(child);
		this.installInclusionProbe(child);
		child.unsubscribe = session.subscribe((event) => this.observe(child, event as unknown as SessionEvent));
		this.live.set(spec.agentId, child);
		return child;
	}

	/**
	 * Inclusion evidence (re-review RR03): the final projected request, after every context transform, is what the provider
	 * sees. The first request of a run records whether the run's prompt is still in it.
	 */
	private installInclusionProbe(child: LiveChild): void {
		const agent = child.session.agent;
		const stream = agent.streamFunction;
		// The provider request after every transform and conversion is the evidence; the first request of a run decides.
		agent.streamFunction = (model, context, options) => {
			const state = child.current;
			// Host exhaustion fences every later request, whatever started it (queued input, another extension's pre-settle turn).
			if (child.spec.shouldEndTurn?.()) return endedResponse(model);
			if (state && state.promptIncluded === undefined) state.promptIncluded = inputSurvived(context.messages, state);
			// Provenance is engine-local: no adapter or gateway ever receives it (pi-messages serializes parts as they are).
			return stream(model, { ...context, messages: withoutInputTags(context.messages) }, options);
		};
	}

	/**
	 * Turn budget (plan §17.2): after the last allowed turn, a turn that would need another provider request (it ran tools,
	 * including failed lookups) ends the loop through the core finishTurn hook. A natural final answer at the limit is untouched.
	 * Queued input is cleared back to the caller's durable inbox, because Pi otherwise continues with queued messages at settle.
	 */
	private installTurnBudget(child: LiveChild): void {
		const agent = child.session.agent;
		const previous = agent.finishTurn;
		agent.finishTurn = async (turn, signal) => {
			const prior = await previous?.(turn, signal);
			if (child.spec.shouldEndTurn?.()) {
				this.deps.onHostEnded?.(child.spec.agentId);
				return { action: "end" };
			}
			const state = child.current;
			if (prior?.action === "end" || !state?.maxTurns || state.turns < state.maxTurns) return prior ?? undefined;
			// Tools, a continuation request, or queued steering/follow-up input would all need another provider request.
			const wantsMore = turn.toolResults.length > 0 || turn.message.content.some((block) => block.type === "toolCall") || agent.hasQueuedMessages();
			if (!wantsMore && prior?.action !== "continue") return prior ?? undefined;
			state.maxTurnsReached = true;
			this.deps.onBudgetExhausted?.(child.spec.agentId);
			return { action: "end" };
		};
	}

	private observe(child: LiveChild, event: SessionEvent): void {
		const state = child.current;
		if (!state) return;
		const emit = (backendEvent: BackendEvent) => { for (const listener of state.listeners) listener(backendEvent); };
		state.lastProgress = this.now();
		switch (event.type) {
			case "turn_start":
				state.turns++;
				emit({ type: "turn", turns: state.turns });
				break;
			case "message_start":
				if (event.message?.role === "user" && !state.inputTagged) state.inputTagged = tagInput(event.message as { content?: unknown }, state);
				if (event.message?.role === "assistant") {
					for (const [id, envelopeState] of state.pendingEnvelopes) {
						if (envelopeState !== "persisted") continue;
						state.pendingEnvelopes.delete(id);
						emit({ type: "envelope", envelopeId: id, state: "included" });
					}
				}
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta" && typeof delta.delta === "string") emit({ type: "text", delta: delta.delta });
				emit({ type: "progress", at: state.lastProgress, kind: "stream" });
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message?.role === "assistant") state.tracker.onAssistantMessage(message as never);
				// Dispatch evidence: an assistant message that is not a pre-dispatch failure (an error with no usage at all).
				if (message?.role === "assistant" && !state.dispatched) {
					const ended = message as { stopReason?: string; usage?: { input?: number; output?: number } };
					const used = (ended.usage?.input ?? 0) + (ended.usage?.output ?? 0) > 0;
					if (ended.stopReason !== "error" || used) { state.dispatched = true; emit({ type: "dispatched", promptIncluded: state.promptIncluded }); }
				}
				const envelopeId = (message as { details?: { envelopeId?: string } } | undefined)?.details?.envelopeId;
				if (envelopeId && state.pendingEnvelopes.has(envelopeId)) {
					state.pendingEnvelopes.set(envelopeId, "persisted");
					emit({ type: "envelope", envelopeId, state: "persisted" });
				}
				break;
			}
			case "tool_execution_start":
				state.toolsInFlight++;
				emit({ type: "tool", phase: "start", toolCallId: event.toolCallId!, toolName: event.toolName! });
				break;
			case "tool_execution_end":
				state.toolsInFlight = Math.max(0, state.toolsInFlight - 1);
				emit({ type: "tool", phase: "end", toolCallId: event.toolCallId!, toolName: event.toolName!, isError: event.isError });
				break;
			default:
				emit({ type: "progress", at: state.lastProgress, kind: event.type });
		}
	}

	private async deliver(agentId: AgentId, state: RunState, envelope: Envelope): Promise<DeliveryResult> {
		const child = this.live.get(agentId);
		if (!child || child.current !== state || !child.session.isStreaming) {
			return { ok: false, reason: "not-running", message: "The agent is not running." };
		}
		// An exhausted run takes no more input; say so instead of queueing work it will never do (re-review 3, RR05).
		if (child.spec.shouldEndTurn?.()) return { ok: false, reason: "unsupported", message: "The agent has ended its work and cannot take more messages." };
		// A literal custom message: no slash-command or template expansion, no input handlers (plan §8, M7).
		state.pendingEnvelopes.set(envelope.id, "submitted");
		await child.session.sendCustomMessage(
			{ customType: "agent-message", content: formatEnvelope(envelope), display: true, details: { envelopeId: envelope.id, from: envelope.from } },
			{ deliverAs: "steer" },
		);
		return { ok: true, state: "submitted" };
	}

	/** Stall watchdog (plan §17.14): abort when no progress arrives for the timeout and no tool is running. */
	private armWatchdog(child: LiveChild, state: RunState, timeoutMs: number): { cancel(): void } {
		if (!(timeoutMs > 0)) return { cancel() {} };
		const setTimer = this.deps.setTimer ?? ((fn, ms) => { const timer = setInterval(fn, ms); return { cancel: () => clearInterval(timer) }; });
		return setTimer(() => {
			if (state.killedBy || state.toolsInFlight > 0) return;
			if (this.now() - state.lastProgress < timeoutMs) return;
			state.killedBy = "watchdog";
			void child.session.abort();
		}, Math.min(timeoutMs, 5000));
	}
}

interface SessionEvent {
	type: string;
	message?: { role?: string };
	assistantMessageEvent?: { type?: string; delta?: unknown };
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export function formatEnvelope(envelope: Envelope): string {
	const sender = envelope.from === "main" ? "the main conversation" : `agent ${envelope.from}`;
	return `Message from ${sender}:\n\n${envelope.text}`;
}

/** A provider-free, non-retryable error response for a run the host has ended. */
function endedResponse(model: { api: string; provider: string; id: string }): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error",
		errorMessage: "The agent's host ended this run; no further model requests are made.", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as never;
	queueMicrotask(() => { stream.push({ type: "error", reason: "error", error: message }); stream.end(message); });
	return stream;
}

/** Content-part field that carries a run's input provenance; stripped from every provider request (withoutInputTags). */
const INPUT_TAG = "subagentInputRun";

/**
 * Tag the text part of the run's prompt message (the object Pi keeps in agent state) with the run id. Plain data survives
 * Pi's structured cloning for context handlers, transforms that keep or re-wrap content parts, and conversion.
 */
function tagInput(message: { content?: unknown }, state: { runId: string; prompt: string }): boolean {
	const needle = state.prompt.trim();
	if (!needle || !textOf(message).includes(needle)) return false;
	if (typeof message.content === "string") {
		message.content = [{ type: "text", text: message.content, [INPUT_TAG]: state.runId }];
		return true;
	}
	const part = (message.content as Array<{ type?: string; text?: string; [INPUT_TAG]?: string }>).find((candidate) => candidate.type === "text" && candidate.text?.includes(needle));
	if (!part) return false;
	part[INPUT_TAG] = state.runId;
	return true;
}

/**
 * Whether this run's input instance reached the provider (re-review RR03): the text of every part tagged with this run, taken
 * together, still carries the prompt (whitespace-insensitive, so splitting it across parts is fine). Equal text elsewhere
 * (earlier copies, summaries, listings) is never evidence. A transform that rebuilds the input's parts without the tag is
 * indistinguishable from one that removed it, so it is treated as unconfirmed: fail closed with an honest reason.
 */
function inputSurvived(messages: readonly { role?: string; content?: unknown }[], state: { runId: string; prompt: string }): boolean {
	const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
	const needle = normalize(state.prompt);
	if (!needle) return true;
	const tagged: string[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content as Record<string, unknown>[]) if (part[INPUT_TAG] === state.runId) tagged.push(String(part.text ?? ""));
	}
	return tagged.length > 0 && normalize(tagged.join(" ")).includes(needle);
}

/** A request-local copy without provenance fields; untagged messages are shared unchanged. */
function withoutInputTags<T extends { content?: unknown }>(messages: readonly T[]): T[] {
	return messages.map((message) => {
		if (!Array.isArray(message.content) || !message.content.some((part) => part && typeof part === "object" && INPUT_TAG in part)) return message;
		return { ...message, content: message.content.map((part) => {
			if (!part || typeof part !== "object" || !(INPUT_TAG in part)) return part;
			const { [INPUT_TAG]: _tag, ...rest } = part as Record<string, unknown>;
			return rest;
		}) };
	});
}

function textOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text ?? "" : "").join("\n");
}
