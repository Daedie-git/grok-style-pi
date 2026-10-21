import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { extractOutcome, MAX_RESULT_CHARS, retryableApiError, truncateResult, UsageTracker } from "../src/results.ts";
import type { ExtractInput } from "../src/results.ts";

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "A", content,
		stopReason: "stop", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...extra,
	};
}
const text = (value: string): AssistantMessage => assistant([{ type: "text", text: value }]);
const tool = (name: string): AssistantMessage["content"][number] => ({ type: "toolCall", id: name, name, arguments: {} });
function outcome(extra: Partial<ExtractInput> = {}) {
	return extractOutcome({ messages: [], maxTurnsReached: false, background: false, durationMs: 42, usage: new UsageTracker().snapshot(), ...extra });
}

// Tuple order is (input, cacheWrite, cacheRead, output), not the Usage object's field order.
function response(input: number, cacheWrite: number, cacheRead: number, output: number, model = "A") {
	return { model, usage: { input, cacheWrite, cacheRead, output } };
}

test("dossier usage fixture separates footprint, billing and live metrics", () => {
	const tracker = new UsageTracker();
	tracker.onAssistantMessage(response(10, 2, 3, 1));
	tracker.onAssistantMessage(response(20, 4, 5, 2));
	const usage = tracker.snapshot();
	assert.equal(usage.latestFootprint, 31);
	assert.equal(usage.billable.totalTokens, 47);
	assert.equal(usage.billable.output, 3);
	assert.equal(usage.liveMetric - usage.billable.output, 29);
	assert.equal(usage.liveMetric, 32);
	assert.equal(tracker.notificationTokens(), 32);
	assert.deepEqual(usage.billable, { input: 30, cacheWrite: 6, cacheRead: 8, output: 3, totalTokens: 47, cost: 0 });
});

test("model transitions collapse only adjacent duplicates", () => {
	const tracker = new UsageTracker();
	for (const model of ["A", "A", "B", "B", "A"]) tracker.onAssistantMessage(response(1, 0, 0, 1, model));
	assert.deepEqual(tracker.snapshot().modelTransitions, ["A", "B", "A"]);
});

test("replayed and missing usage do not change accounting or pending stream estimates", () => {
	const tracker = new UsageTracker();
	tracker.onAssistantMessage(response(10, 2, 3, 1));
	tracker.onStreamEstimate(7);
	const before = tracker.snapshot();
	tracker.onAssistantMessage(response(900, 800, 700, 600, "B"), { metered: false });
	tracker.onAssistantMessage({ model: "C" });
	assert.deepEqual(tracker.snapshot(), before);
	assert.equal(tracker.notificationTokens(), 23);
});

test("stream estimates replace each other and clear on a metered final response", () => {
	const tracker = new UsageTracker();
	tracker.onStreamEstimate(8);
	tracker.onStreamEstimate(3);
	assert.equal(tracker.snapshot().liveMetric, 3);
	tracker.onAssistantMessage(response(10, 0, 0, 2));
	assert.equal(tracker.snapshot().liveMetric, 12);
	tracker.onStreamEstimate(-1);
	assert.equal(tracker.snapshot().liveMetric, 12);
	tracker.onStreamEstimate(Infinity);
	assert.equal(tracker.snapshot().liveMetric, 12);
});

test("provider totals and costs are billed without replacing computed footprints", () => {
	const tracker = new UsageTracker();
	tracker.onAssistantMessage({ ...response(10, 2, 3, 1), usage: { ...response(10, 2, 3, 1).usage, totalTokens: 100, cost: { total: 0.25 } } });
	tracker.onAssistantMessage({ ...response(20, 4, 5, 2), usage: { ...response(20, 4, 5, 2).usage, totalTokens: 0, cost: { total: 0 } } });
	assert.equal(tracker.snapshot().billable.totalTokens, 100);
	assert.equal(tracker.snapshot().billable.cost, 0.25);
	assert.equal(tracker.snapshot().latestFootprint, 31);
});

test("snapshots are detached and reads never bill twice", () => {
	const tracker = new UsageTracker();
	tracker.onAssistantMessage(response(10, 2, 3, 1));
	const snapshot = tracker.snapshot();
	snapshot.billable.input = 1000;
	snapshot.modelTransitions.push("forged");
	assert.equal(tracker.snapshot().billable.input, 10);
	assert.deepEqual(tracker.snapshot().modelTransitions, ["A"]);
	assert.equal(tracker.notificationTokens(), 16);
	assert.equal(tracker.notificationTokens(), 16);
	assert.equal(tracker.snapshot().billable.totalTokens, 16);
});

test("matrix: no assistant is an empty-result failure", () => {
	const result = outcome({ messages: [{ role: "user", content: "hi" }, null, { role: "toolResult", content: [{ type: "text", text: "tool output" }] }] });
	assert.equal(result.status, "failed");
	assert.equal(result.classification, "empty-result");
	assert.equal(result.resultText, "");
	assert.ok(result.note);
});

test("matrix: assistant without text completes with tool summary", () => {
	const result = outcome({ messages: [assistant([{ type: "thinking", thinking: "private" }, tool("read")])] });
	assert.equal(result.status, "completed");
	assert.equal(result.classification, "completed");
	assert.equal(result.resultText, "");
	assert.deepEqual(result.toolStats, { toolUses: 1, byTool: { read: 1 } });
	assert.ok(result.note);
});

test("matrix: success returns last assistant text, not tool output or thinking", () => {
	const result = outcome({ messages: [text("earlier"), assistant([{ type: "text", text: "first" }, { type: "thinking", thinking: "secret" }, { type: "text", text: "second" }]), assistant([tool("read")]), { role: "toolResult", content: [{ type: "text", text: "wrong" }] }] });
	assert.equal(result.status, "completed");
	assert.equal(result.resultText, "first\nsecond");
	assert.equal(result.durationMs, 42);
});

test("matrix: turn limit completes partially, even with no assistant", () => {
	for (const messages of [[], [text("partial")]]) {
		const result = outcome({ messages, maxTurnsReached: true });
		assert.equal(result.status, "completed");
		assert.equal(result.classification, "partial-max-turns");
		assert.ok(result.note);
	}
});

test("matrix: explicit cancellation takes precedence over API error and turn limit", () => {
	for (const killedBy of ["user", "parent", "session-end", "watchdog"] as const) {
		const result = outcome({ messages: [text("prior"), assistant([{ type: "text", text: "discard" }], { stopReason: "aborted" })], aborted: { killedBy }, maxTurnsReached: true, error: { message: "server_error", retryable: true } });
		assert.equal(result.status, "killed");
		assert.equal(result.classification, "killed");
		assert.equal(result.killedBy, killedBy);
		assert.equal(result.resultText, "prior");
		assert.equal(result.foregroundRecovered, undefined);
	}
});

test("matrix: background API errors fail and retain earlier text", () => {
	const result = outcome({ messages: [text("partial")], background: true, error: { message: "rate_limit", retryable: true } });
	assert.equal(result.status, "failed");
	assert.equal(result.classification, "failed-api");
	assert.equal(result.resultText, "partial");
	assert.equal(result.foregroundRecovered, undefined);
});

for (const message of ["rate_limit", "overloaded", "server_error"]) {
	test(`matrix: foreground ${message} with prior text is recovered but remains failed`, () => {
		const result = outcome({ messages: [text("prior"), assistant([{ type: "text", text: "failed response" }], { stopReason: "error", errorMessage: message })] });
		assert.equal(result.status, "failed");
		assert.equal(result.classification, "partial-api");
		assert.equal(result.foregroundRecovered, true);
		assert.equal(result.resultText, "prior");
		assert.equal(result.error, message);
		assert.ok(result.note);
	});
}

test("matrix: foreground error without usable prior text cannot recover", () => {
	for (const messages of [[], [assistant([tool("read")])], [text("  \n")], [assistant([{ type: "text", text: "not prior" }], { stopReason: "error" })]]) {
		const result = outcome({ messages, error: { message: "server_error", retryable: true } });
		assert.equal(result.classification, "failed-api");
		assert.equal(result.status, "failed");
		assert.equal(result.foregroundRecovered, undefined);
	}
});

test("matrix: nonretryable errors never recover, even when caller labels them retryable", () => {
	for (const error of [{ message: "authentication_error", retryable: false }, { message: "network failure", retryable: true }, { message: "server_error", retryable: false }]) {
		const result = outcome({ messages: [text("prior")], error });
		assert.equal(result.classification, "failed-api");
		assert.equal(result.resultText, "prior");
		assert.equal(result.foregroundRecovered, undefined);
	}
});

test("old API errors do not override a later successful message", () => {
	const result = outcome({ messages: [assistant([], { stopReason: "error", errorMessage: "server_error" }), text("recovered normally")] });
	assert.equal(result.status, "completed");
	assert.equal(result.resultText, "recovered normally");
});

test("tool stats include every assistant call, including special object keys", () => {
	const result = outcome({ messages: [assistant([tool("read"), tool("read"), tool("write"), tool("__proto__"), tool("constructor")], { stopReason: "error" })] });
	assert.equal(result.toolStats.toolUses, 5);
	assert.deepEqual(result.toolStats.byTool, { read: 2, write: 1, ["__proto__"]: 1, constructor: 1 });
});

test("retryable API error classifier permits only the three named families", () => {
	for (const message of ["rate_limit", '{"type":"rate_limit_error"}', "OVERLOADED_ERROR: busy", "server_error: 503"]) assert.equal(retryableApiError(message), true, message);
	for (const message of [undefined, "", "authentication_error", "timeout", "429", "500", "not_server_error", "server_errors"]) assert.equal(retryableApiError(message), false, message);
});

test("result truncation bounds returned text and records a note", () => {
	const original = "x".repeat(MAX_RESULT_CHARS + 1);
	assert.deepEqual(truncateResult("abc", 3), { text: "abc", truncated: false });
	assert.deepEqual(truncateResult("abc", 2), { text: "ab", truncated: true });
	assert.deepEqual(truncateResult("abc", 0), { text: "", truncated: true });
	assert.deepEqual(truncateResult("a😀z", 2), { text: "a", truncated: true });
	assert.throws(() => truncateResult("abc", -1), RangeError);
	assert.throws(() => truncateResult("abc", NaN), RangeError);
	const result = outcome({ messages: [text(original)] });
	assert.equal(result.resultText.length, MAX_RESULT_CHARS);
	assert.match(result.note!, /truncated/);
	assert.equal(original.length, MAX_RESULT_CHARS + 1);
});
