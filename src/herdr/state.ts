export const START_TIMEOUT_MS = 15_000;

export interface RunRef {
	agentId: string;
	runId: string;
}

export type RunPhase = "queued" | "starting" | "running" | "blocked" | "completed" | "failed" | "stopped";

export interface RunSnapshot extends RunRef {
	phase: RunPhase;
	result?: string;
	error?: string;
	accepted: boolean;
	cancelRequested: boolean;
	deadline: number;
	turns: number;
	updatedAt: number;
}

export type ExecutionEvent =
	| { type: "live" }
	| { type: "blocked" | "unblocked" }
	| { type: "turn"; maxTurns?: number }
	| { type: "completed" | "failed" | "stopped"; result?: string; error?: string };

export function isTerminal(phase: RunPhase): boolean {
	return phase === "completed" || phase === "failed" || phase === "stopped";
}

export function expireUnaccepted(run: RunSnapshot, now: number): RunSnapshot {
	if (isTerminal(run.phase) || run.phase === "blocked" || run.accepted || !run.deadline || run.deadline > now) return run;
	return {
		...run, phase: "failed", updatedAt: now,
		error: run.cancelRequested
			? "The child did not acknowledge cancellation. The pane may still be live."
			: "Pi started, but the pane did not accept the task.",
	};
}

/** Execution transitions run inside the control database transaction. Terminal results are immutable. */
export function transition(run: RunSnapshot, event: ExecutionEvent, now: number): RunSnapshot {
	if (isTerminal(run.phase)) return run;
	const next = { ...run, updatedAt: now };
	switch (event.type) {
		case "live":
			if (run.phase !== "starting" && run.phase !== "blocked" && !run.accepted) return run;
			next.accepted = true;
			next.phase = run.phase === "blocked" ? "blocked" : "running";
			break;
		case "blocked":
		case "unblocked":
			if (!run.accepted && run.phase !== "starting" && run.phase !== "blocked") return run;
			next.phase = event.type === "blocked" ? "blocked" : run.accepted ? "running" : "starting";
			if (event.type === "unblocked" && !run.accepted) next.deadline = now + START_TIMEOUT_MS;
			break;
		case "turn":
			if (!run.accepted) return run;
			next.turns++;
			if (event.maxTurns != null && next.turns >= event.maxTurns) {
				next.cancelRequested = true;
				next.error = `Turn limit of ${event.maxTurns} reached`;
			}
			break;
		default:
			if (event.type === "completed" && !run.accepted) return run;
			next.phase = run.cancelRequested ? "stopped" : event.type;
			next.result = event.result;
			next.error = run.cancelRequested ? run.error ?? "Stopped" : event.error;
	}
	return next;
}
