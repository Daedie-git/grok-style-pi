import { defineTool, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createHerdrCli, type HerdrClient } from "./client.ts";
import { createChildSession, type ChildSession, type ChildIdentity } from "./child.ts";
import type { ExecutionEvent, RunRef } from "./state.ts";
import {
	completionNotice,
	readHerdrAgent,
	HerdrRunner,
	spawnHerdrAgent,
	steerHerdrAgent,
	type SpawnRequest,
	type ToolText,
} from "./runner.ts";
import { herdrSubagentRoot } from "./store.ts";

export interface HerdrSubagentDeps {
	env: NodeJS.ProcessEnv;
	root: string;
	client: HerdrClient;
	agentDir: string;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

const POLL_MS = 200;

export function createHerdrSubagents(overrides: Partial<HerdrSubagentDeps> = {}): ExtensionFactory {
	const deps: HerdrSubagentDeps = {
		env: overrides.env ?? process.env,
		root: overrides.root ?? herdrSubagentRoot(overrides.env ?? process.env),
		client: overrides.client ?? createHerdrCli(overrides.env ?? process.env),
		agentDir: overrides.agentDir ?? getAgentDir(),
		sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		now: overrides.now ?? Date.now,
	};
	return (pi: ExtensionAPI) => {
		const queuedNotices = new Set<string>();
		let runner: HerdrRunner | undefined;
		const getRunner = () => runner ??= new HerdrRunner(deps);
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
			description: "Launch a subagent as its own Pi process in a Herdr pane. Background by default. Use get_subagent_result for the outcome and steer_subagent to redirect a running agent. Reuse the same subagent for follow-up work on that thread: steer_subagent while it is running, or resume after it has finished. Start a new Agent only for new work. A blocked agent returns immediately and stays open in its pane. Results are limited to 2000 lines or 50KB; full output remains in the pane. Keep inherit_context false; the orchestrating agent must provide all needed context in the prompt. schedule and isolation are not available here.",
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
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const request: SpawnRequest = {
					prompt: params.prompt,
					description: params.description,
					name: params.name,
					subagentType: params.subagent_type,
					model: params.model,
					thinking: params.thinking,
					maxTurns: params.max_turns,
					runInBackground: params.run_in_background !== false,
					resume: params.resume,
					isolated: params.isolated,
					inheritContext: params.inherit_context,
					cwd: ctx.cwd,
					paneId: deps.env.HERDR_PANE_ID ?? "",
					tabId: deps.env.HERDR_TAB_ID,
					sessionFile: ctx.sessionManager.getSessionFile(),
					agentDir: deps.agentDir,
				};
				const result = await spawnHerdrAgent(request, { ...deps, signal, runner: getRunner() });
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
				const result = await readHerdrAgent(deps.root, params.agent_id, { wait: params.wait, verbose: params.verbose, runId: params.run_id }, { ...deps, signal, runner: getRunner() });
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
				const result = await steerHerdrAgent(deps.root, params.agent_id, params.message, { ...deps, runner: getRunner() });
				return toolResult(result);
			},
		}));

		pi.on("session_start", async (_event, ctx) => {
			stopped = false;
			streaming = !ctx.isIdle();
			queuedNotices.clear();
			receiptCursor = 0;
			messenger.abort = () => { void ctx.abort(); };
			const current = getRunner();
			const entries = ctx.sessionManager.getEntries();
			let checkpoint: ChildIdentity["checkpoint"];
			for (const entry of entries) {
				if (entry.type === "custom" && entry.customType === "herdr-execution-checkpoint") checkpoint = entry.data as ChildIdentity["checkpoint"];
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
			let health: Promise<void> | undefined;
			const reportError = (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!stopped && message !== lastError) ctx.ui.notify(`Herdr coordination: ${message}`, "error");
				lastError = message;
			};
			const poll = async () => {
				await child?.poll();
				if (stopped) return;
				// Slow Herdr calls must not delay the child's command/cancellation polling.
				health ??= current.maintain().catch(reportError).finally(() => { health = undefined; });
				// A sendMessage call may only queue a message. Acknowledge only evidence actually in Pi's session.
				const saved = ctx.sessionManager.getEntries();
				for (const entry of saved.slice(receiptCursor)) {
					if (entry.type !== "custom_message" || entry.customType !== "herdr-subagent-notification") continue;
					const noticeId = (entry.details as { noticeId?: string } | undefined)?.noticeId;
					if (noticeId) { await current.store.acknowledgeNotice(noticeId); queuedNotices.delete(noticeId); }
				}
				receiptCursor = saved.length;
				for (const notice of await current.store.notices(deps.env.HERDR_PANE_ID ?? "")) {
					if (stopped || queuedNotices.has(notice.id)) continue;
					pi.sendMessage({
						customType: "herdr-subagent-notification", content: completionNotice(notice), display: true,
						details: { noticeId: notice.id, agentId: notice.agentId, runId: notice.runId },
					}, { deliverAs: "followUp", triggerTurn: true });
					queuedNotices.add(notice.id);
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
