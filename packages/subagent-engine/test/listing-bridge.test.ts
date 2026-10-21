import assert from "node:assert/strict";
import test from "node:test";
import { installListingBridge, LISTING_TYPE } from "../src/listing.ts";

type Message = { role: string; customType?: string; content?: unknown };

function bridge() {
	let handler!: (event: { messages: Message[] }, ctx: unknown) => Promise<{ messages: Message[] } | undefined>;
	const sent: unknown[] = [];
	const pi = {
		on(name: string, fn: typeof handler) { if (name === "context") handler = fn; },
		sendMessage(message: unknown) { sent.push(message); },
	};
	installListingBridge(pi as never, () => [{ agentType: "Explore", description: "Locate code." }]);
	// No committed listing in the branch, as after compaction removed it.
	const ctx = { sessionManager: { getBranch: () => [] } };
	return { run: (messages: Message[]) => handler({ messages }, ctx), sent };
}

test("a pending listing goes before the input that started the turn, never after it", async () => {
	const { run } = bridge();
	const result = await run([
		{ role: "user", content: "earlier" },
		{ role: "assistant", content: [] },
		{ role: "custom", customType: "sidecar-control", content: "Do the review." },
	]);
	const roles = result!.messages.map((message) => message.customType ?? message.role);
	assert.deepEqual(roles, ["user", "assistant", LISTING_TYPE, "sidecar-control"]);
});

test("during a tool loop the listing still precedes the turn's prompt", async () => {
	const { run } = bridge();
	const result = await run([
		{ role: "user", content: "Investigate." },
		{ role: "assistant", content: [] },
		{ role: "toolResult", content: [] },
	]);
	const roles = result!.messages.map((message) => message.customType ?? message.role);
	assert.deepEqual(roles, [LISTING_TYPE, "user", "assistant", "toolResult"]);
});

test("a delta keeps its place after the same turn's committed listing, both ahead of the prompt", async () => {
	let handler!: (event: { messages: Message[] }, ctx: unknown) => Promise<{ messages: Message[] } | undefined>;
	const pi = { on(name: string, fn: typeof handler) { if (name === "context") handler = fn; }, sendMessage() {} };
	installListingBridge(pi as never, () => []);
	// The initial listing (offering auditor) was committed during this tool turn; auditor has since been removed.
	const committed = { type: "custom_message", customType: LISTING_TYPE, details: { listingId: "listing-1", offered: [{ agentType: "auditor", description: "Audit." }] } };
	const ctx = { sessionManager: { getBranch: () => [committed] } };
	const result = await handler({ messages: [
		{ role: "user", content: "Investigate." },
		{ role: "assistant", content: [] },
		{ role: "toolResult", content: [] },
		{ role: "custom", customType: LISTING_TYPE, content: "Available agent types: auditor" },
	] }, ctx);
	const sequence = result!.messages.map((message) => message.role === "custom" ? String(message.content) : message.role);
	assert.equal(sequence[0], "Available agent types: auditor");
	assert.match(sequence[1], /auditor/);
	assert.notEqual(sequence[1], sequence[0], "the removal delta follows the listing it supersedes");
	assert.deepEqual(sequence.slice(2), ["user", "assistant", "toolResult"]);
});
