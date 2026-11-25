import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { buildCodexHeaders, buildCompactionRequestBody, spliceCheckpointHistory } from "../packages/codex-compaction/native-compaction.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-test", name: "GPT Test", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	contextWindow: 500_000, maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const marker = "checkpoint marker";
const placeholder = { role: "user", content: [{ type: "input_text", text: marker }] };
const typedPlaceholder = { ...placeholder, type: "message" };
const checkpoint = { type: "compaction", encrypted_content: "opaque" };
const prompt = { role: "user", content: [{ type: "input_text", text: "continue" }] };

test("native trigger does not reuse a 16,000-token turn budget", () => {
	const basePayload = { max_output_tokens: 16_000 };
	const body = buildCompactionRequestBody({
		basePayload,
		model,
		input: [prompt],
		instructions: "test instructions",
		sessionId: "test-session",
	});
	assert.deepEqual(body.input, [prompt, { type: "compaction_trigger" }]);
	assert.equal(Object.hasOwn(body, "max_output_tokens"), false);
	assert.equal(basePayload.max_output_tokens, 16_000);
});

test("replays a unique standalone checkpoint marker with or without the optional message type", () => {
	const developer = { role: "developer", content: "instructions" };
	for (const item of [placeholder, typedPlaceholder]) {
		assert.deepEqual(spliceCheckpointHistory([developer, item, prompt], marker, [checkpoint]), [developer, checkpoint, prompt]);
	}
});

test("rejects missing, duplicate, and mixed-content checkpoint markers", () => {
	const mixed = { ...placeholder, content: [...placeholder.content, ...prompt.content] };
	const repeated = { ...placeholder, content: [...placeholder.content, ...placeholder.content] };
	const stringMarker = { role: "user", content: marker };
	for (const input of [[prompt], [placeholder, typedPlaceholder], [mixed], [placeholder, mixed], [repeated], [placeholder, stringMarker], [stringMarker]]) {
		assert.throws(() => spliceCheckpointHistory(input, marker, [checkpoint]), /Could not place the OpenAI Codex native compaction checkpoint/);
	}
});

test("preserves both case variants of the beta-features header and omits null headers", () => {
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url");
	const headers = buildCodexHeaders({
		apiKey: `test.${claims}.test`,
		sessionId: "test-session",
		headers: { "x-codex-beta-features": "first", "X-Codex-Beta-Features": "second", "x-omitted": null },
	});
	assert.equal(headers.get("x-codex-beta-features"), "first,second,remote_compaction_v2");
	assert.equal(headers.has("x-omitted"), false);
});
