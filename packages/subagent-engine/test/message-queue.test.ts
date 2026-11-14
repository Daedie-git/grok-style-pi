import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT_CALLER } from "../src/engine.ts";
import { InboxStore } from "../src/store/inbox.ts";
import { createHarness, until, type Harness, type Step } from "./fixtures/harness.ts";

function noNetwork(t: { mock: { method: Function } }): void {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

const last = (messages: unknown[]): string => JSON.stringify(messages.at(-1));

async function worker(t: Parameters<typeof noNetwork>[0] & { after: (fn: () => unknown) => void }, child: (request: { index: number; messages: unknown[] }) => Step): Promise<{ harness: Harness; id: string; seen: string[] }> {
	noNetwork(t);
	const seen: string[] = [];
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Start", name: "worker" } }] } : { text: "ok" },
		child: () => (request) => {
			seen.push(last(request.messages));
			return child(request);
		},
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => seen.length === 1);
	return { harness, id: [...harness.children.keys()][0], seen };
}

test("queued tasks wait for completion, run one per run in order, and stay editable until they start", { timeout: 20_000 }, async (t) => {
	const first = gate();
	const taskA = gate();
	const { harness, id, seen } = await worker(t, ({ index, messages }) => {
		if (index === 0) return { wait: first.promise, then: { tools: [{ name: "ls", args: { path: "." } }] } };
		if (last(messages).includes("task A")) return { wait: taskA.promise, then: { text: "A done" } };
		return { text: `answer ${index}` };
	});
	const send = (message: string, queue: boolean, key: string) => harness.engine.sendMessage({ to: "worker", message, queue }, ROOT_CALLER, key);
	const a = await send("task A", true, "a");
	const b = await send("task B", true, "b");
	const c = await send("task C", true, "c");
	assert.equal(a.delivery, "task-queued");
	assert.match(b.message, /task 2/);
	assert.equal((await send("steer S", false, "s")).delivery, "queued");
	assert.equal(harness.engine.editQueue({ to: "worker", action: "replace", id: b.envelopeId, message: "task B2" }, ROOT_CALLER).isError, undefined);
	assert.match(harness.engine.editQueue({ to: "worker", action: "withdraw", id: c.envelopeId }, ROOT_CALLER).text, /Withdrew/);
	assert.match(harness.engine.editQueue({ to: "worker", action: "list" }, ROOT_CALLER).text, /1\. .*task A\n2\. .*task B2$/);
	first.release();
	const conversation = harness.engine.control.get(id)!;
	await until(() => seen.some((text) => text.includes("task A")));
	assert.equal(conversation.meta.runs.length, 2, "the queued task starts its own run");
	assert.match(harness.engine.editQueue({ to: "worker", action: "replace", id: a.envelopeId, message: "too late" }, ROOT_CALLER).text, /already started/);
	taskA.release();
	await until(() => conversation.meta.runs.length === 3 && !conversation.active);
	await conversation.exiting;
	assert.deepEqual(conversation.meta.runs.map((run) => run.status), ["completed", "completed", "completed"]);
	assert.ok(seen[1].includes("steer S") && !seen[1].includes("task"), "the steer reached the live run; no queued task did");
	assert.ok(seen.findIndex((text) => text.includes("task A")) < seen.findIndex((text) => text.includes("task B2")));
	assert.ok(!seen.some((text) => text.includes("task C") || text.includes("\"task B\"")));
	assert.equal(harness.engine.inbox(id).undelivered().length, 0);
});

test("needs_answer holds the queue until a steer resumes the agent and that run completes", { timeout: 20_000 }, async (t) => {
	const asked = gate();
	const { harness, id, seen } = await worker(t, ({ index }) => index === 0 ? { wait: asked.promise, then: { tools: [{ name: "needs_answer", args: { question: "A or B?" } }] } } : { text: `answer ${index}` });
	await harness.engine.sendMessage({ to: "worker", message: "queued later work", queue: true }, ROOT_CALLER, "q");
	asked.release();
	const conversation = harness.engine.control.get(id)!;
	await until(() => conversation.meta.runs[0].status === "needs-answer" && !conversation.active);
	await conversation.exiting;
	const held = await harness.engine.sendMessage({ to: "worker", message: "queued even later", queue: true }, ROOT_CALLER, "q2");
	assert.match(held.message, /did not complete/);
	assert.equal(conversation.meta.runs.length, 1, "the queue did not answer the question");
	await harness.engine.sendMessage({ to: "worker", message: "Use B" }, ROOT_CALLER, "answer");
	await until(() => conversation.meta.runs.length === 4 && !conversation.active);
	assert.ok(seen[1].includes("Use B") && !seen[1].includes("queued"));
	assert.ok(seen[2].includes("queued later work") && seen[3].includes("queued even later"));
});

test("TaskStop holds a running agent's queue and says so", { timeout: 20_000 }, async (t) => {
	const never = gate();
	t.after(() => never.release());
	const { harness, id } = await worker(t, () => ({ wait: never.promise, then: { text: "late" } }));
	const queued = await harness.engine.sendMessage({ to: "worker", message: "queued work", queue: true }, ROOT_CALLER, "q");
	assert.match((await harness.engine.stop(id, ROOT_CALLER)).text, /1 queued task/);
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	const envelope = harness.engine.inbox(id).all().find((candidate) => candidate.id === queued.envelopeId)!;
	assert.equal(envelope.state, "pending");
	assert.equal(conversation.meta.runs.length, 1);
});

test("queued and revised envelopes survive a reload of the inbox journal", () => {
	const dir = mkdtempSync(join(tmpdir(), "queue-inbox-"));
	try {
		const file = join(dir, "inbox.jsonl");
		const inbox = new InboxStore(file);
		const accepted = inbox.accept({ acceptanceKey: "k", from: "main", to: "a1", text: "old", queued: true });
		assert.ok(!("conflict" in accepted));
		inbox.revise(accepted.envelope.id, "new", "short");
		const [reloaded] = new InboxStore(file).undelivered();
		assert.deepEqual([reloaded.queued, reloaded.text, reloaded.summary], [true, "new", "short"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a queue request racing a steer past the definition check stays out of the steer's run", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const busy = gate();
	const check = gate();
	const seen: string[] = [];
	const harness = await createHarness({
		agentFiles: { "queue-worker.md": "---\nname: queue-worker\ndescription: worker\n---\nWork." },
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Start", name: "worker", subagent_type: "queue-worker" } }] } : { text: "ok" },
		child: () => ({ index, messages }) => {
			seen.push(last(messages));
			return index === 1 ? { wait: busy.promise, then: { tools: [{ name: "ls", args: { path: "." } }] } } : { text: "done" };
		},
	});
	t.after(() => { busy.release(); check.release(); return harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => harness.children.size === 1);
	const id = [...harness.children.keys()][0];
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	const original = harness.engine.definitions.bind(harness.engine);
	let calls = 0;
	t.mock.method(harness.engine, "definitions", async () => { if (calls++ === 0) await check.promise; return original(); });
	const queued = harness.engine.sendMessage({ to: id, message: "QUEUED TASK A", queue: true }, ROOT_CALLER, "q");
	await until(() => calls === 1);
	await harness.engine.sendMessage({ to: id, message: "BUSY STEER" }, ROOT_CALLER, "s");
	await until(() => seen.length === 2);
	check.release();
	assert.equal((await queued).delivery, "task-queued");
	busy.release();
	await until(() => conversation.meta.runs.length === 3 && !conversation.active);
	assert.ok(!seen[2].includes("QUEUED TASK A") && seen.at(-1)!.includes("QUEUED TASK A"), "the task got its own run");
});

test("a user stop of an idle agent drops its queue", { timeout: 20_000 }, async (t) => {
	const asked = gate();
	const { harness, id } = await worker(t, () => ({ wait: asked.promise, then: { tools: [{ name: "needs_answer", args: { question: "Which?" } }] } }));
	t.after(() => asked.release());
	const receipt = await harness.engine.sendMessage({ to: id, message: "pending task", queue: true }, ROOT_CALLER, "q");
	asked.release();
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	await harness.engine.userStop(id);
	assert.equal(harness.engine.inbox(id).all().find((envelope) => envelope.id === receipt.envelopeId)!.state, "refused");
});

test("withdrawing a queued task while its send is being validated starts no run", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const check = gate();
	const harness = await createHarness({
		agentFiles: { "queue-worker.md": "---\nname: queue-worker\ndescription: worker\n---\nWork." },
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Start", name: "worker", subagent_type: "queue-worker" } }] } : { text: "ok" },
		child: () => () => ({ text: "done" }),
	});
	t.after(() => { check.release(); return harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => harness.children.size === 1);
	const id = [...harness.children.keys()][0];
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	const original = harness.engine.definitions.bind(harness.engine);
	let calls = 0;
	t.mock.method(harness.engine, "definitions", async () => { if (calls++ === 0) await check.promise; return original(); });
	const sending = harness.engine.sendMessage({ to: id, message: "task to withdraw", queue: true }, ROOT_CALLER, "q");
	await until(() => calls === 1);
	harness.engine.editQueue({ to: id, action: "withdraw", id: harness.engine.inbox(id).undelivered()[0].id }, ROOT_CALLER);
	check.release();
	assert.match((await sending).message, /did not run: Withdrawn/);
	assert.equal(conversation.meta.runs.length, 1);
	assert.equal(conversation.active, undefined);
});

test("a user stop drops a queued task whose run failed before dispatch", { timeout: 20_000 }, async (t) => {
	const { harness, id } = await worker(t, () => ({ text: "done" }));
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	t.mock.method(harness.children.get(id)!, "prompt", async () => { throw new Error("prompt setup failed"); });
	const receipt = await harness.engine.sendMessage({ to: id, message: "not dispatched", queue: true }, ROOT_CALLER, "q");
	await until(() => conversation.meta.runs.length === 2 && !conversation.active);
	await conversation.exiting;
	await harness.engine.userStop(id);
	assert.equal(harness.engine.inbox(id).all().find((envelope) => envelope.id === receipt.envelopeId)!.state, "refused");
});

test("a task queued while a user stop is settling is refused, never steered in", { timeout: 20_000 }, async (t) => {
	const busy = gate();
	t.after(() => busy.release());
	const { harness, id } = await worker(t, ({ index }) => index === 0 ? { wait: busy.promise, then: { text: "late" } } : { text: "done" });
	const conversation = harness.engine.control.get(id)!;
	const stopped = harness.engine.userStop(id);
	const receipt = await harness.engine.sendMessage({ to: id, message: "task after stop", queue: true }, ROOT_CALLER, "q");
	await stopped;
	assert.equal(receipt.success, false);
	await until(() => !conversation.active);
	assert.ok(!JSON.stringify(harness.children.get(id)!.messages).includes("task after stop"));
});

test("a queue send whose task another dispatch already ran reports it started, not withdrawn", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const check = gate();
	const seen: string[] = [];
	const harness = await createHarness({
		agentFiles: { "queue-worker.md": "---\nname: queue-worker\ndescription: worker\n---\nWork." },
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Start", name: "worker", subagent_type: "queue-worker" } }] } : { text: "ok" },
		child: () => ({ messages }) => { seen.push(last(messages)); return { text: "done" }; },
	});
	t.after(() => { check.release(); return harness.close(); });
	await harness.parent.prompt("Delegate", { source: "extension" });
	await until(() => harness.children.size === 1);
	const id = [...harness.children.keys()][0];
	const conversation = harness.engine.control.get(id)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	const original = harness.engine.definitions.bind(harness.engine);
	let calls = 0;
	t.mock.method(harness.engine, "definitions", async () => { if (calls++ === 0) await check.promise; return original(); });
	const first = harness.engine.sendMessage({ to: id, message: "task A", queue: true }, ROOT_CALLER, "a");
	await until(() => calls === 1);
	await harness.engine.sendMessage({ to: id, message: "task B", queue: true }, ROOT_CALLER, "b");
	await until(() => conversation.meta.runs.length === 3 && !conversation.active);
	await conversation.exiting;
	check.release();
	const receipt = await first;
	assert.equal(receipt.success, true);
	assert.match(receipt.message, /already started/);
	assert.equal(conversation.meta.runs.length, 3);
	assert.equal(seen.filter((text) => text.includes("task A")).length, 1);
});

test("withdrawing a task that waits for a run slot starts no empty run", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const busy = gate();
	const seen = new Map<string, string[]>();
	const harness = await createHarness({
		env: { PI_MAX_CONCURRENT_SUBAGENTS: "1" },
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "A", prompt: "Start A", name: "a" } }] }
			: index === 2 ? { tools: [{ name: "Agent", args: { description: "B", prompt: "Start B", name: "b" } }] } : { text: "ok" },
		child: (agentId) => ({ messages }) => {
			const text = last(messages);
			seen.set(agentId, [...(seen.get(agentId) ?? []), text]);
			return text.includes("Start B") ? { wait: busy.promise, then: { text: "B done" } } : { text: "done" };
		},
	});
	t.after(() => { busy.release(); return harness.close(); });
	await harness.parent.prompt("Delegate A", { source: "extension" });
	await until(() => [...seen.values()].some((texts) => texts.some((text) => text.includes("Start B"))));
	const a = [...harness.children.keys()][0];
	const conversation = harness.engine.control.get(a)!;
	await until(() => !conversation.active);
	await conversation.exiting;
	const receipt = await harness.engine.sendMessage({ to: a, message: "queued task", queue: true }, ROOT_CALLER, "q");
	assert.equal(receipt.delivery, "pending-continuation");
	harness.engine.editQueue({ to: a, action: "withdraw", id: receipt.envelopeId }, ROOT_CALLER);
	busy.release();
	const b = [...harness.children.keys()][1];
	await until(() => harness.engine.control.get(b)!.meta.runs[0].status === "completed");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(conversation.meta.runs.length, 1);
	assert.equal(conversation.wakePending, undefined);
});

test("a session end keeps the queue for a later resume", { timeout: 20_000 }, async (t) => {
	const never = gate();
	t.after(() => never.release());
	const { harness, id } = await worker(t, () => ({ wait: never.promise, then: { text: "late" } }));
	const receipt = await harness.engine.sendMessage({ to: id, message: "queued work", queue: true }, ROOT_CALLER, "q");
	await harness.engine.shutdownRoot("quit");
	assert.equal(harness.engine.inbox(id).all().find((envelope) => envelope.id === receipt.envelopeId)!.state, "pending");
});

test("stopping a parent keeps its idle descendants' queues held", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const busy = gate();
	let parent = "";
	let child = "";
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "P", prompt: "initial", name: "p" } }] } : { text: "ok" },
		child: (id) => {
			if (!parent) parent = id;
			else child = id;
			return ({ index }) => id === parent
				? (index === 0 ? { tools: [{ name: "Agent", args: { description: "C", prompt: "initial", name: "c" } }] } : { wait: busy.promise, then: { text: "done" } })
				: (index === 0 ? { tools: [{ name: "needs_answer", args: { question: "Which?" } }] } : { text: "child completed" });
		},
	});
	t.after(() => { busy.release(); return harness.close(); });
	await harness.parent.prompt("go", { source: "extension" });
	await until(() => Boolean(child) && harness.engine.control.get(child)?.meta.runs[0]?.status === "needs-answer");
	await harness.engine.control.get(child)!.exiting;
	const receipt = await harness.engine.sendMessage({ to: child, message: "queued task", queue: true }, ROOT_CALLER, "q");
	await harness.engine.stop(parent, ROOT_CALLER);
	await until(() => !harness.engine.control.get(parent)!.active);
	assert.equal(harness.engine.inbox(child).all().find((envelope) => envelope.id === receipt.envelopeId)!.state, "pending");
	assert.equal(harness.engine.control.get(child)!.meta.runs.length, 1, "the held task waits for a steer");
});

test("a foreground caller gets the first report and each queued task reports on its own", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const first = gate();
	let owner = "";
	let child = "";
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "owner", prompt: "start" } }] } : { text: "ok" },
		child: (id) => {
			if (!owner) owner = id;
			else child = id;
			return ({ index }) => id === owner
				? (index === 0 ? { tools: [{ name: "Agent", args: { description: "foreground worker", prompt: "first task", run_in_background: false } }] } : { text: "owner done" })
				: (index === 0 ? { wait: first.promise, then: { text: "REPORT_FIRST" } } : { text: index === 1 ? "REPORT_A" : "REPORT_B" });
		},
	});
	t.after(() => { first.release(); return harness.close(); });
	await harness.parent.prompt("go", { source: "extension" });
	await until(() => Boolean(child));
	await harness.engine.sendMessage({ to: child, message: "task A", queue: true }, ROOT_CALLER, "a");
	await harness.engine.sendMessage({ to: child, message: "task B", queue: true }, ROOT_CALLER, "b");
	first.release();
	await until(() => {
		const messages = JSON.stringify(harness.children.get(owner)!.messages);
		return ["REPORT_FIRST", "REPORT_A", "REPORT_B"].every((report) => messages.includes(report));
	});
});

test("a parked foreground child's queued tasks still report to its owner", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const grandchildGate = gate();
	const initialGate = gate();
	let owner = "";
	let worker = "";
	let grandchild = "";
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "owner", prompt: "start" } }] } : { text: "ok" },
		child: (id) => {
			if (!owner) owner = id;
			else if (!worker) worker = id;
			else grandchild = id;
			return ({ index }) => id === owner
				? (index === 0 ? { tools: [{ name: "Agent", args: { description: "foreground worker", prompt: "work", run_in_background: false } }] } : { text: "owner done" })
				: id === worker
					? (index === 0 ? { tools: [{ name: "Agent", args: { description: "grandchild", prompt: "nested work" } }] }
						: index === 1 ? { wait: initialGate.promise, then: { text: "REPORT_INITIAL" } }
							: { text: index === 2 ? "REPORT_RESUMED" : index === 3 ? "REPORT_A" : "REPORT_B" })
					: { wait: grandchildGate.promise, then: { text: "grandchild done" } };
		},
	});
	t.after(() => { initialGate.release(); grandchildGate.release(); return harness.close(); });
	await harness.parent.prompt("go", { source: "extension" });
	await until(() => Boolean(grandchild));
	await harness.engine.sendMessage({ to: worker, message: "task A", queue: true }, ROOT_CALLER, "a");
	await harness.engine.sendMessage({ to: worker, message: "task B", queue: true }, ROOT_CALLER, "b");
	initialGate.release();
	await until(() => harness.engine.control.get(worker)?.disposition === "parked");
	grandchildGate.release();
	await until(() => {
		const messages = JSON.stringify(harness.children.get(owner)!.messages);
		return ["REPORT_RESUMED", "REPORT_A", "REPORT_B"].every((report) => messages.includes(report));
	});
});

test("a task queued while the agent is parked on its own child waits for that child", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const childGate = gate();
	let worker = "";
	let child = "";
	const seen: string[] = [];
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "worker", prompt: "initial" } }] } : { text: "ok" },
		child: (id) => {
			if (!worker) worker = id;
			else child = id;
			return ({ index, messages }) => {
				if (id !== worker) return { wait: childGate.promise, then: { text: "child done" } };
				seen.push(last(messages));
				return index === 0 ? { tools: [{ name: "Agent", args: { description: "child", prompt: "finish initial task" } }] } : { text: "worker done" };
			};
		},
	});
	t.after(() => { childGate.release(); return harness.close(); });
	await harness.parent.prompt("go", { source: "extension" });
	await until(() => Boolean(child) && harness.engine.control.get(worker)?.disposition === "parked");
	await harness.engine.control.get(worker)!.exiting;
	assert.equal((await harness.engine.sendMessage({ to: worker, message: "NEXT_TASK", queue: true }, ROOT_CALLER, "q")).delivery, "task-queued");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(!seen.some((text) => text.includes("NEXT_TASK")));
	childGate.release();
	await until(() => seen.some((text) => text.includes("NEXT_TASK")));
	assert.equal(harness.engine.control.get(child)!.active, undefined);
});

test("an idle owner's queue starts even while one of its finished children is steered", { timeout: 20_000 }, async (t) => {
	noNetwork(t);
	const steered = gate();
	const seen = new Map<string, string[]>();
	let owner = "";
	let child = "";
	const harness = await createHarness({
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "O", prompt: "owner start", name: "o" } }] } : { text: "ok" },
		child: (id) => {
			if (!owner) owner = id;
			else child = id;
			return ({ index, messages }) => {
				const text = last(messages);
				seen.set(id, [...(seen.get(id) ?? []), text]);
				if (id === owner) return index === 0 ? { tools: [{ name: "Agent", args: { description: "C", prompt: "child start", name: "c" } }] } : { text: `owner reply ${index}` };
				return text.includes("STEER C") ? { wait: steered.promise, then: { text: "C steered done" } } : { text: "C first done" };
			};
		},
	});
	t.after(() => { steered.release(); return harness.close(); });
	await harness.parent.prompt("go", { source: "extension" });
	await until(() => Boolean(child));
	const o = harness.engine.control.get(owner)!;
	const c = harness.engine.control.get(child)!;
	await until(() => !c.active && c.meta.runs[0]?.status === "completed" && !o.active && o.disposition === "evictable");
	await o.exiting;
	await c.exiting;
	await harness.engine.sendMessage({ to: child, message: "STEER C" }, ROOT_CALLER, "s");
	await harness.engine.sendMessage({ to: owner, message: "QUEUED O", queue: true }, ROOT_CALLER, "q");
	steered.release();
	await until(() => (seen.get(owner) ?? []).some((text) => text.includes("QUEUED O")));
});
