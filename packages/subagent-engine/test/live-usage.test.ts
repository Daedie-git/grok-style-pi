import assert from "node:assert/strict";
import test from "node:test";
import type { InProcessBackend } from "../src/backends/in-process.ts";
import type { BackendEvent, UsageAccounting } from "../src/types.ts";
import { createHarness, until } from "./fixtures/harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

test("metered message ends publish live detached usage and snapshots fence resumed runs", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const first = gate(), resumed = gate();
	const harness = await createHarness({
		parent: ({ index }) => index === 0
			? { tools: [{ name: "Agent", args: { description: "Usage worker", name: "worker", prompt: "Inspect", run_in_background: false } }] }
			: index === 2
				? { tools: [{ name: "SendMessage", args: { to: "worker", message: "Continue" } }] }
				: { text: "Parent done" },
		child: () => ({ index }) => index === 0
			? { tools: [{ name: "ls", args: { path: "." } }] }
			: { wait: index === 1 ? first.promise : resumed.promise, then: { text: "Report" } },
	});
	t.after(async () => { first.release(); resumed.release(); await harness.close(); });
	// Retain the backend callback to simulate a late event from a completed handle.
	const backend = (harness.engine as unknown as { backend: InProcessBackend }).backend;
	const run = backend.run.bind(backend);
	const listeners: ((event: BackendEvent) => void)[] = [];
	t.mock.method(backend, "run", (...args: Parameters<InProcessBackend["run"]>) => {
		const handle = run(...args);
		const subscribe = handle.subscribe.bind(handle);
		handle.subscribe = (listener) => { listeners.push(listener); return subscribe(listener); };
		return handle;
	});
	const events: { runId: string; usage: UsageAccounting }[] = [];
	harness.engine.subscribe((event) => {
		if (event.type === "run-event" && event.event.type === "usage") {
			events.push({ runId: event.runId, usage: event.event.usage });
		}
	});
	const prompt = harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => events.length === 1 && [...harness.requests.children.values()][0] === 2);
	const live = harness.engine.agentSnapshots()[0];
	assert.equal(live.running, true);
	assert.equal(live.runId, events[0].runId);
	assert.deepEqual(live.usage?.billable, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: 0 });
	assert.equal(live.usage?.latestFootprint, 11);
	assert.equal(live.usage?.liveMetric, 11);
	assert.equal(live.usage?.modelTransitions.length, 1);
	// Neither event consumers nor snapshot consumers can mutate the engine's accounting.
	events[0].usage.billable.input = 999;
	events[0].usage.modelTransitions.push("event mutation");
	live.usage!.billable.output = 999;
	live.usage!.modelTransitions.push("snapshot mutation");
	const fresh = harness.engine.agentSnapshots()[0];
	assert.equal(fresh.usage?.billable.input, 10);
	assert.equal(fresh.usage?.billable.output, 1);
	assert.equal(fresh.usage?.modelTransitions.length, 1);
	first.release();
	await prompt;
	await until(() => !harness.engine.agentSnapshots()[0].running);
	const settled = harness.engine.agentSnapshots()[0];
	assert.equal(events.length, 2, "each metered assistant message publishes accounting");
	assert.equal(events[1].usage.billable.totalTokens, 22, "event mutation does not alter the backend tracker");
	assert.equal(settled.usage?.billable.totalTokens, 22, "settlement retains final usage");
	listeners[0]({ type: "usage", usage: events[0].usage });
	assert.equal(harness.engine.agentSnapshots()[0].usage?.billable.totalTokens, 22, "late events cannot overwrite settled usage");
	await harness.parent.prompt("Resume", { source: "extension" });
	await until(() => harness.engine.agentSnapshots()[0].running && [...harness.requests.children.values()][0] === 3);
	const next = harness.engine.agentSnapshots()[0];
	assert.notEqual(next.runId, settled.runId);
	assert.equal(next.usage, undefined, "a new run does not inherit the prior run's totals");
	listeners[0]({ type: "usage", usage: events[0].usage });
	assert.equal(harness.engine.agentSnapshots()[0].usage, undefined, "an old handle cannot update the current run");
	resumed.release();
	await until(() => !harness.engine.agentSnapshots()[0].running);
	const final = harness.engine.agentSnapshots()[0];
	assert.equal(final.usage?.billable.totalTokens, 11, "continuation accounting starts from zero");
	assert.equal(events.at(-1)?.runId, next.runId);
});
