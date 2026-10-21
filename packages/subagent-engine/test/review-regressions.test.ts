// Regressions for the external implementation review (claude-sidecar analysis/grok-style-pi-review): R02, R03, R05, R07,
// R08, R09, R18, R20. Real parent/child AgentSessions with scripted fake models; no network.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ROOT_CALLER } from "../src/engine.ts";
import { installSpawnApi, type LauncherHandle } from "../src/spawn-api.ts";
import { createHarness, toolResultText, until } from "./fixtures/harness.ts";

const foregroundParent = ({ index }: { index: number }) => index === 0
	? { tools: [{ name: "Agent", args: { description: "Worker", prompt: "Start", run_in_background: false } }] }
	: { text: "root done" };

function offline(t: { mock: { method: (target: object, name: string, impl: () => unknown) => unknown } }) {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
}

test("R02: a user stop during continuation setup prevents any further provider request", { timeout: 20_000 }, async (t) => {
	offline(t);
	const harness = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => harness.close());
	await harness.parent.prompt("go", { source: "extension" });
	const id = [...harness.children.keys()][0];
	await until(() => !harness.engine.control.get(id)?.exiting);
	const engine = harness.engine as unknown as { continuationRefusal: (...args: unknown[]) => Promise<string | undefined> };
	const original = engine.continuationRefusal.bind(harness.engine);
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	engine.continuationRefusal = async (...args) => { if (args[1]) { entered(); await gate; } return original(...args); };
	await harness.engine.sendMessage({ to: id, message: "resume me" }, ROOT_CALLER, "cancel-race");
	await ready;
	await harness.engine.userStop(id);
	const before = harness.requests.children.get(id);
	release();
	await until(() => harness.engine.control.get(id)?.active === undefined);
	assert.equal(harness.requests.children.get(id), before);
	const last = harness.engine.control.get(id)!.meta.runs.at(-1)!;
	assert.equal(last.status, "killed");
	assert.equal(last.killedBy, "user");
});

test("R03: narrowing a definition revokes the old grant on continuation", { timeout: 20_000 }, async (t) => {
	offline(t);
	let now = 10_000;
	let root = "";
	const harness = await createHarness({
		now: () => now,
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Custom", prompt: "start", subagent_type: "custom", run_in_background: false } }] } : { text: "root done" },
		agentFiles: { "custom.md": "---\nname: custom\ndescription: custom\ntools: [write]\n---\nWork." },
		child: () => ({ index }) => index === 1 ? { tools: [{ name: "write", args: { path: join(root, "REVOKED_WRITE.txt"), content: "after revocation" } }] } : { text: "child report" },
	});
	root = harness.root;
	t.after(() => harness.close());
	await harness.parent.prompt("go", { source: "extension" });
	const id = [...harness.children.keys()][0];
	await until(() => !harness.engine.control.get(id)?.exiting);
	writeFileSync(join(harness.root, "agent", "agents", "custom.md"), "---\nname: custom\ndescription: custom\ntools: [read]\ndisallowedTools: [write]\n---\nRead only.");
	now += 2_001;
	await harness.engine.definitions();
	await harness.engine.sendMessage({ to: id, message: "continue" }, ROOT_CALLER, "policy-revocation");
	await until(() => !harness.engine.control.get(id)?.active);
	assert.equal(existsSync(join(harness.root, "REVOKED_WRITE.txt")), false);
});

test("R05: input of a continuation that fails before dispatch stays undelivered", { timeout: 20_000 }, async (t) => {
	offline(t);
	const harness = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => harness.close());
	await harness.parent.prompt("go", { source: "extension" });
	const id = [...harness.children.keys()][0];
	const child = harness.children.get(id)!;
	await until(() => !harness.engine.control.get(id)?.exiting);
	child.agent.prepareRequest = async () => { throw new Error("simulated credentials failure"); };
	await harness.engine.sendMessage({ to: id, message: "IMPORTANT unseen continuation" }, ROOT_CALLER, "lost-envelope");
	await until(() => !harness.engine.control.get(id)?.active);
	assert.equal(harness.requests.children.get(id), 1);
	const [envelope] = harness.engine.inbox(id).all();
	assert.notEqual(envelope.state, "included");
	assert.ok(harness.engine.inbox(id).undelivered().some((item) => item.id === envelope.id));
});

test("R07: a foreground Agent waits for its parked owner's final report", { timeout: 20_000 }, async (t) => {
	offline(t);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let count = 0;
	const harness = await createHarness({
		parent: foregroundParent,
		child: () => {
			const level = ++count;
			return ({ index }) => level === 1
				? index === 0 ? { tools: [{ name: "Agent", args: { description: "Nested", prompt: "wait" } }] } : { text: index === 1 ? "intermediate owner report" : "final owner report" }
				: { wait: gate, then: { text: "nested final" } };
		},
	});
	t.after(() => harness.close());
	let returned = false;
	const prompt = harness.parent.prompt("go", { source: "extension" }).then(() => { returned = true; });
	await until(() => count === 2);
	await tick();
	assert.equal(returned, false, "root must not get the interim report while the owner is parked");
	release();
	await prompt;
	const [result] = toolResultText(harness.parent, "Agent");
	assert.match(result, /final owner report/);
	assert.doesNotMatch(result, /intermediate owner report/);
	// The waited-for owner's reports stay passive: recorded for display, but they never start another root turn.
	const requests = harness.requests.parent;
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(harness.requests.parent, requests);
});

test("R08: messages to main are deduplicated and wait for the root's open dialog", { timeout: 20_000 }, async (t) => {
	offline(t);
	const harness = await createHarness({ parent: foregroundParent, child: () => () => ({ text: "child report" }) });
	t.after(() => harness.close());
	await harness.parent.prompt("go", { source: "extension" });
	const id = [...harness.children.keys()][0];
	await until(() => !harness.engine.control.get(id)?.exiting);
	await tick();
	const before = harness.requests.parent;
	harness.engine.notePrompt(true);
	const caller = { agentId: id, depth: 1, background: true, isFork: false };
	const first = await harness.engine.sendMessage({ to: "main", message: "root needs this" }, caller, "same-call");
	const second = await harness.engine.sendMessage({ to: "main", message: "root needs this" }, caller, "same-call");
	assert.equal(first.success, true);
	assert.equal(second.envelopeId, first.envelopeId);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(harness.requests.parent, before, "no root turn while the dialog is open");
	harness.engine.notePrompt(false);
	await until(() => harness.requests.parent > before);
	await until(() => !harness.parent.isStreaming);
	const delivered = harness.parent.messages.filter((message) => (message as { customType?: string }).customType === "subagent-message");
	assert.equal(delivered.length, 1);
});

test("R09: concurrent extension launches respect the per-extension cap", async () => {
	let register!: (request: unknown) => void;
	const hooks = new Map<string, (...args: unknown[]) => unknown>();
	let launches = 0;
	const slots = new Map<string, Set<string>>();
	const engine = {
		extensionAccounting(id: string) { if (!slots.has(id)) slots.set(id, new Set()); return slots.get(id)!; },
		async spawn() { await Promise.resolve(); return { text: "launched", details: { agentId: `a${++launches}` } }; },
		subscribe() { return () => {}; },
	};
	const pi = { on(event: string, handler: (...args: unknown[]) => unknown) { hooks.set(event, handler); }, events: { on(_name: string, handler: (request: unknown) => void) { register = handler; } } };
	installSpawnApi(pi as never, () => engine as never);
	hooks.get("session_start")!({}, {});
	let handle!: { spawn(params: unknown): Promise<{ isError?: boolean }>; running(): number };
	register({ extensionId: "cooperative", cap: 1, reply: (created: typeof handle) => { handle = created; } });
	const results = await Promise.all([handle.spawn({ description: "one", prompt: "a" }), handle.spawn({ description: "two", prompt: "b" })]);
	assert.equal(launches, 1);
	assert.equal(handle.running(), 1);
	assert.deepEqual(results.map((result) => Boolean(result.isError)), [false, true]);
});

test("R18 and R20: owner-acknowledged children become evictable and receipt checks skip history", { timeout: 20_000 }, async (t) => {
	offline(t);
	let now = 1_000;
	let count = 0;
	const harness = await createHarness({
		now: () => now,
		parent: foregroundParent,
		child: () => {
			const level = ++count;
			return ({ index }) => level === 1
				? index === 0 ? { tools: [{ name: "Agent", args: { description: "Nested", prompt: "quick", run_in_background: false } }] } : { text: "owner done" }
				: { text: "nested done" };
		},
	});
	t.after(() => harness.close());
	await harness.parent.prompt("go", { source: "extension" });
	const nested = [...harness.engine.control.conversations.values()].find((conversation) => conversation.meta.spawnDepth === 2)!;
	await until(() => !nested.exiting);
	assert.equal(nested.notified, true, "owner-route acknowledgement marks the child notified");
	now += 60_000;
	assert.ok(harness.engine.control.evictable().some((conversation) => conversation.meta.agentId === nested.meta.agentId));
	const outbox = (harness.engine as unknown as { outbox: { observePersisted(entries: unknown[]): string[] } }).outbox;
	const entries = harness.parent.sessionManager.getEntries();
	assert.deepEqual(outbox.observePersisted(entries as never), [], "already acknowledged notices are not re-reported");
});

function barrier() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { promise, release };
}

test("pre-push: user-stopping a parked foreground owner releases the root Agent call as killed", { timeout: 20_000 }, async t => {
	offline(t);
	const descendant = barrier();
	let count = 0;
	const harness = await createHarness({
		parent: foregroundParent,
		child: () => ++count === 1
			? ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Nested", prompt: "Wait for stop" } }] } : { text: "intermediate parked-owner report" }
			: () => ({ wait: descendant.promise, then: { text: "must not complete naturally" } }),
	});
	t.after(async () => { descendant.release(); await harness.close(); });
	let returned = false;
	const prompt = harness.parent.prompt("Start the foreground owner", { source: "extension" });
	void prompt.then(() => { returned = true; }, () => { returned = true; });
	await until(() => [...harness.engine.control.conversations.values()].some(conversation => conversation.disposition === "parked"));
	const owner = [...harness.engine.control.conversations.values()].find(conversation => conversation.meta.spawnDepth === 1)!;
	assert.equal(owner.disposition, "parked");
	assert.equal(returned, false);
	assert.equal(toolResultText(harness.parent, "Agent").length, 0);
	await harness.engine.userStop(owner.meta.agentId);
	// The descendant gate stays closed throughout this assertion. A natural
	// nested completion cannot accidentally release the foreground waiter.
	await until(() => returned);
	await prompt;
	await until(() => harness.engine.control.activeRuns() === 0);
	const result = harness.parent.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
	assert.ok(result && result.role === "toolResult");
	assert.equal((result.details as { status: string }).status, "killed");
	assert.equal((result.details as { classification: string }).classification, "killed");
	assert.doesNotMatch(JSON.stringify(result.content), /intermediate parked-owner report/);
	assert.equal(owner.disposition, "stopped");
	assert.equal(owner.meta.stoppedByUser, true);
	assert.equal(owner.meta.runs.length, 1, "a stopped parked owner does not run again to settle its caller");
	assert.equal(harness.parent.isStreaming, false);
	// The usage the owner already incurred is still attributed to the caller.
	const attributed = (result as { usage?: { totalTokens?: number } }).usage;
	assert.ok(attributed && (attributed.totalTokens ?? 0) > 0, "parked-stop keeps incurred usage");
});

test("recheck: concurrent launches from separate handles of one extension share a unique-token cap", { timeout: 20_000 }, async t => {
	offline(t);
	const hold = barrier();
	const harness = await createHarness({ parent: () => ({ text: "root" }), child: () => () => ({ wait: hold.promise, then: { text: "done" } }) });
	t.after(async () => { hold.release(); await harness.close(); });
	let register!: (request: unknown) => void;
	const hooks = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
		events: { on(_name: string, handler: (request: unknown) => void) { register = handler; } },
	};
	installSpawnApi(pi as never, () => harness.engine);
	hooks.get("session_start")!({}, harness.parent.extensionRunner.createContext());
	const handles: LauncherHandle[] = [];
	for (let i = 0; i < 3; i++) register({ extensionId: "shared", cap: 2, reply: (created: LauncherHandle) => { handles.push(created); } });
	const results = await Promise.all(handles.map((handle, i) => handle.spawn({ description: `launch ${i}`, prompt: "Wait" })));
	assert.equal(results.filter((result) => !result.isError).length, 2);
	assert.equal(harness.engine.control.activeRuns(), 2);
	hold.release();
});

test("pre-push: an expired live definition refreshes at the next write without a test-side discovery refresh", { timeout: 20_000 }, async t => {
	offline(t);
	let now = 10_000;
	const entered = barrier(), output = barrier();
	const harness = await createHarness({
		now: () => now,
		parent: ({ index }) => index === 0 ? { tools: [{ name: "Agent", args: { description: "Live worker", prompt: "Write", subagent_type: "custom", run_in_background: false } }] } : { text: "root done" },
		agentFiles: { "custom.md": "---\nname: custom\ndescription: custom\ntools: [write]\n---\nWrite." },
		child: () => ({ index }) => {
			if (index !== 0) return { text: "live worker done" };
			entered.release();
			return { wait: output.promise, then: { tools: [{ name: "write", args: { path: join(harness.root, "LIVE_REVOKED_WRITE.txt"), content: "forbidden after narrowing" } }] } };
		},
	});
	t.after(async () => { output.release(); await harness.close(); });
	const prompt = harness.parent.prompt("Run the live worker", { source: "extension" });
	await entered.promise;
	const id = [...harness.children.keys()][0];
	assert.equal(harness.engine.control.get(id)!.meta.runs.length, 1);
	assert.equal(harness.requests.children.get(id), 1);
	writeFileSync(join(harness.root, "agent", "agents", "custom.md"), "---\nname: custom\ndescription: custom\ntools: [read]\ndisallowedTools: [write]\n---\nRead only.");
	now += 2_001;
	// Deliberately do not call engine.definitions() here. The tool admission
	// boundary must discover the expired snapshot itself while this run is live.
	output.release();
	await prompt;
	const child = harness.children.get(id)!;
	const blocked = child.messages.find(message => message.role === "toolResult" && message.toolName === "write");
	assert.ok(blocked && blocked.role === "toolResult");
	assert.equal(blocked.isError, true);
	assert.match(JSON.stringify(blocked.content), /current definition.*no longer allows write/i);
	assert.equal(existsSync(join(harness.root, "LIVE_REVOKED_WRITE.txt")), false);
	assert.equal(harness.engine.control.get(id)!.meta.runs.length, 1, "revocation was checked in the original run, not a continuation");
});

test("pre-push: repeated registrations of the same extension id share their running-agent cap", { timeout: 20_000 }, async t => {
	offline(t);
	const hold = barrier();
	const harness = await createHarness({ parent: () => ({ text: "root" }), child: () => () => ({ wait: hold.promise, then: { text: "done" } }) });
	t.after(async () => { hold.release(); await harness.close(); });
	let register!: (request: unknown) => void;
	const hooks = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
		events: { on(_name: string, handler: (request: unknown) => void) { register = handler; } },
	};
	installSpawnApi(pi as never, () => harness.engine);
	hooks.get("session_start")!({}, harness.parent.extensionRunner.createContext());
	const registration = (): LauncherHandle => {
		let handle!: LauncherHandle;
		register({ extensionId: "same-honest-extension", cap: 1, reply: (created: LauncherHandle) => { handle = created; } });
		return handle;
	};
	const first = registration();
	const launched = await first.spawn({ description: "first", prompt: "Wait" });
	assert.notEqual(launched.isError, true, launched.text);
	const second = registration();
	const refused = await second.spawn({ description: "second", prompt: "Wait" });
	assert.equal(refused.isError, true);
	assert.match(refused.text, /already has 1 agents running/);
	assert.equal(first.extensionId, second.extensionId);
	assert.equal(first.running(), 1);
	assert.equal(second.running(), 1);
	assert.equal(harness.engine.control.activeRuns(), 1);
	assert.equal(harness.children.size, 1);
	hold.release();
	await until(() => harness.engine.control.activeRuns() === 0 && first.running() === 0 && second.running() === 0);
});

test("pre-push: a foreground rate-limit cutoff after text and a real tool call returns recovered partial-api", { timeout: 20_000 }, async t => {
	offline(t);
	const priorText = "Useful prior partial report";
	let recovered = false;
	const harness = await createHarness({
		parent: foregroundParent,
		child: (_id, session) => {
			session.settingsManager.applyOverrides({ retry: { enabled: false } });
			return ({ index }) => index === 0
				? { text: priorText, tools: [{ name: "read", args: { path: join(harness.root, "partial-input.txt") } }] }
				: { error: "rate_limit_error: request cutoff" };
		},
	});
	t.after(() => harness.close());
	const off = harness.engine.subscribe(event => {
		if (event.type === "settled" && event.outcome.classification === "partial-api") recovered = "foregroundRecovered" in event.outcome && event.outcome.foregroundRecovered === true;
	});
	t.after(off);
	writeFileSync(join(harness.root, "partial-input.txt"), "real tool input");
	await harness.parent.prompt("Run the foreground partial-result regression", { source: "extension" });
	const id = [...harness.children.keys()][0], child = harness.children.get(id)!;
	assert.equal(harness.requests.children.get(id), 2);
	const read = child.messages.find(message => message.role === "toolResult" && message.toolName === "read");
	assert.ok(read && read.role === "toolResult");
	assert.equal(read.isError, false, JSON.stringify(read.content));
	const result = harness.parent.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
	assert.ok(result && result.role === "toolResult");
	assert.equal(result.isError, false);
	assert.match(JSON.stringify(result.content), /Useful prior partial report/);
	assert.equal((result.details as { classification: string }).classification, "partial-api");
	assert.equal((result.details as { status: string }).status, "failed", "foreground recovery does not upgrade the run to completed");
	assert.equal(recovered, true);
	const summary = harness.engine.control.get(id)!.meta.runs[0];
	assert.equal(summary.classification, "partial-api");
	assert.equal(summary.status, "failed");
	assert.equal(summary.resultText, priorText);
});
