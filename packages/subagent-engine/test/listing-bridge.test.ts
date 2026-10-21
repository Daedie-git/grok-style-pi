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
