import { defineTool, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { createChildSession, type ChildSession, type ChildIdentity } from "herdr-runner/child.ts";
import { createBackendController, type HerdrBackendHandle } from "herdr-runner/backend.ts";
export type { HerdrBackendHandle, HerdrBackendNotice, HerdrBackendRequest } from "herdr-runner/backend.ts";
import type { ExecutionEvent, RunRef } from "herdr-runner/state.ts";
import {
	completionNotice,
	qualifiedAgentId,
	readHerdrAgent,
	HerdrRunner,
	spawnHerdrAgent,
	steerHerdrAgent,
	type SpawnRequest,
	type ToolText,
} from "herdr-runner/runner.ts";
import { EXPLICIT_SUBAGENT_REQUEST } from "./policy.ts";
import { HerdrParent, machineGuidance, remoteWorkerEntry as coreRemoteWorkerEntry, type ParentDeps } from "herdr-runner/parent.ts";
import type { TerminalHost } from "herdr-runner/host.ts";
export { machineGuidance, samePath } from "herdr-runner/parent.ts";

export type HerdrSubagentDeps = ParentDeps;

/** Remote machines keep running this package's forwarding entry, so its absolute path stays the default. */
const WORKER_ENTRY = fileURLToPath(new URL("./worker-entry.mjs", import.meta.url));

/** New overrides name the standalone root; legacy overrides name a Grok root with a forwarding entry. */
export function remoteWorkerEntry(env: NodeJS.ProcessEnv): string {
	return coreRemoteWorkerEntry(env, WORKER_ENTRY);
}

const POLL_MS = 200;

export interface HerdrSubagentOptions extends Partial<HerdrSubagentDeps> {
	mode?: "backend";
	/** Defaults to the host this process runs in, else herdr. */
	host?: TerminalHost;
	onBackend?: (handle: HerdrBackendHandle) => void;
}

export function createHerdrSubagents(overrides: HerdrSubagentOptions = {}): ExtensionFactory {
	return async (pi: ExtensionAPI) => {
		const parent = new HerdrParent({ ...overrides, agentDir: overrides.agentDir ?? getAgentDir(), defaultWorkerEntry: WORKER_ENTRY });
		const { deps, hc, paneId } = parent;
		await parent.load();
		const savedMachines = machineGuidance(parent.profiles) + "\nTo launch remotely, call Agent with machine and an absolute machine_cwd on that machine; the backend handles SSH and startup. Do not use SSH or terminal.run to launch agents yourself. Remote project paths may differ from this session's directory; use a confirmed path, not a guess."
			+ (hc ? " In the Herdr app, discover existing working directories with hc ls --json; remote terminal addresses start with the saved machine name followed by /." : "");
		const queuedNotices = new Set<string>();
		parent.onRemember = (machine) => pi.appendEntry("herdr-remote-machine", { machine });
		/** Saved receipts whose machine is unreachable; retried each tick. */
		const pendingReceipts = new Map<string, string>();
		let child: ChildSession | undefined;
		/** Label writes in order, so a late one cannot restore a conversation this Pi has left. */
		let publication = Promise.resolve();
		const publish = (sessionFile: string | undefined, report: (error: unknown) => void = () => undefined) =>
			publication = publication.then(() => deps.client.publishSession?.(paneId, sessionFile)).catch(report);
		let tick: Promise<void> | undefined;
		/** Sessions started in this load; a retry for an earlier one begins nothing. */
		let sessions = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let initializing: Promise<void> | undefined;
		let receiptCursor = 0;
		let timer: ReturnType<typeof setInterval> | undefined;
		let streaming = false;
		let assistant = "";
		let outcome: "completed" | "aborted" | "error" = "completed";
		const messenger = {
			sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }) {
				pi.sendUserMessage(text, options);
			},
			abort() {},
			assistantText: () => assistant,
			streaming: () => streaming,
			clearAssistant() { assistant = ""; },
			checkpoint(ref: RunRef, event: ExecutionEvent) { pi.appendEntry("herdr-execution-checkpoint", { ref, event }); },
		};

		const backend = overrides.mode === "backend" ? createBackendController({
			machineGuidance: savedMachines,
			assertActive: () => parent.assertActive(),
			paneChild: () => child !== undefined,
			route: (agentId) => parent.routeLive(agentId),
			caller: (ctx, current, cwd) => parent.caller(current, cwd, ctx.sessionManager.getSessionFile()),
			async spawn(request, ctx, signal) {
				if (!request.resume && request.runtime === "claude-code" && request.machine?.trim()) throw new Error("Claude Code subagents currently support local Herdr panes only.");
				const target = request.resume ? await parent.route(request.resume) : undefined;
				const machine = target ? target.runner.machine : request.machine?.trim() || undefined;
				if (machine && request.inheritContext) throw new Error("inherit_context cannot clone this session onto another machine.");
				const current = target?.runner ?? (machine ? await parent.machine(machine) : await parent.local());
				const cwd = machine ? parent.machineCwd(machine, request.machineCwd) || ctx.cwd : request.cwd || ctx.cwd;
				if (machine) parent.remember(machine);
				const sessionFile = ctx.sessionManager.getSessionFile();
				const ref = target
					? await current.resume(target.id, request.prompt, signal, request.runInBackground, await parent.caller(current, (await current.resolve(target.id)).cwd ?? cwd, sessionFile))
					: await current.spawn({
						...request, ...(await parent.caller(current, cwd, sessionFile)), cwd, definitionsCwd: ctx.cwd,
						agentDir: deps.agentDir, projectTrusted: ctx.isProjectTrusted(),
					}, signal);
				return { ...ref, runner: current };
			},
			content: completionNotice,
		}) : undefined;

		if (!backend) {
		pi.registerTool(defineTool({
			name: "Agent",
			label: "Agent",
			description: EXPLICIT_SUBAGENT_REQUEST + "\n\nLaunch a subagent as its own Pi (default) or Claude Code process in a Herdr pane. Set runtime to claude-code only when the user requests Claude Code. Claude Code supports local Windows/Linux/macOS panes, normal permissions, results, and resume; live steering and max_turns are unsupported, and Stop closes its pane. Background by default. Use get_subagent_result for the outcome and steer_subagent to redirect a running agent. Reuse the same subagent for follow-up work on that thread: steer_subagent while it is running, or resume after it has finished. Start a new Agent only for new work. A blocked agent returns immediately and stays open in its pane. Results are limited to 2000 lines or 50KB; full output remains in the pane. Keep inherit_context false; the orchestrating agent must provide all needed context in the prompt. schedule and isolation are not available here. Set machine only when the user asks to run the agent on a saved Herdr SSH machine; its agent ID then ends in @<machine>." + savedMachines,
			parameters: Type.Object({
				runtime: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude-code")], { description: "Default pi. Use claude-code only when the user requests Claude Code. Ignored with resume, which preserves the original runtime." })),
				prompt: Type.String({ description: "The task for the agent to perform." }),
				description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
				name: Type.Optional(Type.String({ description: "Optional memorable name, letters, digits, underscores, and hyphens." })),
				subagent_type: Type.String({ description: "Agent type. A matching .pi/agents or user agent file supplies its prompt and tool list." }),
				model: Type.Optional(Type.String({ description: "Optional model override. Pi accepts provider/modelId or a fuzzy name; Claude Code uses native names such as sonnet or opus." })),
				thinking: Type.Optional(Type.String({ description: "Pi thinking: off, minimal, low, medium, high, xhigh, max. Claude Code effort: low, medium, high, xhigh, max (model-dependent)." })),
				max_turns: Type.Optional(Type.Number({ description: "Maximum turns before stopping. Omit for unlimited.", minimum: 1 })),
				run_in_background: Type.Optional(Type.Boolean({ description: "Defaults to true. Set false to wait for the result, or for blocked." })),
				resume: Type.Optional(Type.String({ description: "Agent ID to resume after its current run has finished." })),
				isolated: Type.Optional(Type.Boolean({ description: "If true, the child may use only built-in tools." })),
				keep: Type.Optional(Type.Boolean({ description: "Keep this agent's pane open after it finishes. Overrides agent-file keep; preserved on resume. Owner disappearance still closes it." })),
				inherit_context: Type.Optional(Type.Boolean({ description: "Must remain false. The orchestrating agent provides all needed context in the prompt." })),
				machine: Type.Optional(Type.String({ description: "Saved Herdr SSH machine (label or profile ID) to run on. Only when the user asks. Ignored with resume; the agent ID names its machine." })),
				machine_cwd: Type.Optional(Type.String({ description: "Absolute working directory on that machine, such as C:/git/project on Windows. Overrides the per-machine cwd in the user agent directory's herdr-subagents.json; otherwise defaults to this session's directory." })),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				if (!params.resume && params.runtime === "claude-code" && params.machine?.trim()) throw new Error("Claude Code subagents currently support local Herdr panes only.");
				const target = params.resume ? await parent.route(params.resume) : undefined;
				const machine = target ? target.runner.machine : params.machine?.trim() || undefined;
				if (machine && params.inherit_context) throw new Error("inherit_context cannot clone this session onto another machine.");
				const current = target?.runner ?? (machine ? await parent.machine(machine) : await parent.local());
				const cwd = machine ? parent.machineCwd(machine, params.machine_cwd) || ctx.cwd : ctx.cwd;
				const request: SpawnRequest = {
					runtime: params.runtime,
					prompt: params.prompt,
					description: params.description,
					name: params.name,
					subagentType: params.subagent_type,
					model: params.model,
					thinking: params.thinking,
					maxTurns: params.max_turns,
					runInBackground: params.run_in_background !== false,
					resume: target?.id,
					isolated: params.isolated,
					keep: params.keep,
					projectTrusted: ctx.isProjectTrusted(),
					inheritContext: params.inherit_context,
					cwd,
					definitionsCwd: ctx.cwd,
					...(await parent.caller(current, target ? (await current.resolve(target.id)).cwd ?? cwd : cwd, ctx.sessionManager.getSessionFile())),
					agentDir: deps.agentDir,
				};
				// Record the machine first: a launch that loses its channel must still be reconnected and its owner retired.
				if (machine) parent.remember(machine);
				const result = await spawnHerdrAgent(request, { ...deps, signal, runner: current });
				return toolResult(result);
			},
		}));

		pi.registerTool(defineTool({
			name: "get_subagent_result",
			label: "Get Agent Result",
			description: "Check status and retrieve a Herdr subagent's result. Use the agent ID returned by Agent. wait: true waits until it finishes or blocks. After the result, resume that same agent for follow-up work instead of starting a new one. Results are limited to 2000 lines or 50KB; full output remains in the pane.",
			promptSnippet: "Check status and retrieve results from a background agent",
			parameters: Type.Object({
				agent_id: Type.String({ description: "The agent ID returned by Agent, or the name given at spawn." }),
				run_id: Type.Optional(Type.String({ description: "A run ID from Agent or a completion notice. Omit to capture the agent's current run." })),
				wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete or block. Default: false." })),
				verbose: Type.Optional(Type.Boolean({ description: "If true, note that the full conversation is in the Herdr pane. Default: false." })),
			}),
			execute: async (_toolCallId, params, signal) => {
				const { id, runner: current } = await parent.route(params.agent_id);
				const result = await readHerdrAgent(deps.root, id, { wait: params.wait, verbose: params.verbose, runId: params.run_id }, { ...deps, signal, runner: current });
				return toolResult(result);
			},
		}));

		pi.registerTool(defineTool({
			name: "steer_subagent",
			label: "Steer Agent",
			description: "Send a steering message to a running Herdr subagent. Use this for follow-up work on the same thread instead of starting another agent. It is delivered after the current tool execution. Only works while that Pi pane is still running. Claude Code does not support live steering; wait for completion and use Agent with resume.",
			promptSnippet: "Send a steering message to redirect a running background agent",
			parameters: Type.Object({
				agent_id: Type.String({ description: "The agent ID to steer." }),
				message: Type.String({ description: "The steering message. It appears as a user message in the child." }),
			}),
			execute: async (_toolCallId, params) => {
				const { id, runner: current } = await parent.route(params.agent_id);
				const result = await steerHerdrAgent(deps.root, id, params.message, { ...deps, runner: current });
				return toolResult(result);
			},
		}));

		}

		pi.on("session_start", async (_event, ctx) => {
			parent.restart();
			backend?.reset();
			streaming = !ctx.isIdle();
			queuedNotices.clear();
			pendingReceipts.clear();
			receiptCursor = 0;
			messenger.abort = () => { void ctx.abort(); };
			const generation = ++sessions;
			const live = () => !parent.stopped && generation === sessions;
			let lastFailure: string | undefined;
			let answering = false;
			// hc tags its records by the core's id. Until that answers, nothing is maintained; identification is retried with
			// backoff while this session lasts, and the session's coordination begins once it succeeds.
			// Every failure, including a store that cannot open, is reported and retried; this never rejects.
			const initialize = async (attempt: number): Promise<void> => {
				let current: HerdrRunner | undefined;
				try {
					current = await parent.local();
					if (live()) await begin(current);
					return;
				} catch (error) {
					// Herdr's runner opens synchronously, so its setup failures reach Pi as before.
					if (!hc) throw error;
					await abandon(current);
					if (!live()) return;
					const message = error instanceof Error ? error.message : String(error);
					if (message !== lastFailure) ctx.ui.notify(`Herdr coordination: ${message}`, "error");
					lastFailure = message;
					retry = setTimeout(() => { retry = undefined; initializing = initialize(attempt + 1); }, Math.min(POLL_MS * 2 ** attempt, 5000));
					retry.unref();
				}
			};
			/** A failed start leaves nothing behind: its child binding, timer, and a runner whose store may not have opened. */
			const abandon = async (failed: HerdrRunner | undefined) => {
				if (timer) clearInterval(timer);
				timer = undefined;
				await child?.dispose().catch(() => undefined);
				child = undefined;
				await parent.abandon(failed);
			};
			const begin = async (current: HerdrRunner) => {
				const entries = ctx.sessionManager.getEntries();
				let checkpoint: ChildIdentity["checkpoint"];
				for (const entry of entries) {
					if (entry.type === "custom" && entry.customType === "herdr-execution-checkpoint") checkpoint = entry.data as ChildIdentity["checkpoint"];
					const used = entry.type === "custom" && entry.customType === "herdr-remote-machine" ? (entry.data as { machine?: unknown } | undefined)?.machine : undefined;
					if (typeof used === "string") parent.recordedMachines.add(used);
				}
				const messages = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
				assistant = messages.map(assistantText).filter(Boolean).at(-1) ?? "";
				outcome = runOutcome(messages);
				const identity = { sessionFile: ctx.sessionManager.getSessionFile() ?? "", sessionId: ctx.sessionManager.getSessionId(), checkpoint };
				const attachChild = async () => {
					child = await createChildSession(current.store, paneId, identity, messenger);
					if (child && !answering) { answering = true; registerNeedsAnswer(); }
				};
				const registerNeedsAnswer = () => pi.registerTool(defineTool({
					name: "needs_answer",
					label: "Needs answer",
					description: "End this run immediately with one concrete question and the current work state. The parent can reply with SendMessage to resume this same agent.",
					parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
					async execute(_id, { question }) {
						if (!child) throw new Error("Not a Herdr child session.");
						await child.needsAnswer(question);
						return { content: [{ type: "text", text: question }], details: undefined, terminate: true };
					},
				}));
				await attachChild();
				// hc starts a subagent's Pi before its runner records the terminal, so the first attach can come too early.
				const attachUntil = hc && !child && paneId ? deps.now() + 15_000 : 0;
				if (timer) clearInterval(timer);
				/** The last error per source ("" for this machine), so failing machines never alternate past deduplication. */
				const lastErrors = new Map<string, string>();
				const reportError = (error: unknown, source = "") => {
					const message = error instanceof Error ? error.message : String(error);
					if (!parent.stopped && message !== lastErrors.get(source)) ctx.ui.notify(`Herdr coordination: ${message}`, "error");
					lastErrors.set(source, message);
				};
				const deliver = async (source: HerdrRunner) => {
					if (parent.stopped) return;
					const ownerSession = ctx.sessionManager.getSessionFile();
					const ownerMachine = source.machine ? current.machineId : undefined;
					if (backend) return backend.deliver(source, parent.parentKey(source.machine), ownerSession, ownerMachine);
					for (const notice of await source.store.notices(parent.parentKey(source.machine), ownerSession, ownerMachine)) {
						if (parent.stopped || queuedNotices.has(notice.id)) continue;
						pi.sendMessage({
							customType: "herdr-subagent-notification", content: completionNotice(notice, source.machine), display: true,
							details: { noticeId: notice.id, agentId: qualifiedAgentId(notice.agentId, source.machine), runId: notice.runId, machine: source.machine },
						}, { deliverAs: "steer", triggerTurn: true });
						queuedNotices.add(notice.id);
					}
				};
				const poll = async () => {
					if (!child && attachUntil > deps.now()) await attachChild();
					await child?.poll();
					if (parent.stopped) return;
					// A sendMessage call may only queue a message. Acknowledge only evidence actually in Pi's session.
					const saved = ctx.sessionManager.getEntries();
					for (const entry of backend ? [] : saved.slice(receiptCursor)) {
						if (entry.type !== "custom_message" || entry.customType !== "herdr-subagent-notification") continue;
						const details = entry.details as { noticeId?: string; machine?: string } | undefined;
						if (details?.noticeId) pendingReceipts.set(details.noticeId, details.machine ?? "");
					}
					receiptCursor = saved.length;
					// Slow Herdr calls and machines must not delay the child's command/cancellation polling.
					await parent.tick(current, {
						async service(machine, source) {
							await acknowledge(machine, source);
							await deliver(source);
						},
						reportError,
						recovered: (machine) => { lastErrors.delete(machine); },
					});
				};
				const acknowledge = async (machine: string, source: HerdrRunner) => {
					for (const [noticeId, owner] of pendingReceipts) {
						if (owner !== machine) continue;
						await source.store.acknowledgeNotice(noticeId);
						pendingReceipts.delete(noticeId);
						queuedNotices.delete(noticeId);
					}
				};
				// The app cannot see which conversation a Pi runs; its subagents' runners read it from this terminal's labels.
				if (hc && paneId) publish(identity.sessionFile || undefined, reportError);
				timer = setInterval(() => {
					if (parent.stopped || tick) return;
					tick = poll().catch((error) => reportError(error)).finally(() => { tick = undefined; });
				}, POLL_MS);
				timer.unref();
			};
			await (initializing = initialize(0));
		});
		pi.on("session_shutdown", async (event) => {
			parent.stopped = true;
			if (retry) clearTimeout(retry);
			retry = undefined;
			// A retry already identifying finishes first, and then begins nothing.
			await initializing?.catch(() => undefined);
			if (timer) clearInterval(timer);
			timer = undefined;
			await tick;
			if (hc && paneId) await publish(undefined);
			if (event?.reason !== "reload") await child?.noteExit();
			await child?.dispose();
			child = undefined;
			await parent.close();
		});
		pi.on("input", (event) => child?.input(event.text));
		pi.on("agent_start", async () => {
			streaming = true;
			outcome = "completed";
			await child?.noteLive();
		});
		pi.on("agent_end", (event) => {
			outcome = runOutcome(event.messages);
		});
		pi.on("agent_settled", async () => {
			streaming = false;
			await child?.noteSettled(outcome);
		});
		pi.on("ui_prompt_start", () => child?.noteStatus("blocked"));
		pi.on("ui_prompt_end", () => child?.noteStatus("running"));
		pi.on("turn_end", () => child?.noteTurn());
		pi.on("message_end", (event) => {
			const text = assistantText(event.message);
			if (text) assistant = text;
		});
		// Filter only the current declarations: never activate deferred/codemode tools just because they are allowed.
		pi.on("before_agent_start", () => {
			if (child) pi.setActiveTools(pi.getActiveTools().filter((name) => child!.allows(name)));
		});
		pi.on("tool_call", (event) => {
			if (!child || child.allows(event.toolName)) return;
			return { block: true, reason: "This subagent is not allowed to use that tool." };
		});
		if (backend) overrides.onBackend?.(backend.handle);
	};
}

function toolResult(result: ToolText) {
	if (result.details.status === "error") throw new Error(result.text);
	const limited = truncateHead(result.text);
	const text = limited.truncated
		? `${limited.content}\n\n[Output limited to 2000 lines or 50KB. Full conversation is in Herdr pane ${result.details.paneId ?? "shown in the result"}.]`
		: result.text;
	return { content: [{ type: "text" as const, text }], details: result.details };
}

function runOutcome(messages: unknown): "completed" | "aborted" | "error" {
	if (!Array.isArray(messages)) return "completed";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") continue;
		const reason = (message as { stopReason?: string }).stopReason;
		if (reason === "error") return "error";
		if (reason === "aborted") return "aborted";
		return "completed";
	}
	return "completed";
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const record = message as { role?: string; content?: unknown };
	if (record.role && record.role !== "assistant") return "";
	if (typeof record.content === "string") return record.content;
	if (!Array.isArray(record.content)) return "";
	return record.content.map((block: unknown) => {
		if (!block || typeof block !== "object") return "";
		const text = (block as { type?: string; text?: string }).text;
		return (block as { type?: string }).type === "text" && typeof text === "string" ? text : "";
	}).filter(Boolean).join("\n");
}
