import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdrBackendHandle, HerdrBackendNotice } from "../../herdr-subagents/src/herdr/backend.ts";
import { HerdrBackendAdapter } from "../src/backends/herdr.ts";
import type { AgentMeta, Envelope } from "../src/types.ts";

const meta: AgentMeta = {
	agentId: "a-engine", agentType: "Explore", description: "Find code", rootSessionId: "root", spawnDepth: 1,
	cwd: "/repo", sessionFile: "/state/proxy.jsonl", taskListId: "root", backend: "in-process", stopGeneration: 0, runs: [],
	definition: { agentType: "Explore", description: "Find code", prompt: "Locate paths", source: "built-in", skills: [], disallowedTools: [], diagnostics: [] },
};
const envelope: Envelope = { id: "e1", acceptanceKey: "key", from: "main", to: "a-engine", text: "Also inspect tests", createdAt: 1, state: "pending" };
function harness(liveDelivery = true) {
	const calls: unknown[] = [];
	const listeners = new Set<(notice: HerdrBackendNotice) => void>();
	const handle: HerdrBackendHandle = {
		async spawn(request) { calls.push(["spawn", request]); return { agentId: "worker@laptop", runId: "herdr-run-1", text: "Launched" }; },
		async read(id, options) { calls.push(["read", id, options]); return { status: "blocked", phase: "blocked", resultText: "", text: "Answer in pane", runId: options.runId }; },
		async resume(id, prompt) { calls.push(["resume", id, prompt]); return { runId: "herdr-run-2", text: "Resumed" }; },
		async steer(id, message, options) { calls.push(["steer", id, message, options]); return { ok: true, message: "Queued" }; },
		async cancel(id, options) { calls.push(["cancel", id, options]); return { acknowledged: false, message: "Awaiting acknowledgement" }; },
		capabilities() { return { liveDelivery, maxTurns: liveDelivery, fork: false, sharedTasks: false }; },
		onNotice(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		async acknowledge(id) { calls.push(["acknowledge", id]); },
	};
	return { adapter: new HerdrBackendAdapter(handle), calls, emit(notice: HerdrBackendNotice) { for (const listener of listeners) listener(notice); } };
}
const ctx = {} as ExtensionContext;

test("adapter creates independent proxy metadata without replacing authoritative Herdr identities", async () => {
	const h = harness();
	const request = { cwd: "/repo", prompt: "Find code", description: "Find code", subagentType: "Explore", runInBackground: true, machine: "laptop" };
	const launched = await h.adapter.spawn(request, ctx, meta);
	assert.equal(launched.meta.agentId, "a-engine");
	assert.equal(launched.meta.backend, "herdr");
	assert.deepEqual(launched.meta.herdr, { agentId: "worker@laptop", runId: "herdr-run-1", machine: "laptop" });
	assert.equal(meta.backend, "in-process");
	assert.equal(meta.herdr, undefined);
	launched.meta.definition.prompt = "Changed proxy only";
	assert.equal(meta.definition.prompt, "Locate paths");
	assert.deepEqual(h.adapter.capabilities(launched.meta), { liveDelivery: true, maxTurns: true, fork: false, sharedTasks: false, continuation: true, blockedState: true, worktree: false });
	const resumed = await h.adapter.resume(launched.meta, "Continue", ctx);
	assert.equal(resumed.meta.herdr?.runId, "herdr-run-2");
	assert.equal(launched.meta.herdr?.runId, "herdr-run-1");
	assert.equal(resumed.meta.agentId, meta.agentId);
	const status = await h.adapter.read(resumed.meta, { wait: true });
	assert.equal(status.status, "blocked");
	assert.equal(status.runId, "herdr-run-2");
	await h.adapter.read(resumed.meta, { runId: "herdr-run-1" });
	assert.deepEqual((h.calls.at(-1) as unknown[])[2], { runId: "herdr-run-1" });
});

test("capability-aware delivery queues Pi work but explicitly refuses unsupported Claude delivery", async () => {
	for (const live of [true, false]) {
		const h = harness(live);
		const proxy = h.adapter.proxy(meta, { agentId: "worker", runId: "run" });
		const delivered = await h.adapter.deliver(proxy, envelope);
		if (live) {
			assert.deepEqual(delivered, { ok: true, state: "submitted" });
			assert.deepEqual(h.calls, [["steer", "worker", envelope.text, { runId: "run" }]]);
		} else {
			assert.equal(delivered.ok, false);
			if (!delivered.ok) assert.equal(delivered.reason, "unsupported");
			assert.deepEqual(h.calls, []);
		}
	}
});

test("notice stream maps proxy identities without duplicating or prematurely acknowledging Herdr's outbox", async () => {
	const h = harness();
	h.adapter.proxy(meta, { agentId: "worker@laptop", runId: "herdr-run-1" });
	const notices: unknown[] = [];
	const stop = h.adapter.onNotice((notice) => notices.push(notice));
	h.emit({ noticeId: "notice-1", agentId: "worker@laptop", runId: "herdr-run-1", phase: "completed", content: "Original Herdr notice", machine: "laptop" });
	assert.deepEqual(notices, [{ noticeId: "notice-1", agentId: "a-engine", herdrAgentId: "worker@laptop", runId: "herdr-run-1", phase: "completed", text: "Original Herdr notice", machine: "laptop" }]);
	assert.deepEqual(h.calls, []);
	await h.adapter.acknowledge("notice-1");
	assert.deepEqual(h.calls, [["acknowledge", "notice-1"]]);
	stop();
	h.emit({ noticeId: "notice-2", agentId: "worker@laptop", runId: "herdr-run-2", phase: "completed", content: "Later notice" });
	assert.equal(notices.length, 1);
});

test("cancellation preserves an unacknowledged request and rejects non-Herdr metadata", async () => {
	const h = harness();
	const proxy = h.adapter.proxy(meta, { agentId: "worker", runId: "run" });
	assert.deepEqual(await h.adapter.cancel(proxy), { acknowledged: false, message: "Awaiting acknowledgement" });
	assert.deepEqual(h.calls, [["cancel", "worker", { runId: "run" }]]);
	assert.throws(() => h.adapter.read(meta), /Expected Herdr proxy metadata/);
});
