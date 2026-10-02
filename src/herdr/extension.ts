import { defineTool, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrCli, findHerdrMachine, type HerdrClient } from "./client.ts";
import { createChildSession, type ChildSession, type ChildIdentity } from "./child.ts";
import type { ExecutionEvent, RunRef } from "./state.ts";
import {
	completionNotice,
	qualifiedAgentId,
	readHerdrAgent,
	HerdrRunner,
	splitAgentId,
	spawnHerdrAgent,
	steerHerdrAgent,
	type SpawnRequest,
	type ToolText,
} from "./runner.ts";
import { herdrSubagentRoot, sshChannel, type StoreChannelFactory } from "./store.ts";

export interface HerdrSubagentDeps {
	env: NodeJS.ProcessEnv;
	root: string;
	client: HerdrClient;
	agentDir: string;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	/** Herdr CLI routed to a saved SSH machine. */
	machineClient: (machine: string) => HerdrClient;
	/** Opens the coordination store that lives on a saved SSH machine. */
	machineChannel: (machine: string) => Promise<StoreChannelFactory>;
	/** Distinguishes this machine's panes in a remote store, where pane IDs belong to another server. */
	hostname: string;
}

/** The remote store runs this package's worker entry, by default at the same path as here. */
export function remoteWorkerEntry(env: NodeJS.ProcessEnv): string {
	const pkg = env.GROK_HERDR_REMOTE_PACKAGE?.replace(/\/+$/, "");
	return pkg ? `${pkg}/src/herdr/worker-entry.mjs` : fileURLToPath(new URL("./worker-entry.mjs", import.meta.url));
}

const POLL_MS = 200;

export function createHerdrSubagents(overrides: Partial<HerdrSubagentDeps> = {}): ExtensionFactory {
	const env = overrides.env ?? process.env;
	const deps: HerdrSubagentDeps = {
		env,
		root: overrides.root ?? herdrSubagentRoot(env),
		client: overrides.client ?? createHerdrCli(env),
		agentDir: overrides.agentDir ?? getAgentDir(),
		sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		now: overrides.now ?? Date.now,
		machineClient: overrides.machineClient ?? ((machine) => createHerdrCli(env, undefined, machine)),
		machineChannel: overrides.machineChannel ?? (async (machine) => sshChannel({
			target: (await findHerdrMachine(machine, env)).target,
			node: env.GROK_HERDR_REMOTE_NODE,
			entry: remoteWorkerEntry(env),
		})),
		hostname: overrides.hostname ?? hostname(),
	};
	const paneId = deps.env.HERDR_PANE_ID ?? "";
	// Remote stores key notices by this pane; a bare pane ID could name one of that machine's own panes.
	const parentKey = (machine?: string) => machine && paneId ? `${deps.hostname}/${paneId}` : paneId;
	return (pi: ExtensionAPI) => {
		const queuedNotices = new Set<string>();
		let runner: HerdrRunner | undefined;
		const getRunner = () => runner ??= new HerdrRunner(deps);
		/** One runner, and one SSH store channel, per saved machine used by this session. */
		const machines = new Map<string, Promise<HerdrRunner>>();
		const machineRunners = new Map<string, HerdrRunner>();
		const recordedMachines = new Set<string>();
		/** Owners whose channel dropped. A reconnect retires them so the machine can recover their launches. */
		const lostOwners = new Map<string, string[]>();
		/** Saved receipts whose machine is unreachable; retried each tick. */
		const pendingReceipts = new Map<string, string>();
		const machineRunner = (machine: string): Promise<HerdrRunner> => {
			let pending = machines.get(machine);
			if (!pending) {
				pending = deps.machineChannel(machine).then((channel) => {
					const opened = new HerdrRunner({ ...deps, root: "", client: deps.machineClient(machine), channel, machine });
					if (machines.get(machine) === pending) machineRunners.set(machine, opened);
					// Retire in the background: a stalled call must not hold the open, which shutdown awaits.
					// An owner that could not be retired is kept for the next reconnect.
					const lost = lostOwners.get(machine) ?? [];
					lostOwners.delete(machine);
					for (const owner of lost) {
						opened.store.retireOwner(owner).catch(() => lostOwners.set(machine, [...lostOwners.get(machine) ?? [], owner]));
					}
					return opened;
				});
				machines.set(machine, pending);
				pending.catch(() => machines.delete(machine));
			}
			return pending;
		};
		const dropMachine = async (machine: string) => {
			const pending = machines.get(machine);
			const stale = machineRunners.get(machine);
			machines.delete(machine);
			machineRunners.delete(machine);
			if (stale?.store.failed) lostOwners.set(machine, [...lostOwners.get(machine) ?? [], stale.owner]);
			// A channel still opening is closed once it opens, so shutdown never leaves an SSH process behind.
			await (await pending?.catch(() => undefined))?.close().catch(() => undefined);
		};
		const remember = (machine: string) => {
			// Reload reopens the machines this session used, so their completion notices still arrive.
			if (recordedMachines.has(machine)) return;
			recordedMachines.add(machine);
			pi.appendEntry("herdr-remote-machine", { machine });
		};
		const route = async (agentId: string) => {
			const { id, machine } = splitAgentId(agentId);
			return { id, runner: machine ? await machineRunner(machine) : getRunner() };
		};
		const remoteWorkspace = async (machine: string, cwd: string) => {
			// Reuse the workspace already open in that directory, so its tabs form the same grid.
			try { return (await deps.machineClient(machine).listPanes()).find((pane) => pane.cwd === cwd)?.workspaceId; }
			catch { return undefined; }
		};
		let child: ChildSession | undefined;
		let stopped = false;
		let tick: Promise<void> | undefined;
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

		pi.registerTool(defineTool({
			name: "Agent",
			label: "Agent",
			description: "Launch a subagent as its own Pi process in a Herdr pane. Background by default. Use get_subagent_result for the outcome and steer_subagent to redirect a running agent. Reuse the same subagent for follow-up work on that thread: steer_subagent while it is running, or resume after it has finished. Start a new Agent only for new work. A blocked agent returns immediately and stays open in its pane. Results are limited to 2000 lines or 50KB; full output remains in the pane. Keep inherit_context false; the orchestrating agent must provide all needed context in the prompt. schedule and isolation are not available here. Set machine only when the user asks to run the agent on a saved Herdr SSH machine; its agent ID then ends in @<machine>.",
			parameters: Type.Object({
				prompt: Type.String({ description: "The task for the agent to perform." }),
				description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
				name: Type.Optional(Type.String({ description: "Optional memorable name, letters, digits, underscores, and hyphens." })),
				subagent_type: Type.String({ description: "Agent type. A matching .pi/agents or user agent file supplies its prompt and tool list." }),
				model: Type.Optional(Type.String({ description: "Optional model override. Accepts provider/modelId or a fuzzy name." })),
				thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, max." })),
				max_turns: Type.Optional(Type.Number({ description: "Maximum turns before stopping. Omit for unlimited.", minimum: 1 })),
				run_in_background: Type.Optional(Type.Boolean({ description: "Defaults to true. Set false to wait for the result, or for blocked." })),
				resume: Type.Optional(Type.String({ description: "Agent ID to resume after its current run has finished." })),
				isolated: Type.Optional(Type.Boolean({ description: "If true, the child may use only built-in tools." })),
				inherit_context: Type.Optional(Type.Boolean({ description: "Must remain false. The orchestrating agent provides all needed context in the prompt." })),
				machine: Type.Optional(Type.String({ description: "Saved Herdr SSH machine (label or profile ID) to run on. Only when the user asks. Ignored with resume; the agent ID names its machine." })),
				machine_cwd: Type.Optional(Type.String({ description: "Absolute working directory on that machine. Defaults to this session's directory." })),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const target = params.resume ? await route(params.resume) : undefined;
				const machine = target ? target.runner.machine : params.machine?.trim() || undefined;
				if (machine && params.inherit_context) throw new Error("inherit_context cannot clone this session onto another machine.");
				const current = target?.runner ?? (machine ? await machineRunner(machine) : getRunner());
				const cwd = machine ? params.machine_cwd?.trim() || ctx.cwd : ctx.cwd;
				const request: SpawnRequest = {
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
					inheritContext: params.inherit_context,
					cwd,
					definitionsCwd: ctx.cwd,
					paneId: parentKey(machine),
					// The caller's tab and workspace are local; remote agents fill grid tabs on that machine.
					tabId: machine ? undefined : deps.env.HERDR_TAB_ID,
					workspaceId: !machine ? deps.env.HERDR_WORKSPACE_ID : target ? undefined : await remoteWorkspace(machine, cwd),
					sessionFile: ctx.sessionManager.getSessionFile(),
					agentDir: deps.agentDir,
				};
				// Record the machine first: a launch that loses its channel must still be reconnected and its owner retired.
				if (machine) remember(machine);
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
				const { id, runner: current } = await route(params.agent_id);
				const result = await readHerdrAgent(deps.root, id, { wait: params.wait, verbose: params.verbose, runId: params.run_id }, { ...deps, signal, runner: current });
				return toolResult(result);
			},
		}));

		pi.registerTool(defineTool({
			name: "steer_subagent",
			label: "Steer Agent",
			description: "Send a steering message to a running Herdr subagent. Use this for follow-up work on the same thread instead of starting another agent. It is delivered after the current tool execution. Only works while that Pi pane is still running.",
			promptSnippet: "Send a steering message to redirect a running background agent",
			parameters: Type.Object({
				agent_id: Type.String({ description: "The agent ID to steer." }),
				message: Type.String({ description: "The steering message. It appears as a user message in the child." }),
			}),
			execute: async (_toolCallId, params) => {
				const { id, runner: current } = await route(params.agent_id);
				const result = await steerHerdrAgent(deps.root, id, params.message, { ...deps, runner: current });
				return toolResult(result);
			},
		}));

		pi.on("session_start", async (_event, ctx) => {
			stopped = false;
			streaming = !ctx.isIdle();
			queuedNotices.clear();
			recordedMachines.clear();
			pendingReceipts.clear();
			receiptCursor = 0;
			messenger.abort = () => { void ctx.abort(); };
			const current = getRunner();
			const entries = ctx.sessionManager.getEntries();
			let checkpoint: ChildIdentity["checkpoint"];
			for (const entry of entries) {
				if (entry.type === "custom" && entry.customType === "herdr-execution-checkpoint") checkpoint = entry.data as ChildIdentity["checkpoint"];
				const used = entry.type === "custom" && entry.customType === "herdr-remote-machine" ? (entry.data as { machine?: unknown } | undefined)?.machine : undefined;
				if (typeof used === "string") recordedMachines.add(used);
			}
			const messages = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
			assistant = messages.map(assistantText).filter(Boolean).at(-1) ?? "";
			outcome = runOutcome(messages);
			child = await createChildSession(current.store, deps.env.HERDR_PANE_ID ?? "", {
				sessionFile: ctx.sessionManager.getSessionFile() ?? "",
				sessionId: ctx.sessionManager.getSessionId(), checkpoint,
			}, messenger);
			if (timer) clearInterval(timer);
			let lastError = "";
			const health = new Map<HerdrRunner, Promise<void>>();
			// Each machine polls on its own, so a stalled SSH call never delays local coordination or other machines.
			const machinePolls = new Map<string, Promise<void>>();
			const reconnectAt = new Map<string, number>();
			const reportError = (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!stopped && message !== lastError) ctx.ui.notify(`Herdr coordination: ${message}`, "error");
				lastError = message;
			};
			const deliver = async (source: HerdrRunner) => {
				for (const notice of await source.store.notices(parentKey(source.machine))) {
					if (stopped || queuedNotices.has(notice.id)) continue;
					pi.sendMessage({
						customType: "herdr-subagent-notification", content: completionNotice(notice, source.machine), display: true,
						details: { noticeId: notice.id, agentId: qualifiedAgentId(notice.agentId, source.machine), runId: notice.runId, machine: source.machine },
					}, { deliverAs: "followUp", triggerTurn: true });
					queuedNotices.add(notice.id);
				}
			};
			const poll = async () => {
				await child?.poll();
				if (stopped) return;
				// Reopen machines this session used. A lost SSH channel is retried every ten seconds, not every tick.
				for (const machine of recordedMachines) {
					if (machines.has(machine) || (reconnectAt.get(machine) ?? 0) > deps.now()) continue;
					reconnectAt.set(machine, deps.now() + 10_000);
					machineRunner(machine).catch(reportError);
				}
				// Slow Herdr calls must not delay the child's command/cancellation polling.
				for (const source of [current, ...machineRunners.values()]) {
					if (!health.has(source)) health.set(source, source.maintain().catch(reportError).finally(() => health.delete(source)));
				}
				// A sendMessage call may only queue a message. Acknowledge only evidence actually in Pi's session.
				const saved = ctx.sessionManager.getEntries();
				for (const entry of saved.slice(receiptCursor)) {
					if (entry.type !== "custom_message" || entry.customType !== "herdr-subagent-notification") continue;
					const details = entry.details as { noticeId?: string; machine?: string } | undefined;
					if (details?.noticeId) pendingReceipts.set(details.noticeId, details.machine ?? "");
				}
				receiptCursor = saved.length;
				for (const [machine, source] of machineRunners) {
					if (machinePolls.has(machine)) continue;
					machinePolls.set(machine, pollMachine(machine, source).finally(() => machinePolls.delete(machine)));
				}
				await acknowledge("", current);
				await deliver(current);
			};
			const acknowledge = async (machine: string, source: HerdrRunner) => {
				for (const [noticeId, owner] of pendingReceipts) {
					if (owner !== machine) continue;
					await source.store.acknowledgeNotice(noticeId);
					pendingReceipts.delete(noticeId);
					queuedNotices.delete(noticeId);
				}
			};
			const pollMachine = async (machine: string, source: HerdrRunner) => {
				try {
					await acknowledge(machine, source);
					await deliver(source);
				} catch (error) {
					reportError(new Error(`${machine}: ${error instanceof Error ? error.message : String(error)}`));
					if (source.store.failed) await dropMachine(machine);
				}
			};
			timer = setInterval(() => {
				if (stopped || tick) return;
				tick = poll().catch(reportError).finally(() => { tick = undefined; });
			}, POLL_MS);
			timer.unref();
		});
		pi.on("session_shutdown", async (event) => {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = undefined;
			await tick;
			if (event?.reason !== "reload") await child?.noteExit();
			await child?.dispose();
			child = undefined;
			await runner?.close();
			runner = undefined;
			for (const machine of [...machines.keys()]) await dropMachine(machine);
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
		pi.on("tool_call", (event) => {
			if (!child || child.allows(event.toolName)) return;
			return { block: true, reason: "This subagent is not allowed to use that tool." };
		});
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
