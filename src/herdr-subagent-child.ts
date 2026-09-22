import { HerdrStore, type AgentRecord, type Command, type HerdrTask } from "./herdr-subagent-store.ts";
import { isTerminal, type ExecutionEvent, type RunRef } from "./herdr-subagent-state.ts";

export interface ChildMessenger {
	sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void;
	abort(): void;
	assistantText(): string;
	streaming(): boolean;
	clearAssistant(): void;
	/** Persist final execution evidence in the Pi session before committing it to SQLite. */
	checkpoint?(ref: RunRef, event: ExecutionEvent): void;
}

export interface ChildIdentity {
	sessionFile: string;
	sessionId: string;
	checkpoint?: { ref: RunRef; event: ExecutionEvent };
}

export interface ChildSession {
	poll(): Promise<void>;
	input(text: string): Promise<{ action: "handled" } | { action: "transform"; text: string } | undefined>;
	noteStatus(status: "running" | "blocked"): Promise<void>;
	noteLive(): Promise<void>;
	noteSettled(outcome: "completed" | "aborted" | "error"): Promise<void>;
	noteExit(): Promise<void>;
	noteTurn(): Promise<void>;
	allows(toolName: string): boolean;
	dispose(): Promise<void>;
}

export function taskMessage(task: Pick<HerdrTask, "type" | "description" | "prompt" | "instructions">): string {
	return [
		"You are a subagent running in your own Pi pane. Finish the task below and reply with the result.",
		`Type: ${task.type}`,
		`Task: ${task.description}`,
		task.instructions?.trim(),
		task.prompt,
	].filter(Boolean).join("\n\n");
}

/** A marker lets the input hook reject an expired/cancelled command even after Pi has queued it. */
export function commandMessage(command: Command): string {
	return `<!-- herdr-command:${command.runId}:${command.id} -->\n${command.text}`;
}

/** Attach by pane AND session identity. Starting a different conversation never inherits tool restrictions. */
export async function createChildSession(store: HerdrStore, paneId: string, identity: ChildIdentity, messenger: ChildMessenger): Promise<ChildSession | undefined> {
	if (!paneId || !identity.sessionFile) return undefined;
	const binding = await store.attach(paneId, identity.sessionFile, identity.sessionId);
	if (!binding) return undefined;
	const { agent, token } = binding;
	let active: RunRef | undefined;
	let armed = false;
	let cancelling = false;
	let disposed = false;
	let queue: Promise<void> = Promise.resolve();

	function enqueue(body: () => Promise<void>): Promise<void> {
		if (disposed) return Promise.resolve();
		const result = queue.then(body);
		queue = result.catch(() => undefined);
		return result;
	}
	function capture(): RunRef | undefined { return active ? { ...active } : undefined; }
	async function event(ref: RunRef | undefined, value: ExecutionEvent) {
		if (!ref || disposed) return;
		return store.recordExecutionEvent(ref, token, value, Date.now());
	}
	async function finish(ref: RunRef, value: ExecutionEvent) {
		messenger.checkpoint?.(ref, value);
		await event(ref, value);
		if (active?.runId === ref.runId) { active = undefined; armed = false; cancelling = false; }
	}

	if (!isTerminal(binding.run.phase) && binding.run.phase !== "queued") {
		const checkpoint = identity.checkpoint;
		if (checkpoint?.ref.runId === binding.run.runId && checkpoint.ref.agentId === agent.id) {
			await event(binding.run, checkpoint.event);
		} else if (binding.run.accepted && messenger.streaming() && !binding.ambiguous) {
			active = { agentId: agent.id, runId: binding.run.runId };
			armed = true;
		} else {
			await event(binding.run, { type: "failed", error: "Execution interrupted by session reload. Dispatch outcome is uncertain; commands will not be replayed." });
			if (messenger.streaming()) messenger.abort();
		}
	}

	return {
		poll() {
			return enqueue(async () => {
				// A serial queue covers polling and lifecycle events, including reentrant sendUserMessage calls.
				for (let count = 0; count < 32 && !disposed; count++) {
					const command = await store.claimNextCommand(agent.id, token, messenger.streaming());
					if (!command || disposed) return;
					const ref = { agentId: command.agentId, runId: command.runId };
					if (command.type === "abort") {
						if (active?.runId === ref.runId) {
							cancelling = true;
							messenger.abort();
							if (!messenger.streaming()) await finish(ref, { type: "stopped", result: messenger.assistantText() || undefined, error: "Stopped" });
						}
						await store.commandDelivered(command, token);
						return;
					}
					if (command.type === "prompt") {
						active = ref;
						armed = false;
						cancelling = false;
						messenger.clearAssistant();
					}
					try {
						messenger.sendUserMessage(commandMessage(command), command.type === "steer" ? { deliverAs: "steer" } : undefined);
						await store.commandDelivered(command, token);
					} catch (error) {
						await finish(ref, { type: "failed", error: error instanceof Error ? error.message : String(error) });
						return;
					}
					if (command.type === "prompt") return;
				}
			});
		},
		async input(text) {
			const match = /^<!-- herdr-command:([a-f0-9-]+):([a-f0-9-]+) -->\n/.exec(text);
			if (!match) return undefined;
			const ref = { agentId: agent.id, runId: match[1] };
			if (disposed || !(await store.authorizeInput(ref, match[2], token))) return { action: "handled" };
			return { action: "transform", text: text.slice(match[0].length) };
		},
		noteLive() {
			const ref = capture();
			return enqueue(async () => {
				if (!ref) return;
				const value = await event(ref, { type: "live" });
				if (!value || isTerminal(value.phase) || value.cancelRequested) {
					messenger.abort();
					return;
				}
				armed = value.accepted;
			});
		},
		noteStatus(status) {
			const ref = capture();
			return enqueue(async () => { await event(ref, { type: status === "blocked" ? "blocked" : "unblocked" }); });
		},
		noteTurn() {
			const ref = capture();
			return enqueue(async () => {
				const value = await event(ref, { type: "turn", maxTurns: agent.maxTurns });
				if (value?.cancelRequested) { cancelling = true; messenger.abort(); }
			});
		},
		noteSettled(outcome) {
			const ref = capture();
			const result = messenger.assistantText() || undefined;
			return enqueue(async () => {
				if (!ref || (!armed && !cancelling)) return;
				await finish(ref, {
					type: outcome === "completed" ? "completed" : outcome === "aborted" ? "stopped" : "failed",
					result, error: outcome === "aborted" ? "Stopped" : outcome === "error" ? "The agent failed." : undefined,
				});
			});
		},
		noteExit() {
			const ref = capture();
			return enqueue(async () => {
				if (ref) await finish(ref, { type: "stopped", result: messenger.assistantText() || undefined, error: "Pane closed" });
			});
		},
		allows(toolName) { return allows(agent, toolName); },
		async dispose() {
			disposed = true;
			await queue;
		},
	};
}

function allows(agent: AgentRecord, toolName: string): boolean {
	return agent.allowedTools === undefined || agent.allowedTools.includes(toolName);
}
