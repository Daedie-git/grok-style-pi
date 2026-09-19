import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { AgentManager } from "@tintinweb/pi-subagents/dist/agent-manager.js";
import type { AgentRecord as NativeRecord } from "@tintinweb/pi-subagents/dist/types.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getModel, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { SubagentAdapter } from "../src/subagent-adapter.ts";
import type { Activity } from "../src/activity-ui.ts";

// Real manager, resume runner, AgentSession, agent loop and cancellation.
// Only model transport is replaced, so tests need no credentials or network.
async function fixture(t: TestContext) {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden in contract tests"); });
	const dir = mkdtempSync(join(tmpdir(), "grok-contract-"));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager: settings, sessionManager: SessionManager.inMemory(dir), resourceLoader: loader, tools: [] });
	let mode: "success" | "failure" | "wait" = "success";
	let entered = () => {};
	let aborted = false;
	session.agent.streamFunction = (model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		const finish = (reason: "stop" | "error" | "aborted") => {
			const message: AssistantMessage = { role: "assistant", content: reason === "stop" ? [{ type: "text", text: "fresh result" }] : [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now(),
				...(reason === "error" ? { errorMessage: "429 Too Many Requests" } : {}) };
			if (reason === "stop") stream.push({ type: "done", reason, message });
			else stream.push({ type: "error", reason, error: message });
			stream.end();
		};
		queueMicrotask(() => {
			if (mode === "wait") {
				const abort = () => { aborted = true; finish("aborted"); };
				if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
			} else finish(mode === "success" ? "stop" : "error");
			entered();
		});
		return stream;
	};
	let lifecycleEvents = 0;
	const manager = new AgentManager(() => lifecycleEvents++, 5, () => lifecycleEvents++);
	// Seed an existing session: spawn setup is outside this resume contract.
	// This is the only private test seam; all exercised operations are the real public methods.
	const record = { id: "contract", type: "Explore", description: "contract", status: "completed", startedAt: 1, completedAt: 2,
		result: "old result", session, abortController: new AbortController(), toolUses: 0, compactionCount: 0,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } } as NativeRecord;
	(manager as unknown as { agents: Map<string, NativeRecord> }).agents.set(record.id, record);
	const emitter = new EventEmitter();
	const bus = { on(name: string, fn: (data: unknown) => void) { emitter.on(name, fn); return () => { emitter.off(name, fn); }; }, emit(name: string, data: unknown) { emitter.emit(name, data); } } as ExtensionAPI["events"];
	let activity: Activity;
	const adapter = new SubagentAdapter(bus, (id) => manager.getRecord(id), (entry) => { activity = entry; });
	bus.emit("subagents:completed", { id: record.id });
	t.after(async () => { adapter.dispose(); await session.abort(); await manager.dispose(); rmSync(dir, { recursive: true, force: true }); });
	let clock = Date.now();
	t.mock.method(Date, "now", () => ++clock);
	return { manager, adapter, record, session, activity: () => activity!, aborted: () => aborted, lifecycleEvents: () => lifecycleEvents,
		setMode(value: typeof mode) { mode = value; }, entered() { return new Promise<void>((resolve) => { entered = resolve; }); } };
}

test("contract: real foreground resumes succeed and fail between polls without lifecycle events", async (t) => {
	const h = await fixture(t);
	const first = h.adapter.identity("contract");
	await h.manager.resume("contract", "succeed");
	h.adapter.poll();
	assert.equal(h.activity().status, "completed", h.record.error);
	assert.match(h.activity().output, /fresh result/);
	assert.notEqual(h.adapter.identity("contract"), first);
	const second = h.adapter.identity("contract");
	h.setMode("failure");
	await h.manager.resume("contract", "fail immediately");
	h.adapter.poll();
	assert.equal(h.activity().status, "error");
	assert.match(h.activity().output, /429 Too Many Requests/);
	assert.notEqual(h.adapter.identity("contract"), second);
	assert.equal(h.lifecycleEvents(), 0);
});

test("contract: Stop aborts a real foreground resumed session and preserves its parent signal", { timeout: 10000 }, async (t) => {
	const h = await fixture(t);
	h.setMode("wait");
	const entered = h.entered();
	const parent = new AbortController();
	const pending = h.manager.resume("contract", "wait until stopped", parent.signal);
	await entered;
	h.adapter.poll();
	assert.equal(h.activity().status, "running");
	await h.activity().stop!();
	await pending;
	h.adapter.poll();
	assert.equal(h.aborted(), true);
	assert.equal(h.session.isStreaming, false);
	assert.equal(parent.signal.aborted, false);
	assert.equal(h.activity().status, "stopped");
	assert.equal(h.record.abortController!.signal.aborted, false, "old controller was not used");
});

test("contract: a Stop closure from an earlier run cannot cancel the next real resume", { timeout: 10000 }, async (t) => {
	const h = await fixture(t);
	h.setMode("wait");
	let entered = h.entered();
	let pending = h.manager.resume("contract", "first");
	await entered; h.adapter.poll();
	const oldStop = h.activity().stop!;
	await oldStop(); await pending; h.adapter.poll();
	entered = h.entered(); pending = h.manager.resume("contract", "second");
	await entered; h.adapter.poll();
	await assert.rejects(async () => { await oldStop(); }, /run has ended/);
	assert.equal(h.session.isStreaming, true);
	await h.activity().stop!(); await pending;
});

test("contract: same-millisecond completed resumes still get distinct identities", async (t) => {
	const h = await fixture(t);
	t.mock.method(Date, "now", () => 1000);
	await h.manager.resume("contract", "first"); h.adapter.poll();
	const first = h.adapter.identity("contract");
	await h.manager.resume("contract", "second"); h.adapter.poll();
	assert.notEqual(h.adapter.identity("contract"), first);
	assert.equal(h.activity().status, "completed");
});

test("contract: disposing the adapter makes an outstanding Stop closure inert", async (t) => {
	const h = await fixture(t);
	h.setMode("wait");
	const entered = h.entered();
	const pending = h.manager.resume("contract", "keep running");
	await entered; h.adapter.poll();
	const stop = h.activity().stop!;
	h.adapter.dispose();
	await assert.rejects(async () => { await stop(); }, /run has ended/);
	assert.equal(h.session.isStreaming, true);
	await h.session.abort(); await pending;
});

test("contract: steered completion leaves active state and removes Stop", async (t) => {
	const h = await fixture(t);
	h.setMode("wait");
	const entered = h.entered();
	const pending = h.manager.resume("contract", "steered run");
	await entered; h.adapter.poll();
	assert.equal(h.activity().status, "running");
	await h.session.abort(); await pending;
	// The manager assigns this terminal status when a spawned run settles after steering.
	h.record.status = "steered";
	h.adapter.poll();
	assert.equal(h.activity().status, "completed");
	assert.equal(h.activity().stop, undefined);
	assert.equal(h.activity().transcript, undefined);
});

test("contract: completion snapshots are bounded, cached and release child-session references", async (t) => {
	const h = await fixture(t);
	await h.manager.resume("contract", "snapshot");
	const message = h.session.state.messages.at(-1)!;
	let contentReads = 0;
	Object.defineProperty(message, "content", { configurable: true, get() { contentReads++; return [{ type: "text", text: "x".repeat(80000) }]; } });
	h.record.result = "r".repeat(90000);
	h.adapter.poll();
	assert.equal(h.activity().output.length, 64000);
	const initialReads = contentReads;
	for (let i = 0; i < 10; i++) assert.equal(h.adapter.poll(), false);
	assert.equal(contentReads, initialReads, "unchanged completions are not rendered again");
	// Inspect ownership, not GC timing: completed state must not own the child session.
	const stored = (h.adapter as unknown as { runs: Map<string, { session?: unknown; result?: string; lastUser?: WeakRef<object> }> }).runs.get("contract")!;
	assert.equal(stored.session, undefined);
	assert.ok((stored.result?.length ?? 0) <= 64000);
	assert.ok(stored.lastUser instanceof WeakRef);
	await h.manager.dispose();
	h.adapter.poll();
	assert.equal(stored.session, undefined);
	assert.equal(h.activity().output.length, 64000, "registry eviction preserves only the completion snapshot");
});
