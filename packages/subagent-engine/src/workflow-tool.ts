// The Workflow tool (plan §18, §18.1): script admission and approval, run/task identities, journal-backed resume,
// background execution through the engine, completion notices and TaskStop. The script runtime lives in ./workflow/.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Engine, ToolText } from "./engine.ts";
import { compileBody } from "./workflow/compile.ts";
import { discoverWorkflows } from "./workflow/discovery.ts";
import type { WorkflowHost } from "./workflow/host.ts";
import { WorkflowJournal } from "./workflow/journal.ts";
import { parseWorkflowSource } from "./workflow/meta.ts";
import { WorkflowObligations } from "./workflow/obligations.ts";
import { createReplayState } from "./workflow/replay.ts";
import { runWorkflow, type WorkflowRunResult } from "./workflow/runtime.ts";
import { runWorkflowAgent } from "./workflow-host.ts";

export const MAX_SCRIPT_LENGTH = 524_288;
const RESUME_QUIESCENCE_MS = 30_000;

interface WorkflowTask {
	taskId: string;
	runId: string;
	name: string;
	controller: AbortController;
	status: "running" | "completed" | "failed" | "killed";
	/** The runner chain has returned (the script settled or was aborted). */
	chainSettled: boolean;
	/** Live agent() attempts still running for this invocation. */
	activeAgents: Set<string>;
	obligations: WorkflowObligations;
	execution: Promise<WorkflowRunResult>;
	journalFile: string;
}

export interface WorkflowInputParams {
	script?: string;
	name?: string;
	scriptPath?: string;
	args?: unknown;
	resumeFromRunId?: string;
	description?: string;
	title?: string;
}

type Snapshot = { source: string; kind: "inline" | "named" | "path"; path?: string };

const WORKFLOW_DESCRIPTION = [
	"Run a JavaScript workflow script that orchestrates several subagents in the background. Before writing or editing a script, load the workflow-authoring skill (its rules and worked examples prevent common mistakes).",
	"Use it only when the user explicitly asks for a workflow or multi-agent orchestration, names a saved workflow, or a skill or command instructs it. The chance to parallelize work is not by itself a reason; use Agent for ordinary delegation.",
	"The script must start with `export const meta = { name, description, phases }` (a pure literal), followed by a body that uses agent(prompt, opts), parallel([...callbacks]), pipeline(items, ...stages), phase(title), workflow(name | {scriptPath}, args), log(value) and budget. agent() returns the agent's final text, or validated data when opts.schema is set; failures return null. Date.now(), argumentless new Date() and Math.random() are unavailable so runs replay deterministically.",
	"The result is a launch receipt; you will be notified when the workflow finishes. The script is saved, and the receipt gives its path: edit it and pass scriptPath to re-run, or pass resumeFromRunId (after stopping the earlier run with TaskStop) to reuse completed agent() results whose prompt and options did not change.",
].join("\n\n");

export class WorkflowTasks {
	private readonly tasks = new Map<string, WorkflowTask>();
	private readonly byRun = new Map<string, WorkflowTask>();
	/** Run ids being admitted or launched; taken synchronously so two resumes of one run cannot both proceed. */
	private readonly reserving = new Set<string>();
	private readonly engine: Engine;
	private readonly agentDir: string;
	private readonly env: Record<string, string | undefined>;

	constructor(input: { engine: Engine; agentDir: string; env: Record<string, string | undefined> }) {
		this.engine = input.engine;
		this.agentDir = input.agentDir;
		this.env = input.env;
	}

	private root(): string {
		const sessionId = this.engine.sessionId;
		if (!sessionId) throw new Error("The subagent engine is not bound to a session.");
		return join(this.agentDir, "subagents", sessionId, "workflows");
	}

	has(taskId: string): boolean {
		return this.tasks.has(taskId);
	}

	async launch(params: WorkflowInputParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<ToolText> {
		const known = new Set(["script", "name", "scriptPath", "args", "resumeFromRunId", "description", "title"]);
		const unknown = Object.keys(params).filter((key) => !known.has(key));
		if (unknown.length > 0) return error(`Unsupported Workflow input: ${unknown.join(", ")}.`);
		let snapshot: Snapshot;
		try {
			const resolved = await this.resolveSource(params, ctx);
			if ("error" in resolved) return error(resolved.error);
			snapshot = resolved;
		} catch (sourceError) {
			return error((sourceError as Error).message);
		}
		const parsed = parseWorkflowSource(snapshot.source);
		const name = parsed.meta?.name ?? "workflow";
		// Syntax failures produce the launch-shaped receipt with an error, but nothing is registered (plan §18).
		if (!parsed.meta || parsed.error) return receipt({ status: "async_launched", taskId: "", taskType: "local_workflow", workflowName: name, error: parsed.error ?? "Invalid workflow metadata.", notLaunched: true });
		const compiled = compileBody(parsed.body);
		if (!compiled.ok) return receipt({ status: "async_launched", taskId: "", taskType: "local_workflow", workflowName: name, error: compiled.error, notLaunched: true });

		const approval = await this.approve(snapshot, name, ctx, signal);
		if (approval) return error(approval);

		let runId: string;
		let replay = createReplayState();
		const digest = sha256(snapshot.source);
		if (params.resumeFromRunId !== undefined) {
			if (this.reserving.has(params.resumeFromRunId)) return error(`Workflow run ${params.resumeFromRunId} is already being resumed.`);
			this.reserving.add(params.resumeFromRunId);
			try {
				const resumed = await this.admitResume(params.resumeFromRunId);
				if ("error" in resumed) { this.reserving.delete(params.resumeFromRunId); return error(resumed.error); }
				runId = params.resumeFromRunId;
				replay = resumed.replay;
			} catch (admitError) {
				this.reserving.delete(params.resumeFromRunId);
				throw admitError;
			}
		} else {
			runId = `wf_${randomBytes(8).toString("hex")}`;
			this.reserving.add(runId);
		}
		try {
			return await this.start(runId, replay, digest, snapshot, parsed.meta, name, params, ctx);
		} finally {
			this.reserving.delete(runId);
		}
	}

	private async start(runId: string, replay: ReturnType<typeof createReplayState>, digest: string, snapshot: Snapshot,
		meta: { description: string }, name: string, params: WorkflowInputParams, ctx: ExtensionContext): Promise<ToolText> {
		// Recheck collisions immediately before registration (dossier §9).
		const existing = this.byRun.get(runId);
		if (existing && !this.settled(existing)) return error(`Workflow run ${runId} is still active. Stop it with TaskStop and wait for it to finish first.`);

		const root = this.root();
		const scriptsDir = join(root, "scripts");
		mkdirSync(scriptsDir, { recursive: true });
		const scriptPath = join(scriptsDir, `${runId}.js`);
		writeFileSync(scriptPath, snapshot.source);
		const runDir = join(root, runId);
		mkdirSync(runDir, { recursive: true });
		const journal = new WorkflowJournal(join(runDir, "journal.jsonl"));
		await journal.append({ type: "launched", scriptSha256: digest });

		const taskId = `wft_${randomBytes(8).toString("hex")}`;
		const controller = new AbortController();
		const obligations = new WorkflowObligations();
		const task: WorkflowTask = {
			taskId, runId, name, controller, status: "running", chainSettled: false, activeAgents: new Set(), obligations,
			execution: Promise.resolve(undefined as never), journalFile: journal.file,
		};
		const host = this.host(task, ctx, root);
		task.execution = runWorkflow({
			source: snapshot.source, args: copyArgs(params.args), host, runId, taskId, journal, replay, signal: controller.signal, obligations, env: this.env,
		});
		this.tasks.set(taskId, task);
		this.byRun.set(runId, task);
		void task.execution.then((result) => this.finish(task, result, root), (runError) => this.finish(task, { status: "failed", error: String((runError as Error).message), agentCount: 0, logs: [], failures: [], durationMs: 0 }, root));
		return receipt({
			status: "async_launched", taskId, taskType: "local_workflow", workflowName: name, runId, summary: meta.description,
			transcriptDir: runDir, scriptPath,
		});
	}

	/** TaskStop for a workflow task: abort its controller and active agents. Returns undefined when the id is not a workflow. */
	stop(taskId: string): ToolText | undefined {
		const task = this.tasks.get(taskId) ?? this.byRun.get(taskId);
		if (!task) return undefined;
		if (task.status !== "running") return error(`Workflow ${task.taskId} is not running.`);
		task.controller.abort();
		return { text: `Stopping workflow ${task.name} (${task.taskId}).`, details: { taskId: task.taskId, runId: task.runId } };
	}

	/** Stop every running workflow (session end). */
	async stopAll(): Promise<void> {
		for (const task of this.tasks.values()) if (task.status === "running") task.controller.abort();
		await Promise.allSettled([...this.tasks.values()].map((task) => task.execution));
	}

	private settled(task: WorkflowTask): boolean {
		return task.status !== "running" && task.chainSettled && task.activeAgents.size === 0 && task.obligations.count === 0;
	}

	/** Resume admission: same session, prior task terminal with chain settled, no attempts and no outstanding obligations (§18.1 H1). */
	private async admitResume(runId: string): Promise<{ replay: ReturnType<typeof createReplayState> } | { error: string }> {
		if (!/^wf_[a-z0-9_-]{1,64}$/.test(runId)) return { error: `Invalid workflow run id "${runId}".` };
		const previous = this.byRun.get(runId);
		if (previous) {
			if (previous.status === "running") return { error: `Workflow run ${runId} is still running. Stop it with TaskStop first.` };
			if (!this.settled(previous) && !(await previous.obligations.wait(RESUME_QUIESCENCE_MS))) {
				return { error: `Workflow run ${runId} is still finishing its last agent calls; try again shortly.` };
			}
		}
		const journal = new WorkflowJournal(join(this.root(), runId, "journal.jsonl"));
		let loaded;
		try {
			loaded = await journal.load();
		} catch (loadError) {
			return { error: `Workflow run ${runId} cannot be resumed: ${(loadError as Error).message}` };
		}
		if (!loaded.scriptSha256 && loaded.results.size === 0 && loaded.started.size === 0) return { error: `No workflow run ${runId} exists in this session.` };
		await journal.append({ type: "resumed" });
		return { replay: createReplayState({ results: loaded.results, started: loaded.started, failed: loaded.failed }) };
	}

	private async resolveSource(params: WorkflowInputParams, ctx: ExtensionContext): Promise<Snapshot | { error: string }> {
		if (params.scriptPath !== undefined) {
			// An already reviewed script snapshot wins over re-reading a possibly replaced file.
			if (typeof params.script === "string" && params.script) return { source: checkInline(params.script), kind: "path", path: params.scriptPath };
			const read = readScriptPath(params.scriptPath, ctx.cwd);
			return { source: read.source, kind: "path", path: read.canonicalPath };
		}
		if (params.name !== undefined) {
			const definition = discoverWorkflows({ agentDir: this.agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }).get(params.name);
			if (!definition) return { error: `No workflow named "${params.name}".` };
			return { source: definition.source, kind: "named", path: definition.path };
		}
		if (typeof params.script === "string" && params.script.trim()) return { source: checkInline(params.script), kind: "inline" };
		return { error: "Workflow needs a script, a name, or a scriptPath." };
	}

	/** Dynamic scripts (inline/path) need the user's approval of the exact bytes; named, trusted definitions run directly. */
	private async approve(snapshot: Snapshot, name: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string | undefined> {
		if (snapshot.kind === "named") return undefined;
		if (this.env.PI_WORKFLOW_APPROVE === "1") return undefined;
		if (!ctx.hasUI) return "Dynamic workflow scripts need the user's approval, and this session has no interactive UI. Set PI_WORKFLOW_APPROVE=1 to allow them.";
		// The confirmation surface has a bounded preview. Never authorize bytes
		// omitted from it; large scripts need an explicitly approved configuration.
		if (snapshot.source.length > 20_000) return "This workflow is too long to review completely in the confirmation dialog (maximum 20000 characters). Shorten it or explicitly configure PI_WORKFLOW_APPROVE=1 after reviewing the complete source.";
		const approved = await ctx.ui.confirm(`Run workflow "${name}"?`, `${snapshot.path ? `${snapshot.path}\n\n` : ""}${snapshot.source}`, { signal } as never);
		return approved ? undefined : "The user declined to run this workflow.";
	}

	private host(task: WorkflowTask, ctx: ExtensionContext, root: string): WorkflowHost {
		return {
			runAgent: async (request) => {
				const ref = `${request.logicalIndex}:${request.attempt}`;
				task.activeAgents.add(ref);
				try {
					return await runWorkflowAgent(this.engine, ctx, request);
				} finally {
					task.activeAgents.delete(ref);
				}
			},
			sessionOutputTokens: () => this.engine.sessionOutputTokens(),
			loadNamed: async (name) => {
				const definition = discoverWorkflows({ agentDir: this.agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }).get(name);
				return definition ? { source: definition.source, path: definition.path } : undefined;
			},
			readScriptPath: async (path) => {
				const snapshot = readScriptPath(path, ctx.cwd);
				const parsed = parseWorkflowSource(snapshot.source);
				if (!parsed.meta || parsed.error) throw new Error(parsed.error ?? "Invalid nested workflow metadata.");
				const refusal = await this.approve({ source: snapshot.source, path: snapshot.canonicalPath, kind: "path" }, parsed.meta.name, ctx, task.controller.signal);
				if (refusal) throw new Error(refusal);
				// Execute exactly the bytes shown above, even if the file was replaced
				// while the user reviewed them. Named nested workflows stay direct.
				return snapshot;
			},
			progress: (event) => this.engine.emitWorkflowProgress(task.taskId, task.runId, event),
		};
		void root;
	}

	private finish(task: WorkflowTask, result: WorkflowRunResult, root: string): void {
		task.chainSettled = true;
		task.obligations.close();
		task.status = task.controller.signal.aborted && result.status !== "completed" ? "killed" : result.status;
		try {
			writeFileSync(join(root, `${task.runId}.json`), JSON.stringify({
				runId: task.runId, taskId: task.taskId, name: task.name, status: task.status, result: result.result, error: result.error,
				agentCount: result.agentCount, failures: result.failures, logs: result.logs, durationMs: result.durationMs,
			}, null, 2));
		} catch {}
		this.engine.recordWorkflowCompletion({ taskId: task.taskId, runId: task.runId, name: task.name, status: task.status, result, journalFile: task.journalFile });
	}
}

export function registerWorkflowTool(pi: ExtensionAPI, workflows: () => WorkflowTasks): void {
	for (const toolName of ["Workflow", "RunWorkflow"]) {
		pi.registerTool(defineTool({
			name: toolName,
			label: "Workflow",
			description: toolName === "Workflow" ? WORKFLOW_DESCRIPTION : "Alias of Workflow.",
			parameters: Type.Object({
				script: Type.Optional(Type.String({ description: "Self-contained workflow script beginning with `export const meta = {...}`." })),
				name: Type.Optional(Type.String({ description: "Name of a saved workflow." })),
				description: Type.Optional(Type.String({ description: "Ignored; set the description in meta." })),
				title: Type.Optional(Type.String({ description: "Ignored; set the title in meta." })),
				args: Type.Optional(Type.Unknown({ description: "Value exposed to the script as `args`. Pass real JSON values, not a JSON-encoded string." })),
				scriptPath: Type.Optional(Type.String({ description: "Path to a workflow script file; takes precedence over script and name." })),
				resumeFromRunId: Type.Optional(Type.String({ description: "Run id of an earlier workflow to resume, reusing unchanged agent() results. Stop that run first." })),
			}, { additionalProperties: false }),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await workflows().launch(params as WorkflowInputParams, ctx, signal);
				if (result.isError) throw new Error(result.text);
				return { content: [{ type: "text" as const, text: result.text }], details: result.details ?? {} };
			},
		}));
	}
}

function receipt(value: Record<string, unknown>): ToolText {
	const { notLaunched, ...shape } = value;
	const lines = [JSON.stringify(shape, null, 2)];
	if (notLaunched) lines.push("The workflow was NOT launched: fix the script and try again.");
	else lines.push("The workflow is running in the background; you will be notified when it finishes. Do not poll or predict its results.");
	return { text: lines.join("\n\n"), details: shape };
}

function error(text: string): ToolText {
	return { text, isError: true };
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function checkInline(script: string): string {
	if (script.length > MAX_SCRIPT_LENGTH) throw new Error(`The workflow script exceeds ${MAX_SCRIPT_LENGTH} characters.`);
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(script)) throw new Error("The workflow script contains control characters.");
	return script.replace(/\r\n/g, "\n");
}

/** Path admission: canonical regular file within the size bound, read once (plan §18). */
function readScriptPath(path: string, cwd: string): { source: string; canonicalPath: string } {
	if (/^(\\\\|\/\/)/.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error("Workflow scripts must be local files.");
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	const canonicalPath = realpathSync(absolute);
	const stat = statSync(canonicalPath);
	if (!stat.isFile()) throw new Error(`${path} is not a regular file.`);
	if (stat.size > MAX_SCRIPT_LENGTH) throw new Error(`${path} exceeds ${MAX_SCRIPT_LENGTH} bytes.`);
	return { source: checkInline(readFileSync(canonicalPath, "utf8")), canonicalPath };
}

function copyArgs(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
