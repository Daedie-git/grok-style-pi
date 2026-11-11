import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowSnapshot } from "../src/workflow-tool.ts";
import type { WorkflowHost } from "../src/workflow/host.ts";
import { createHarness, until } from "./fixtures/harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}
function source(body: string): string {
	return `export const meta = {name:'snapshot-workflow',description:'Snapshot regression',phases:[{title:'Inspect'}]};\n${body}`;
}
function agents(snapshot: WorkflowSnapshot) {
	return snapshot.progress.filter((event) => event.type === "agent");
}

test("workflow snapshots retain queued and cached logical calls and publish detached authoritative progress", { timeout: 15_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
	const held = gate();
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1", PI_WORKFLOW_CONCURRENCY: "1" },
		parent: () => ({ text: "Done" }),
		child: () => () => ({ wait: held.promise, then: { text: "Inspected" } }),
	});
	t.after(async () => { held.release(); await harness.close(); });
	assert.deepEqual(harness.engine.workflowSnapshots(), []);
	assert.equal(Reflect.get(harness.engine, "workflowTasks"), undefined, "reading snapshots does not create a manager");
	// Keep the real runtime host so retry progress can also exercise identity replacement directly.
	const manager = harness.engine.workflows() as unknown as { host(...args: unknown[]): WorkflowHost };
	const createHost = manager.host.bind(manager);
	let host!: WorkflowHost;
	t.mock.method(manager, "host", (...args: unknown[]) => { host = createHost(...args); return host; });
	const published: string[] = [];
	harness.engine.subscribe((event) => {
		if (event.type !== "workflow-progress" || event.event.type === "log") return;
		const snapshot = harness.engine.workflowSnapshots().find((item) => item.taskId === event.taskId);
		assert.ok(snapshot, "task registration precedes its first event");
		if (event.event.type === "agent") {
			const progress = event.event;
			assert.equal(agents(snapshot).find((item) => item.logicalIndex === progress.logicalIndex)?.state, progress.state);
			published.push(progress.state);
		}
	});
	const script = source("phase('Inspect'); log('not snapshot history'); return await parallel([()=>agent('Inspect A',{label:'A'}),()=>agent('Inspect B',{label:'B'})]);");
	const before = Date.now();
	const launched = await harness.engine.workflows().launch({ script }, harness.parent.extensionRunner.createContext());
	assert.notEqual(launched.isError, true, launched.text);
	const { taskId, runId } = launched.details as { taskId: string; runId: string };
	await until(() => harness.children.size === 1 && agents(harness.engine.workflowSnapshots()[0]).length === 2);
	const live = harness.engine.workflowSnapshots()[0];
	assert.equal(live.status, "running");
	assert.ok(live.startedAt >= before && live.startedAt <= Date.now());
	assert.equal(live.endedAt, undefined);
	assert.deepEqual(agents(live).map((event) => event.state), ["start", "queued"]);
	assert.equal(live.progress.filter((event) => event.type === "phase").length, 1);
	assert.equal(live.progress.length, 3, "log history is not retained");
	live.name = "mutated";
	live.progress[0].type === "phase" && (live.progress[0].title = "mutated");
	agents(live)[0].label = "mutated";
	live.progress.pop();
	const fresh = harness.engine.workflowSnapshots()[0];
	assert.equal(fresh.name, "snapshot-workflow");
	assert.equal(fresh.progress.length, 3);
	assert.equal(agents(fresh)[0].label, "A");
	held.release();
	await until(() => harness.engine.workflowSnapshots()[0].status === "completed");
	const done = harness.engine.workflowSnapshots()[0];
	assert.equal(done.taskId, taskId);
	assert.ok(done.endedAt! >= done.startedAt);
	assert.deepEqual(agents(done).map((event) => event.state), ["done", "done"]);
	assert.ok(agents(done).every((event) => event.agentId && event.label && event.phase === "Inspect"));
	const resumed = await harness.engine.workflows().launch({ script, resumeFromRunId: runId }, harness.parent.extensionRunner.createContext());
	assert.notEqual(resumed.isError, true, resumed.text);
	const resumedTaskId = (resumed.details as { taskId: string }).taskId;
	await until(() => harness.engine.workflowSnapshots().find((item) => item.taskId === resumedTaskId)?.status === "completed");
	const cached = harness.engine.workflowSnapshots().find((item) => item.taskId === resumedTaskId)!;
	assert.notEqual(cached.taskId, taskId);
	assert.equal(cached.runId, runId);
	assert.deepEqual(agents(cached).map((event) => event.state), ["cached", "cached"]);
	assert.equal(harness.children.size, 2, "cached calls have no new child sessions");
	assert.ok(published.includes("queued") && published.includes("cached"));
	for (const state of ["done", "failed"] as const) {
		host.progress({ type: "agent", logicalIndex: 1, state, label: "Retry", phase: "Inspect", agentId: "previous-child" });
		host.progress({ type: "agent", logicalIndex: 1, state: "start" });
		const retry = agents(harness.engine.workflowSnapshots().find((item) => item.taskId === resumedTaskId)!)[0];
		assert.equal(retry.agentId, undefined, `${state} -> start must clear the previous attempt's child`);
		assert.equal(retry.label, "Retry");
		assert.equal(retry.phase, "Inspect");
	}
	host.progress({ type: "agent", logicalIndex: 1, state: "start", agentId: "new-child" });
	assert.equal(agents(harness.engine.workflowSnapshots().find((item) => item.taskId === resumedTaskId)!)[0].agentId, "new-child");
});

test("workflow failure snapshots override completed child runs after structured-output exhaustion", { timeout: 15_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" }, parent: () => ({ text: "Done" }),
		child: () => () => ({ tools: [{ name: "StructuredOutput", args: { result: "invalid" } }] }),
	});
	t.after(() => harness.close());
	let settled = false;
	harness.engine.subscribe((event) => {
		if (event.type === "workflow-settled") {
			const snapshot = harness.engine.workflowSnapshots().find((item) => item.taskId === event.taskId)!;
			assert.equal(snapshot.status, "failed");
			assert.ok(snapshot.endedAt);
			assert.equal(agents(snapshot)[0].state, "failed");
			settled = true;
		}
	});
	await harness.engine.workflows().launch({ script: source("return await agent('Return a count',{label:'Validate',schema:{type:'object',properties:{count:{type:'integer'}},required:['count']}});") }, harness.parent.extensionRunner.createContext());
	await until(() => settled);
	const snapshot = harness.engine.workflowSnapshots()[0];
	const child = harness.engine.agentSnapshots()[0];
	assert.equal(child.status, "completed", "transport completion is not logical workflow success");
	assert.equal(snapshot.status, "failed");
	assert.equal(agents(snapshot)[0].state, "failed");
	assert.equal(agents(snapshot)[0].label, "Validate");
	assert.equal(agents(snapshot)[0].attempt, 1);
	assert.equal(child.workflow?.attempt, 1);
});

test("active workflows without child runs remain publicly visible and settle with wall-clock timestamps", { timeout: 10_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
	const harness = await createHarness({ env: { PI_WORKFLOW_APPROVE: "1" }, parent: () => ({ text: "Done" }), child: () => () => ({ text: "Unexpected" }) });
	t.after(() => harness.close());
	await harness.engine.workflows().launch({ script: source("phase('Inspect'); await new Promise(()=>{});") }, harness.parent.extensionRunner.createContext());
	await until(() => harness.engine.workflowSnapshots()[0]?.progress.length === 1);
	const active = harness.engine.workflowSnapshots()[0];
	assert.equal(active.status, "running");
	assert.deepEqual(harness.engine.agentSnapshots(), []);
	harness.engine.workflows().stop(active.taskId);
	await until(() => harness.engine.workflowSnapshots()[0].status === "killed");
	assert.ok(harness.engine.workflowSnapshots()[0].endedAt! >= active.startedAt);
});

test("real workflow attempt provenance survives completed-child teardown and advances on retry", { timeout: 15_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
	const cleanup = gate(), second = gate();
	let created = 0, cleaning = false;
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" }, parent: () => ({ text: "Done" }),
		child: () => ++created === 1
			? () => ({ text: "Missing structured attachment" })
			: () => ({ wait: second.promise, then: { tools: [{ name: "StructuredOutput", args: { result: { count: 1 } } }] } }),
	});
	t.after(async () => { cleanup.release(); second.release(); await harness.close(); });
	const teardown = harness.engine.teardown.bind(harness.engine);
	t.mock.method(harness.engine, "teardown", async (agentId: string) => {
		await teardown(agentId);
		if (harness.engine.agentSnapshots().find((child) => child.agentId === agentId)?.workflow?.attempt === 1) {
			cleaning = true;
			await cleanup.promise;
		}
	});
	const starts: number[] = [];
	harness.engine.subscribe((event) => {
		if (event.type === "workflow-progress" && event.event.type === "agent" && event.event.state === "start") starts.push(event.event.attempt!);
	});
	await harness.engine.workflows().launch({ script: source("return await agent('Return a count',{schema:{type:'object',properties:{count:{type:'integer'}},required:['count']}});") }, harness.parent.extensionRunner.createContext());
	await until(() => cleaning);
	const waiting = agents(harness.engine.workflowSnapshots()[0])[0];
	const completedChild = harness.engine.agentSnapshots()[0];
	assert.equal(waiting.state, "start", "logical work includes post-child teardown");
	assert.equal(completedChild.status, "completed");
	assert.equal(waiting.attempt, 1);
	assert.equal(completedChild.workflow?.attempt, waiting.attempt, "completed same-attempt metrics remain attributable");
	cleanup.release();
	await until(() => harness.engine.agentSnapshots().length === 2);
	const retry = agents(harness.engine.workflowSnapshots()[0])[0];
	const retryChild = harness.engine.agentSnapshots().find((child) => child.workflow?.attempt === 2)!;
	assert.equal(retry.state, "start");
	assert.equal(retry.attempt, 2);
	assert.equal(retryChild.workflow?.attempt, retry.attempt);
	assert.notEqual(completedChild.workflow?.attempt, retry.attempt);
	assert.equal(retry.agentId, undefined, "start cannot retain the prior attempt's child ID");
	second.release();
	await until(() => harness.engine.workflowSnapshots()[0].status === "completed");
	const done = agents(harness.engine.workflowSnapshots()[0])[0];
	assert.deepEqual(starts, [1, 2]);
	assert.equal(done.state, "done");
	assert.equal(done.attempt, 2);
	assert.equal(done.agentId, retryChild.agentId);
});

test("a retry failing before spawn reports its own attempt rather than the prior child's provenance", { timeout: 15_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" }, parent: () => ({ text: "Done" }),
		child: () => () => ({ text: "Missing structured attachment" }),
	});
	t.after(() => harness.close());
	const spawn = harness.engine.spawn.bind(harness.engine);
	t.mock.method(harness.engine, "spawn", (...args: Parameters<typeof spawn>) => {
		if (args[2].internal?.workflow?.attempt === 2) throw new Error("Retry admission failed before spawn");
		return spawn(...args);
	});
	await harness.engine.workflows().launch({ script: source("return await agent('Return a count',{schema:{type:'object'}});") }, harness.parent.extensionRunner.createContext());
	await until(() => harness.engine.workflowSnapshots()[0].status === "failed");
	const failed = agents(harness.engine.workflowSnapshots()[0])[0];
	const children = harness.engine.agentSnapshots();
	assert.equal(children.length, 1);
	assert.equal(children[0].status, "completed");
	assert.equal(children[0].workflow?.attempt, 1);
	assert.equal(failed.state, "failed");
	assert.equal(failed.attempt, 2, "failure provenance must identify the attempt that failed before a child existed");
	assert.notEqual(failed.attempt, children[0].workflow?.attempt);
});
