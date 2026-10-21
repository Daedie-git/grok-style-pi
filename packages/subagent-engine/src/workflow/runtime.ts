import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { OutputBudget } from "./budget.ts";
import { WorkflowObligations } from "./obligations.ts";
import type { WorkflowAgentRequest, WorkflowHost } from "./host.ts";
import type { JournalEvent } from "./journal.ts";
import { parseWorkflowSource } from "./meta.ts";
import { compileBody } from "./compile.ts";
import { chooseReplay, createReplayState, type ReplayState } from "./replay.ts";
import { defaultConcurrency, FifoPermits } from "./permits.ts";
import { runInRealm } from "./vm.ts";

export interface WorkflowRunResult {
	status: "completed" | "failed" | "killed";
	result?: unknown;
	error?: string;
	agentCount: number;
	logs: string[];
	failures: { index: number; error: string }[];
	durationMs: number;
}
export interface WorkflowRunInput {
	source: string;
	args?: unknown;
	host: WorkflowHost;
	runId: string;
	taskId: string;
	journal?: { append(event: JournalEvent): Promise<void> };
	replay?: ReplayState;
	signal?: AbortSignal;
	maxCalls?: number;
	concurrency?: number;
	syncTimeoutMs?: number;
	now?: () => number;
	/** Internal helper profile; ordinary Workflow invocations leave this null. */
	budgetTotal?: number | null;
	obligations?: WorkflowObligations;
	env?: Record<string, string | undefined>;
}
function text(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function list(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every(entry => typeof entry === "string" && entry.length > 0 && entry === entry.trim())) throw new Error(`${field} must be an array of nonempty strings`);
	return value.length ? [...new Set(value)].sort() : undefined;
}
function sanitize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitize);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "webFetchSavedFiles" && key !== "__proto__").map(([key, item]) => [key, sanitize(item)]));
	return value;
}

/** Runs an approved source snapshot; admission, task registration and resume collision locks belong to the caller. */
export async function runWorkflow(input: WorkflowRunInput): Promise<WorkflowRunResult> {
	const now = input.now ?? (() => performance.now());
	const startedAt = now();
	const logs: string[] = [], failures: { index: number; error: string }[] = [];
	let agentCount = 0, currentPhase: string | undefined;
	const replay = input.replay ?? createReplayState();
	const signal = input.signal ?? new AbortController().signal;
	const env = input.env ?? process.env;
	const obligations = input.obligations ?? new WorkflowObligations();
	const permits = new FifoPermits(input.concurrency ?? defaultConcurrency(env));
	const budget = new OutputBudget(input.budgetTotal ?? null, () => input.host.sessionOutputTokens());
	const phaseIndices = new Map<string, number>();
	const announced = new Set<string>(), children = new Map<string, number>();
	function log(value: unknown): void {
		const message = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
		if (logs.length < 1000) logs.push(message);
		input.host.progress({ type: "log", message });
	}
	function failure(index: number, error: string): void { failures.push({ index, error }); log(`Workflow slot ${index}: ${error}`); }
	function admit(): void {
		if (signal.aborted) throw new Error("Workflow aborted");
		if (agentCount >= (input.maxCalls ?? 1000)) throw new Error("Workflow logical agent call limit reached");
		budget.check();
	}
	function phase(title: unknown): string {
		const name = String(title);
		if (!phaseIndices.has(name)) phaseIndices.set(name, phaseIndices.size + 1);
		if (!announced.has(name)) {
			announced.add(name);
			input.host.progress({ type: "phase", index: phaseIndices.get(name)!, title: name });
		}
		return name;
	}
	async function append(event: JournalEvent): Promise<void> {
		try { await input.journal?.append(event); } catch (error) { log(`Workflow journal write failed: ${text(error)}`); }
	}
	async function agent(promptInput: unknown, optionsInput: unknown = {}, forcedPhase?: string): Promise<unknown> {
		if (signal.aborted) return new Promise<never>(() => {});
		admit();
		if (!optionsInput || typeof optionsInput !== "object" || Array.isArray(optionsInput)) throw new Error("Agent options must be an object");
		const options = structuredClone(optionsInput) as Record<string, unknown>;
		const denies = list(options.disallowedTools, "disallowedTools");
		const clamp = list(options.bashCommandClamp, "bashCommandClamp");
		if (denies) options.disallowedTools = denies; else delete options.disallowedTools;
		if (clamp) options.bashCommandClamp = clamp; else delete options.bashCommandClamp;
		if (env.PI_SUBAGENT_MODEL_FORCE || env.PI_WORKFLOW_MODEL) delete options.model;
		if (clamp?.some(rule => !/^Bash\([\s\S]*\S[\s\S]*\)$/.test(rule))) throw new Error("bashCommandClamp requires Bash(command) rules");
		if (options.schema !== undefined && (!options.schema || typeof options.schema !== "object" || Array.isArray(options.schema))) throw new Error("schema must be an object");
		const prompt = String(promptInput);
		const index = ++agentCount;
		const label = options.label === undefined ? prompt.slice(0, 60) : String(options.label);
		const grouping = forcedPhase ?? (options.phase === undefined ? currentPhase : String(options.phase));
		if (grouping !== undefined) phase(grouping);
		const common = { logicalIndex: index, label, ...(grouping === undefined ? {} : { phase: grouping }) };
		const choice = chooseReplay(prompt, options, replay);
		if ("cached" in choice) {
			input.host.progress({ type: "agent", ...common, state: "cached" });
			return choice.cached;
		}
		const releaseObligation = obligations.register();
		let lastAgentId = `pending-${input.taskId}-${index}`;
		try {
		if (options.isolation !== undefined && options.isolation !== "worktree") throw new Error("Only local worktree isolation is available; remote agents are unavailable");
		input.host.progress({ type: "agent", ...common, state: "queued" });
		const executed = await permits.run(async () => {
			if (signal.aborted) throw new Error("Workflow aborted");
			let stalls = 0, invalid = 0, nudged = false, attempt = 0;
			budget.check();
				for (;;) {
					if (signal.aborted) throw new Error("Workflow aborted");
					attempt++;
					// The host allocates the real agent ID. A pending identity still
					// records a crash before its runAgent promise hands that ID back.
					void append({ type: "started", key: choice.key, agentId: lastAgentId, label, ...(grouping === undefined ? {} : { phase: grouping }) });
					input.host.progress({ type: "agent", ...common, state: "start" });
					const request: WorkflowAgentRequest = {
						prompt: nudged ? `${prompt}\n\nReturn the result through the StructuredOutput tool.` : prompt,
						label, ...(grouping === undefined ? {} : { phase: grouping }), runId: input.runId, taskId: input.taskId, logicalIndex: index, attempt, signal,
						disallowedTools: [...new Set(["Agent", "Workflow", "SendUserMessage", ...(denies ?? []), ...(denies?.length || clamp?.length ? ["REPL"] : []), ...(clamp?.length ? ["PowerShell", "mcp__*"] : [])])],
					};
					for (const field of ["model", "effort", "agentType"] as const) if (typeof options[field] === "string") request[field] = options[field];
					if (options.isolation === "worktree") request.isolation = "worktree";
					if (options.schema) request.schema = options.schema as Record<string, unknown>;
					if (clamp) request.bashCommandClamp = clamp;
					const attemptController = new AbortController();
					const abortAttempt = () => attemptController.abort();
					signal.addEventListener("abort", abortAttempt, { once: true });
					if (signal.aborted) abortAttempt();
					const stallMs = Number(options.stallMs);
					let timedOut = false;
					const timer = Number.isFinite(stallMs) && stallMs > 0 ? setTimeout(() => { timedOut = true; attemptController.abort(); }, Math.min(stallMs, 2_147_483_647)) : undefined;
					let result: Awaited<ReturnType<WorkflowHost["runAgent"]>>;
					try {
						result = await input.host.runAgent({ ...request, signal: attemptController.signal });
					} catch (error) {
						if (!timedOut || signal.aborted) throw error;
						result = { status: "failed", agentId: lastAgentId, text: "", outputTokens: 0, stalled: true };
					} finally {
						clearTimeout(timer);
						signal.removeEventListener("abort", abortAttempt);
					}
					lastAgentId = result.agentId;
					if (signal.aborted) throw new Error("Workflow aborted");
					if (timedOut) result = { ...result, stalled: true };
					let value: unknown;
					if (request.schema && result.structured?.ok) value = sanitize(result.structured.value);
					else if (result.stalled) {
						if (stalls++ < 5) continue;
						throw new Error("Agent stalled after five retries");
					} else if (result.status !== "completed") {
						failure(index, result.error ?? `Agent ${result.status}`);
						input.host.progress({ type: "agent", ...common, state: "failed", agentId: result.agentId });
						return { value: null, agentId: result.agentId };
					} else if (request.schema) {
						if (result.structured?.ok === false) {
							if (++invalid >= 5) throw new Error(`StructuredOutput validation failed five times: ${result.structured.error}`);
						} else {
							if (nudged) throw new Error("Agent never returned a StructuredOutput attachment");
							nudged = true;
						}
						continue;
					} else value = result.text;
					input.host.progress({ type: "agent", ...common, state: "done", agentId: result.agentId });
					return { value, agentId: result.agentId };
				}
		});
		// M1: the executor (including host-owned cleanup) relinquishes its
		// permit before this outer logical-call result/failure write.
		if (executed.value === null) await append({ type: "failed", key: choice.key, agentId: executed.agentId });
		else await append({ type: "result", key: choice.key, agentId: executed.agentId, result: executed.value });
		return executed.value;
		} catch (error) {
			if (!signal.aborted) await append({ type: "failed", key: choice.key, agentId: lastAgentId });
			input.host.progress({ type: "agent", ...common, state: "failed", agentId: lastAgentId });
			if (signal.aborted) return new Promise<never>(() => {});
			throw error;
		} finally { releaseObligation(); }
	}
	async function evaluate(source: string, args: unknown, depth: number, forcedPhase?: string): Promise<unknown> {
		const parsed = parseWorkflowSource(source);
		if (!parsed.meta || parsed.error) throw new Error(parsed.error ?? "Invalid workflow metadata");
		const compiled = compileBody(parsed.body);
		if (!compiled.ok) throw new Error(compiled.error);
		if (depth === 0) await append({ type: "launched", scriptSha256: createHash("sha256").update(source).digest("hex") });
		for (const entry of parsed.meta.phases) if (!phaseIndices.has(entry.title)) phaseIndices.set(entry.title, phaseIndices.size + 1);
		return runInRealm({ body: parsed.body, signal, timeoutMs: input.syncTimeoutMs, globals: {
			args,
			agent: (prompt: unknown, options?: unknown) => agent(prompt, options, forcedPhase),
			phase: (title: unknown) => { if (!depth) currentPhase = phase(title); },
			log,
			budget: { total: budget.total, spent: () => budget.spent(), remaining: () => budget.remaining() },
			__workflow$admit: admit,
			__workflow$failure: failure,
			workflow: async (name: unknown, childArgs?: unknown) => {
				if (depth) throw new Error("Child workflows cannot nest another workflow");
				let loaded: { source: string } | undefined;
				let title: string;
				if (typeof name === "string") { loaded = await input.host.loadNamed(name); title = name; }
				else if (name && typeof name === "object" && typeof (name as { scriptPath?: unknown }).scriptPath === "string") {
					const path = (name as { scriptPath: string }).scriptPath;
					loaded = await input.host.readScriptPath(path); title = path;
				} else throw new Error("workflow requires a registered name or {scriptPath}");
				if (!loaded) throw new Error(`Workflow not found: ${title}`);
				const count = (children.get(title) ?? 0) + 1; children.set(title, count);
				const grouping = `Workflow: ${title}${count > 1 ? ` #${count}` : ""}`;
				phase(grouping);
				try { return await evaluate(loaded.source, childArgs, depth + 1, grouping); }
				catch (error) { failure(-1, text(error)); throw error; }
			},
		} });
	}
	try {
		const result = await evaluate(input.source, input.args, 0);
		return { status: "completed", result, agentCount, logs: [...logs], failures: [...failures], durationMs: now() - startedAt };
	} catch (error) {
		return { status: signal.aborted ? "killed" : "failed", result: null, error: text(error), agentCount, logs: [...logs], failures: [...failures], durationMs: now() - startedAt };
	} finally { obligations.close(); }
}
