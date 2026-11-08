import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SubagentAdapter } from "../src/subagents/adapter.ts";
import { WorkflowActivities } from "../src/subagents/workflow-activity.ts";
import type { Activity } from "../src/activity/ui.ts";
import { ActivityPanel, ActivityViewer } from "../src/activity/ui.ts";
import { registerStyledSubagents } from "../src/subagents/result-style.ts";
import { wrapWithDiamondRenderer } from "../src/tools/renderer.ts";
import { createHerdrNotificationRenderer } from "../src/subagents/notification-style.ts";
import { createGrokSubagents } from "../integrations/subagents.ts";
import { defaultFeatures } from "../src/extension/features.ts";
import type { Engine } from "../packages/subagent-engine/src/engine.ts";
import type { WorkflowProgress } from "../packages/subagent-engine/src/workflow/host.ts";
import { scripted, until } from "../packages/subagent-engine/test/fixtures/harness.ts";
import { assertDiamondGestures } from "./fixtures/diamond-gestures.ts";
import { FakeEngine, agentSnapshot, meta, outcome } from "./fixtures/engine-activity.ts";

const theme = { fg: (_token: string, text: string) => text };
const receipt = { status: "async_launched", taskId: "task-1", taskType: "local_workflow", workflowName: "Review", runId: "run-1", summary: "Inspect changes", transcriptDir: "/transcripts", scriptPath: "/scripts/review.js" };
class WorkflowEngine extends FakeEngine {
	readonly workflowStops: string[] = [];
	stopAccepted = true;
	userStopWorkflow(taskId: string) { this.workflowStops.push(taskId); return this.stopAccepted; }
	progress(event: WorkflowProgress, taskId = "task-1", runId = "run-1") { this.emit({ type: "workflow-progress", taskId, runId, event }); }
}
function fixture() {
	const engine = new WorkflowEngine();
	const entries = new Map<string, Activity>();
	const adapter = new SubagentAdapter(engine, (entry) => { entries.set(entry.id, entry); });
	return { engine, adapter, entries, entry: () => entries.get("workflow:task-1")! };
}

test("one workflow entry groups phases and counts done/cached/failed slots exactly once", (t) => {
	const h = fixture(); t.after(() => h.adapter.dispose());
	h.adapter.workflowReceipt(receipt);
	h.engine.progress({ type: "phase", index: 2, title: "Verify" });
	h.engine.progress({ type: "phase", index: 1, title: "Inspect" });
	const states = ["done", "done", "done", "cached", "cached", "failed", "start", "queued"] as const;
	for (const [index, state] of states.entries()) h.engine.progress({ type: "agent", logicalIndex: index + 1, label: `worker ${index + 1}`, phase: index < 4 ? "Inspect" : "Verify", state, agentId: `agent-${index + 1}` });
	h.engine.progress({ type: "agent", logicalIndex: 1, label: "worker 1", phase: "Inspect", state: "done", agentId: "agent-1" });
	h.engine.progress({ type: "log", message: "Verification log tail" });
	assert.equal(h.entries.size, 1);
	assert.equal(h.entry().title, "◆ Workflow · Review");
	assert.equal(h.entry().detail, "3/8 done · 2 cached · 1 failed");
	const output = h.entry().transcript!();
	assert.ok(output.indexOf("Phase 1 · Inspect") < output.indexOf("Phase 2 · Verify"));
	assert.match(output, /worker 7 · running · agent-7/);
	assert.match(output, /worker 8 · queued · agent-8/);
	assert.match(output, /worker 4 · cached · agent-4/);
	assert.match(output, /worker 6 · failed · agent-6/);
	assert.match(output, /Log tail\nVerification log tail/);
	const panel = new ActivityPanel(() => [...h.entries.values()], theme, () => {}, () => {}, () => {}, () => {});
	assert.match(panel.render(140).join("\n"), /Active workflows · 1/);
	assert.match(panel.render(140).join("\n"), /◆ Workflow · Review/);
	for (const width of [1, 10, 40, 100]) assert.ok(panel.render(width).every((row) => visibleWidth(row) <= width));
});

test("workflow child agents are nested, with attributed transcripts and run-fenced events", (t) => {
	const h = fixture(); t.after(() => h.adapter.dispose());
	const child = meta("child-1", "child-run");
	child.workflow = { taskId: "task-1", runId: "run-1", logicalIndex: 1, label: "Research", phase: "Inspect" };
	h.engine.emit({ type: "spawned", agentId: child.agentId, runId: "child-run", meta: child });
	h.adapter.workflowReceipt(receipt);
	h.engine.emit({ type: "run-event", agentId: child.agentId, runId: "child-run", event: { type: "text", delta: "Located the implementation" } });
	h.engine.emit({ type: "run-event", agentId: child.agentId, runId: "stale-run", event: { type: "text", delta: "STALE" } });
	h.engine.emit({ type: "run-event", agentId: child.agentId, runId: "child-run", event: { type: "tool", toolCallId: "read-1", toolName: "read", phase: "start" } });
	h.engine.emit({ type: "settled", agentId: child.agentId, runId: "child-run", outcome: outcome("completed", "Final child report") });
	assert.deepEqual([...h.entries.keys()], ["workflow:task-1"]);
	assert.match(h.entry().output, /Research · done · child-1/);
	assert.match(h.entry().output, /\[child-1\] Located the implementation/);
	assert.match(h.entry().output, /read · start/);
	assert.match(h.entry().output, /Final child report/);
	assert.doesNotMatch(h.entry().output, /STALE/);
	h.engine.spawn("ordinary", "normal-run");
	assert.equal(h.entries.has("agent:ordinary"), true, "unrelated agents remain top-level");
});

test("workflow Stop routes to userStopWorkflow and stale callbacks never stop other tasks", async (t) => {
	const h = fixture(); t.after(() => h.adapter.dispose()); h.adapter.workflowReceipt(receipt);
	const stop = h.entry().stop!;
	await stop(); await stop();
	assert.deepEqual(h.engine.workflowStops, ["task-1"]);
	assert.deepEqual(h.engine.stops, []);
	assert.equal(h.entry().status, "stopping");
	h.engine.emit({ type: "workflow-settled", taskId: "task-1", runId: "run-1", status: "killed" });
	assert.equal(h.entry().status, "stopped");
	assert.equal(h.entry().stop, undefined);
	await assert.rejects(async () => { await stop(); }, /workflow has ended/);
	h.adapter.workflowReceipt({ ...receipt, taskId: "task-2" });
	await assert.rejects(async () => { await stop(); }, /workflow has ended/);
	assert.deepEqual(h.engine.workflowStops, ["task-1"]);
});

test("failed stop restores controls, terminal receipts never revive tasks, and output is bounded", async (t) => {
	const h = fixture(); t.after(() => h.adapter.dispose()); h.adapter.workflowReceipt(receipt);
	h.engine.stopAccepted = false;
	await assert.rejects(async () => { await h.entry().stop!(); }, /no longer running/);
	assert.equal(h.entry().status, "running");
	h.engine.progress({ type: "log", message: "old log\n" + "x".repeat(80000) + "RECENT LOG" });
	h.engine.progress({ type: "agent", logicalIndex: 1, label: "unsafe\x1b]52;c;payload\x07\nlabel", state: "failed" });
	assert.match(h.entry().output, /RECENT LOG/); assert.doesNotMatch(h.entry().output, /old log|payload|\x1b/);
	assert.ok(h.entry().output.length < 64000);
	h.engine.emit({ type: "workflow-settled", taskId: "task-1", runId: "run-1", status: "failed" });
	h.adapter.workflowReceipt({ ...receipt, workflowName: "Correct name" });
	h.engine.progress({ type: "agent", logicalIndex: 2, state: "start" });
	assert.equal(h.entry().status, "failed"); assert.equal(h.entry().stop, undefined);
	assert.equal(h.entry().title, "◆ Workflow · Correct name");
	assert.equal(h.entry().detail, "0/1 done · 0 cached · 1 failed");
	h.adapter.workflowReceipt({ workflowName: "error", error: "not launched" });
	assert.equal(h.entries.size, 1);
});

test("fast completion before a receipt is not revived and dismissed tasks ignore late events", (t) => {
	const h = fixture(); t.after(() => h.adapter.dispose());
	h.engine.emit({ type: "workflow-settled", taskId: "task-1", runId: "run-1", status: "completed" });
	h.adapter.workflowReceipt(receipt);
	assert.equal(h.entry().title, "◆ Workflow · Review");
	assert.equal(h.entry().status, "completed"); assert.equal(h.entry().stop, undefined);
	h.adapter.forget("workflow:task-1"); h.entries.delete("workflow:task-1");
	h.engine.progress({ type: "log", message: "late log" }); h.adapter.workflowReceipt(receipt);
	const child = meta("late-child", "late-run");
	child.workflow = { taskId: "task-1", runId: "run-1", logicalIndex: 1 };
	h.engine.emit({ type: "spawned", agentId: child.agentId, runId: "late-run", meta: child });
	assert.equal(h.entries.size, 0);
	h.adapter.workflowReceipt({ ...receipt, taskId: "new-task" });
	assert.equal(h.entries.size, 1, "a resumed invocation with the same runId but a new taskId remains distinct");
});

test("active workflow child snapshots restore a nested workflow, not a top-level child", (t) => {
	const child = meta("restored", "child-run");
	child.workflow = { taskId: "task-1", runId: "run-1", logicalIndex: 2, label: "Restored child", phase: "Inspect" };
	const engine = new WorkflowEngine();
	engine.snapshots = [{ ...agentSnapshot(child.agentId, "child-run"), workflow: child.workflow }];
	const entries: Activity[] = [];
	const adapter = new SubagentAdapter(engine, (entry) => { if (!entries.includes(entry)) entries.push(entry); });
	t.after(() => adapter.dispose());
	adapter.workflowReceipt(receipt);
	assert.equal(entries.length, 1); assert.equal(entries[0].kind, "workflow");
	assert.match(entries[0].output, /Restored child · running · restored/);
});

test("Workflow and RunWorkflow diamonds show receipt metadata and shared file-target gestures", async () => {
	for (const name of ["Workflow", "RunWorkflow"]) {
		let styled: any;
		const opened: unknown[] = [];
		const result = { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: receipt };
		const original = { name, description: "workflow policy", promptSnippet: "original guidance", parameters: {}, execute: async () => result };
		await registerStyledSubagents({ registerTool(tool: unknown) { styled = tool; } } as ExtensionAPI, (pi) => { pi.registerTool(original as never); }, true,
			(tool) => wrapWithDiamondRenderer(tool, { onModifierOpen: (target) => { opened.push(target); } }));
		assert.equal(styled.execute, original.execute); assert.equal(styled.description, original.description); assert.equal(styled.promptSnippet, original.promptSnippet);
		const args = { name: "fallback" }; const context = { args, state: {}, cwd: "/cwd", invalidate() {} };
		const header = styled.renderCall(args, theme, context);
		assert.deepEqual(styled.renderResult(result, { expanded: false }, theme, context).render(120), []);
		assert.deepEqual(header.render(120), ["◆ Workflow · Review · run-1"]);
		const body = styled.renderResult(result, { expanded: true }, theme, context);
		const output = body.render(160).join("\n");
		assert.match(output, /Script: \/scripts\/review.js/); assert.match(output, /Task: task-1/); assert.match(output, /Transcripts: \/transcripts/); assert.match(output, /Resume:.*resumeFromRunId: run-1/);
		assertDiamondGestures(name, { header: header.handleMouse, body: body.handleMouse, isOpen: () => styled.renderResult(result, { expanded: true }, theme, context).render(80).length > 0, opened: () => opened });
		assert.deepEqual((opened[0] as { path: string }).path, "/scripts/review.js");
		const errorContext = { args: { name: "bad" }, state: {}, isError: true, invalidate() {} };
		const failed = { content: [{ type: "text", text: "Script rejected" }], details: { error: "Script rejected" } };
		const failedHeader = styled.renderCall(errorContext.args, theme, errorContext);
		styled.renderResult(failed, { expanded: false }, theme, errorContext);
		assert.deepEqual(failedHeader.render(120), ["◆ Workflow · bad · not launched"]);
		assert.match(styled.renderResult(failed, { expanded: true }, theme, errorContext).render(80).join("\n"), /Script rejected/);
	}
});

test("workflow completion notices keep their first-line title and expand without lost detail", () => {
	for (const state of ["completed", "failed", "stopped"]) {
		const renderer = createHerdrNotificationRenderer();
		const message = { content: `Workflow ${state}: Review\n\nTask task-1\n3 agents\nDetailed result` } as any;
		const closed = renderer(message, { expanded: false } as any, theme as any)!;
		assert.deepEqual(closed.render(100), [`◆ Workflow ${state}: Review`]);
		const opened = renderer(message, { expanded: true } as any, theme as any)!;
		assert.match(opened.render(100).join("\n"), /Detailed result/);
	}
});

test("real Grok Workflow tool events populate one panel entry and its viewer; Stop cancels the workflow", { timeout: 15000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
	mkdirSync(resolve("captures"), { recursive: true });
	const root = mkdtempSync(join(resolve("captures"), "workflow-view-"));
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "offline-test");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let engine!: Engine; let panel!: ActivityPanel; let viewer: ActivityViewer | undefined; let closeViewer: (() => void) | undefined;
	let children = 0; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
	const script = "export const meta={name:'Visual workflow',description:'Visual fixture',phases:[{title:'Inspect'}]}; phase('Inspect'); log('Beginning review'); return await parallel([()=>agent('first',{label:'First'}),()=>agent('second',{label:'Second'})]);";
	const features = { ...Object.fromEntries(Object.keys(defaultFeatures).map((key) => [key, false])), activity: true, toolStyling: true } as typeof defaultFeatures;
	const oldSteer = process.env.GROK_STEER_DIR; process.env.GROK_STEER_DIR = join(root, "steer");
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [createGrokSubagents({ env: {}, style: { features }, engine: { env: { PI_WORKFLOW_APPROVE: "1" }, agentDir: join(root, "agent"), homeDir: root, modelRuntime: async () => runtime,
			onEngine(created) { engine = created; }, onSessionCreated(child) { children++; child.agent.streamFunction = scripted(() => ({ wait: held, then: { text: "Done" } }), () => {}) as never; },
		} })] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime: runtime, model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader: loader });
	const errors: unknown[] = [];
	const tui = { terminal: { rows: 100 }, requestRender() {} };
	const ui = { theme, setWidget(_key: string, factory: any) { if (factory) panel = factory(tui, theme); }, setStatus() {}, notify() {},
		select: async (_title: string, labels: string[]) => labels[0],
		custom(factory: any) { return new Promise<void>((resolve) => { closeViewer = resolve; viewer = factory(tui, theme, {}, resolve); }); } };
	session.agent.streamFunction = scripted(({ index }) => index === 0 ? { tools: [{ name: "Workflow", args: { script } }] } : { text: "Parent continues" }, () => {}) as never;
	t.after(async () => { closeViewer?.(); release(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); if (oldSteer === undefined) delete process.env.GROK_STEER_DIR; else process.env.GROK_STEER_DIR = oldSteer; rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
	await session.bindExtensions({ mode: "tui", uiContext: ui as never, onError(error) { errors.push(error); } });
	await session.prompt("Explicitly run this workflow");
	await until(() => children === 2);
	const rows = panel.render(180).join("\n");
	assert.match(rows, /Active workflows · 1/); assert.match(rows, /◆ Workflow · Visual workflow/); assert.doesNotMatch(rows, /Active subagents/);
	const viewing = session.prompt("/activity"); await until(() => viewer !== undefined);
	const output = viewer!.render(160).join("\n");
	assert.match(output, /Phase 1 · Inspect/); assert.match(output, /First · running/); assert.match(output, /Second · running/); assert.match(output, /Beginning review/);
	viewer!.handleInput("x");
	await until(() => panel.render(180).length === 0);
	assert.match(viewer!.render(160).join("\n"), /stopped/);
	viewer!.handleInput("\x1b"); await viewing;
	const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "Workflow") as unknown as { details: { taskId: string } };
	assert.ok(result.details.taskId); assert.equal(engine.workflows().has(result.details.taskId), true);
	assert.deepEqual(errors, []);
});

test("RR11: unchanged child progress visits no historical slots and text tails reuse the cached outline", t => {
	let builds = 0, slotVisits = 0, publishes = 0;
	let latest!: Activity;
	const activities = new WorkflowActivities(undefined, entry => { publishes++; latest = entry; }, {
		outlineBuilt(slots) { builds++; slotVisits += slots; },
	});
	t.after(() => activities.dispose());
	activities.receipt(receipt);
	const progress = (event: WorkflowProgress) => activities.observe({ type: "workflow-progress", taskId: "task-1", runId: "run-1", event });
	for (let index = 1; index <= 999; index++) progress({ type: "agent", logicalIndex: index, label: `worker ${index}`, state: "done" });
	progress({ type: "phase", index: 1, title: "Inspect" });
	activities.child({ agentId: "active-child", workflow: { taskId: "task-1", runId: "run-1", logicalIndex: 1000, label: "Active", phase: "Inspect" } }, "child-run");
	assert.equal(latest.detail, "999/1000 done · 0 cached · 0 failed");
	const before = latest.output;
	builds = slotVisits = publishes = 0;
	for (let index = 0; index < 500; index++) activities.observe({ type: "run-event", agentId: "active-child", runId: "child-run", event: { type: "progress", at: index, kind: "stream" } });
	assert.equal(builds, 0);
	assert.equal(slotVisits, 0);
	assert.equal(publishes, 0);
	assert.equal(latest.output, before);
	progress({ type: "agent", logicalIndex: 1000, label: "Active", phase: "Inspect", state: "start", agentId: "active-child" });
	progress({ type: "phase", index: 1, title: "Inspect" });
	activities.receipt(receipt);
	activities.observe({ type: "run-event", agentId: "active-child", runId: "child-run", event: { type: "text", delta: "" } });
	assert.equal(publishes, 0, "duplicate slots, phases, receipts and empty text have no projected change");
	for (let index = 0; index < 500; index++) {
		activities.observe({ type: "run-event", agentId: "active-child", runId: "child-run", event: { type: "text", delta: index === 499 ? "FINAL LIVE TAIL" : "x" } });
		activities.observe({ type: "run-event", agentId: "active-child", runId: "child-run", event: { type: "progress", at: index, kind: "stream" } });
	}
	assert.equal(builds, 0, "text changes do not rebuild the outline");
	assert.equal(slotVisits, 0);
	assert.equal(publishes, 500, "each text update publishes once; its redundant backend progress does not");
	assert.equal(latest.detail, "999/1000 done · 0 cached · 0 failed");
	assert.match(latest.output, /FINAL LIVE TAIL/);
	assert.ok(latest.output.length < 64000);
	progress({ type: "log", message: "Latest workflow log" });
	assert.equal(builds, 0);
	assert.match(latest.output, /Latest workflow log/);
	progress({ type: "agent", logicalIndex: 1000, state: "done" });
	assert.equal(builds, 1);
	assert.equal(slotVisits, 1000);
	assert.equal(latest.detail, "1000/1000 done · 0 cached · 0 failed");
	progress({ type: "phase", index: 2, title: "Inspect" });
	assert.equal(builds, 2, "a real phase change invalidates the outline");
	assert.equal(slotVisits, 2000);
	assert.match(latest.output, /Phase 2 · Inspect/);
});

test("RR11: stop and terminal controls publish immediately without rebuilding an unchanged outline", async t => {
	let release!: () => void;
	const hold = new Promise<void>(resolve => { release = resolve; });
	let builds = 0;
	const updates: string[] = [];
	let latest!: Activity;
	const activities = new WorkflowActivities(async () => { await hold; return true; }, entry => { latest = entry; updates.push(entry.status); }, { outlineBuilt() { builds++; } });
	t.after(() => { release(); activities.dispose(); });
	activities.receipt(receipt);
	activities.observe({ type: "workflow-progress", taskId: "task-1", runId: "run-1", event: { type: "agent", logicalIndex: 1, state: "start" } });
	builds = 0; updates.length = 0;
	const stopping = latest.stop!();
	assert.equal(latest.status, "stopping");
	assert.deepEqual(updates, ["stopping"]);
	assert.equal(builds, 0);
	activities.observe({ type: "workflow-settled", taskId: "task-1", runId: "run-1", status: "killed" });
	assert.equal(latest.status, "stopped");
	assert.equal(latest.stop, undefined);
	assert.deepEqual(updates, ["stopping", "stopped"]);
	assert.equal(builds, 0);
	release(); await stopping;
	activities.observe({ type: "workflow-settled", taskId: "task-1", runId: "run-1", status: "killed" });
	assert.deepEqual(updates, ["stopping", "stopped"], "duplicate terminal notifications are no-ops");
	activities.receipt({ ...receipt, workflowName: "Updated terminal name" });
	assert.match(latest.title, /Updated terminal name/);
	assert.equal(latest.status, "stopped");
	assert.equal(builds, 0, "receipt titles do not invalidate the historical outline");
});
