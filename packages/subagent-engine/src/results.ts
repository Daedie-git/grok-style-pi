import type { KilledBy, RunOutcome, ToolStats, UsageAccounting, UsageTotals } from "./types.ts";

export const MAX_RESULT_CHARS = 100_000;

type AssistantUsageMessage = {
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
		cost?: { total: number };
	};
	model?: string;
	stopReason?: string;
};

/** One tracker per run; replayed history must be passed with metered:false. */
export class UsageTracker {
	private billable: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	private latestFootprint = 0;
	private latestInput = 0;
	private outstanding = 0;
	private models: string[] = [];

	onAssistantMessage(message: AssistantUsageMessage, options?: { metered?: boolean }): void {
		if (options?.metered === false || !message.usage) return;
		const usage = message.usage;
		this.latestInput = usage.input + usage.cacheWrite + usage.cacheRead;
		this.latestFootprint = this.latestInput + usage.output;
		this.billable.input += usage.input;
		this.billable.output += usage.output;
		this.billable.cacheRead += usage.cacheRead;
		this.billable.cacheWrite += usage.cacheWrite;
		this.billable.totalTokens += usage.totalTokens ?? this.latestFootprint;
		this.billable.cost += usage.cost?.total ?? 0;
		// A final response replaces the estimate for that response, not adds to it.
		this.outstanding = 0;
		if (message.model && this.models.at(-1) !== message.model) this.models.push(message.model);
	}

	onStreamEstimate(outstandingTokens: number): void {
		this.outstanding = Number.isFinite(outstandingTokens) ? Math.max(0, outstandingTokens) : 0;
	}

	snapshot(): UsageAccounting {
		return {
			billable: { ...this.billable },
			latestFootprint: this.latestFootprint,
			liveMetric: this.latestInput + this.billable.output + this.outstanding,
			modelTransitions: [...this.models],
		};
	}

	notificationTokens(): number {
		const usage = this.snapshot();
		return Math.max(usage.liveMetric, usage.latestFootprint);
	}
}

export interface ExtractInput {
	messages: unknown[];
	maxTurnsReached: boolean;
	aborted?: { killedBy: KilledBy };
	background: boolean;
	error?: { message: string; retryable: boolean };
	durationMs: number;
	usage: UsageAccounting;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function retryableApiError(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && /\b(?:rate_limit(?:_error)?|overloaded(?:_error)?|server_error)\b/i.test(errorMessage);
}

export function truncateResult(text: string, max = MAX_RESULT_CHARS): { text: string; truncated: boolean } {
	if (!Number.isSafeInteger(max) || max < 0) throw new RangeError("Result limit must be a nonnegative safe integer");
	if (text.length <= max) return { text, truncated: false };
	// Do not split a UTF-16 surrogate pair at the boundary.
	let end = max;
	if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
	return { text: text.slice(0, end), truncated: true };
}

export function extractOutcome(input: ExtractInput): RunOutcome & { foregroundRecovered?: boolean } {
	const assistants = input.messages.filter((message): message is Record<string, unknown> => record(message) && message.role === "assistant");
	const toolStats: ToolStats = { toolUses: 0, byTool: {} };
	let text = "";
	for (const message of assistants) {
		if (!Array.isArray(message.content)) continue;
		const parts: string[] = [];
		for (const block of message.content) {
			if (!record(block)) continue;
			if (block.type === "toolCall" && typeof block.name === "string") {
				toolStats.toolUses++;
				// defineProperty also handles names such as __proto__ as plain keys.
				const count = Object.hasOwn(toolStats.byTool, block.name) ? toolStats.byTool[block.name] : 0;
				Object.defineProperty(toolStats.byTool, block.name, { value: count + 1, enumerable: true, configurable: true, writable: true });
			}
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		const candidate = parts.join("\n");
		if (message.stopReason !== "error" && message.stopReason !== "aborted" && candidate.length > 0) text = candidate;
	}
	const clipped = truncateResult(text);
	const base = { resultText: clipped.text, usage: input.usage, toolStats, durationMs: input.durationMs };
	const truncationNote = clipped.truncated ? "Result truncated; the full text remains in the transcript." : undefined;
	const note = (detail: string): string => truncationNote ? `${detail} ${truncationNote}` : detail;
	const last = assistants.at(-1);
	if (input.aborted || last?.stopReason === "aborted") {
		return { ...base, status: "killed", classification: "killed", ...(input.aborted ? { killedBy: input.aborted.killedBy } : {}), note: note("Run cancelled.") };
	}
	const error = input.error ?? (last?.stopReason === "error" ? {
		message: typeof last.errorMessage === "string" ? last.errorMessage : "Assistant API request failed.",
		retryable: retryableApiError(typeof last.errorMessage === "string" ? last.errorMessage : undefined),
	} : undefined);
	if (error) {
		const recovered = !input.background && error.retryable && retryableApiError(error.message) && text.trim().length > 0;
		return {
			...base, status: "failed", classification: recovered ? "partial-api" : "failed-api", error: error.message,
			note: note(recovered ? "API request failed; returning the earlier partial response." : "API request failed."),
			...(recovered ? { foregroundRecovered: true } : {}),
		};
	}
	if (input.maxTurnsReached) return { ...base, status: "completed", classification: "partial-max-turns", note: note("Turn limit reached; the result may be incomplete.") };
	if (assistants.length === 0) return { ...base, status: "failed", classification: "empty-result", note: note("No assistant message was produced.") };
	return {
		...base, status: "completed", classification: "completed",
		...(text.length === 0 ? { note: note("Assistant produced no text; see tool statistics.") } : truncationNote ? { note: truncationNote } : {}),
	};
}
