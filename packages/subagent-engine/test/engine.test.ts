import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, toolResultText, until } from "./fixtures/harness.ts";

test("foreground Agent returns the child's report to the parent tool call", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const harness = await createHarness({
		parent: ({ index }) => index === 0
			? { tools: [{ name: "Agent", args: { description: "Find the thing", prompt: "Look for X", run_in_background: false } }] }
			: { text: "Parent done" },
		child: () => () => ({ text: "Child found X in src/x.ts" }),
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	const results = toolResultText(harness.parent, "Agent");
	assert.equal(results.length, 1);
	assert.match(results[0], /Child found X in src\/x\.ts/);
	assert.equal(harness.children.size, 1);
});

test("background Agent returns at once and its completion wakes the idle parent", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const harness = await createHarness({
		parent: ({ index }) => index === 0
			? { tools: [{ name: "Agent", args: { description: "Background research", prompt: "Research Y" } }] }
			: { text: `Parent turn ${index}` },
		child: () => () => ({ wait: gate, then: { text: "Y is in lib/y.ts" } }),
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate in background", { source: "extension" });
	const launch = toolResultText(harness.parent, "Agent");
	assert.match(launch[0], /SendMessage|notif/i);
	assert.equal(harness.requests.parent, 2);
	release();
	await until(() => harness.parent.messages.some((message) => (message as { customType?: string }).customType === "subagent-notification"));
	await until(() => harness.requests.parent >= 3);
	const notice = harness.parent.messages.find((message) => (message as { customType?: string }).customType === "subagent-notification") as { content: string };
	assert.match(String(notice.content), /Y is in lib\/y\.ts/);
});

test("maxTurns ends a tool loop after the last allowed batch without another model request", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const harness = await createHarness({
		parent: ({ index }) => index === 0
			? { tools: [{ name: "Agent", args: { description: "Loop forever", prompt: "Keep listing", subagent_type: "looper", run_in_background: false } }] }
			: { text: "ok" },
		child: () => () => ({ tools: [{ name: "ls", args: { path: "." } }] }),
		agentFiles: { "looper.md": "---\nname: looper\ndescription: loops\nmaxTurns: 2\n---\nLoop." },
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Go", { source: "extension" });
	const [childId] = [...harness.children.keys()];
	assert.equal(harness.requests.children.get(childId), 2);
	assert.match(toolResultText(harness.parent, "Agent")[0], /turn/i);
});

test("SendMessage steers a running agent and resumes a finished one with the same identity", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const seen: string[] = [];
	const harness = await createHarness({
		parent: ({ index }) => {
			if (index === 0) return { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Start", name: "worker" } }] };
			if (index === 1) return { tools: [{ name: "SendMessage", args: { to: "worker", message: "Also check Z" } }] };
			return { text: `parent ${index}` };
		},
		child: () => ({ index, messages }) => {
			seen.push(JSON.stringify(messages.at(-1)));
			if (index === 0) return { tools: [{ name: "ls", args: { path: "." } }] };
			if (index === 1) return { wait: firstGate, then: { text: "first report" } };
			return { text: `report ${index}` };
		},
	});
	t.after(() => harness.close());
	const prompt = harness.parent.prompt("Go", { source: "extension" });
	await until(() => toolResultText(harness.parent, "SendMessage").length === 1);
	assert.match(toolResultText(harness.parent, "SendMessage")[0], /Queued for the agent's next tool round/);
	releaseFirst();
	await prompt;
	const agentId = [...harness.children.keys()][0];
	await until(() => harness.engine.control.get(agentId)?.active === undefined);
	assert.equal(harness.children.size, 1, "same agent identity, no replacement child");
	assert.ok(seen.some((entry) => entry.includes("Also check Z")), "the steering message reached a child request");
	assert.deepEqual(harness.engine.inbox(agentId).all().map((envelope) => envelope.state), ["included"]);
});

test("SendMessage to a finished agent resumes the same conversation in a new run", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const childSeen: string[] = [];
	let agentId = "";
	const harness = await createHarness({
		parent: ({ index, messages }) => {
			if (index === 0) return { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Count files", run_in_background: false } }] };
			if (index === 1) {
				agentId = /agentId: (a[a-f0-9]+)/.exec(JSON.stringify(messages))?.[1] ?? "";
				return { tools: [{ name: "SendMessage", args: { to: agentId, message: "Now count directories" } }] };
			}
			return { text: `parent ${index}` };
		},
		child: () => ({ index, messages }) => {
			childSeen.push(JSON.stringify(messages));
			return { text: index === 0 ? "3 files" : "2 directories" };
		},
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Go", { source: "extension" });
	assert.match(toolResultText(harness.parent, "SendMessage")[0], /resuming/);
	await until(() => harness.parent.messages.some((message) => /2 directories/.test(JSON.stringify(message))), 10_000);
	assert.equal(harness.children.size, 1);
	assert.match(childSeen[1], /3 files/, "the resumed run keeps the earlier conversation");
	const runs = harness.engine.control.get(agentId)!.meta.runs;
	assert.deepEqual(runs.map((run) => [run.invocation, run.status]), [["spawn", "completed"], ["continue", "completed"]]);
});

test("TaskStop from the main conversation stops a running background agent", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const never = new Promise<void>(() => {});
	let agentId = "";
	const harness = await createHarness({
		parent: ({ index, messages }) => {
			if (index === 0) return { tools: [{ name: "Agent", args: { description: "Slow", prompt: "Wait" } }] };
			if (index === 1) {
				agentId = /agentId=\\?"(a[a-f0-9]+)/.exec(JSON.stringify(messages))?.[1] ?? "";
				return { tools: [{ name: "TaskStop", args: { task_id: agentId } }] };
			}
			return { text: "stopped" };
		},
		child: () => () => ({ wait: never, then: { text: "never" } }),
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Go", { source: "extension" });
	assert.match(toolResultText(harness.parent, "TaskStop")[0], /Stopping/);
	await until(() => harness.engine.control.get(agentId)?.active === undefined);
	const summary = harness.engine.control.get(agentId)!.meta.runs[0];
	assert.equal(summary.status, "killed");
	assert.equal(summary.killedBy, "parent");
});

test("admission refuses rather than queues at the concurrency limit, and depth is capped", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const never = new Promise<void>(() => {});
	const harness = await createHarness({
		env: { PI_MAX_CONCURRENT_SUBAGENTS: "1" },
		parent: ({ index }) => index === 0
			? { tools: [
				{ name: "Agent", args: { description: "One", prompt: "a" } },
				{ name: "Agent", args: { description: "Two", prompt: "b" } },
			] }
			: { text: "done" },
		child: () => () => ({ wait: never, then: { text: "x" } }),
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Go", { source: "extension" });
	const results = toolResultText(harness.parent, "Agent");
	assert.equal(results.length, 2);
	assert.equal(results.filter((text) => /Too many subagents/.test(text)).length, 1);
	assert.equal(harness.engine.control.activeRuns(), 1);
});

test("agent listing reaches each request once, persists, and later definitions arrive as deltas", { timeout: 20_000 }, async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const seen: string[] = [];
	const harness = await createHarness({
		parent: ({ messages }) => {
			seen.push(JSON.stringify(messages));
			return { text: "ok" };
		},
		child: () => () => ({ text: "unused" }),
	});
	t.after(() => harness.close());
	await harness.parent.prompt("First", { source: "extension" });
	assert.match(seen[0], /Available agent types/);
	assert.match(seen[0], /Explore/);
	assert.equal((seen[0].match(/Available agent types/g) ?? []).length, 1);
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	mkdirSync(join(harness.root, "agent", "agents"), { recursive: true });
	writeFileSync(join(harness.root, "agent", "agents", "auditor.md"), "---\nname: auditor\ndescription: Audits configs\n---\nAudit.");
	await new Promise((resolve) => setTimeout(resolve, 2100));
	await harness.parent.prompt("Second", { source: "extension" });
	const second = seen.at(-1)!;
	assert.equal((second.match(/Available agent types/g) ?? []).length, 1, "the initial listing is not repeated");
	assert.match(second, /Agent type changes/);
	assert.match(second, /auditor: Audits configs/);
	const persisted = harness.parent.sessionManager.getEntries().filter((entry) => (entry as { customType?: string }).customType === "agent-listing");
	assert.equal(persisted.length, 2);
});
