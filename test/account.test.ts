import assert from "node:assert/strict";
import test from "node:test";
import { accountFromToken, startAccountPolling } from "../src/extension/account.ts";

const token = (claims: unknown) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("account prefers email, then name, then provider account identity", () => {
	assert.equal(accountFromToken(token({ "https://api.openai.com/profile": { email: "person@example.com" }, "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } }), "openai-codex"), "person@example.com");
	assert.equal(accountFromToken(token({ email: "grok@example.com", sub: "user-123" }), "xai"), "grok@example.com");
	assert.equal(accountFromToken(token({ name: "Person", sub: "user-123" }), "xai"), "Person");
	assert.equal(accountFromToken(token({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } }), "openai-codex"), "account-123");
	assert.equal(accountFromToken(token({ sub: "user-123" }), "xai"), "user-123");
});

test("account ignores keys, malformed claims, and unrelated providers", () => {
	for (const value of [undefined, "secret-api-key", "a.invalid.b", token(null), token({ email: 42 })]) {
		assert.equal(accountFromToken(value, "openai-codex"), undefined);
	}
	assert.equal(accountFromToken(token({ email: "person@example.com" }), "other"), undefined);
	assert.equal(accountFromToken(token({ email: "\n\x1bperson\x07@example.com│" }), "xai"), "person@example.com");
});

test("account polling refreshes login changes and clears failed lookups", async () => {
	let current: string | undefined = token({ email: "first@example.com" });
	let fail = false;
	const updates: (string | undefined)[] = [];
	const poll = startAccountPolling("xai", async () => { if (fail) throw new Error("failed"); return current; }, (value) => updates.push(value));
	try {
		await tick();
		current = token({ email: "second@example.com" });
		await poll.refresh();
		current = undefined;
		await poll.refresh();
		fail = true;
		await poll.refresh();
		assert.deepEqual(updates, ["first@example.com", "second@example.com", undefined, undefined]);
	} finally { poll.dispose(); }
});

test("disposed account polling ignores an in-flight old login", async () => {
	let resolve!: (value: string) => void;
	const updates: (string | undefined)[] = [];
	const poll = startAccountPolling("xai", () => new Promise<string>((done) => { resolve = done; }), (value) => updates.push(value));
	poll.dispose();
	resolve(token({ email: "old@example.com" }));
	await tick();
	await poll.refresh();
	assert.deepEqual(updates, []);
});
