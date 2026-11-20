import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { claudeArgs, claudeTools, handleClaudeHook, localClaudeHook } from "../src/claude.ts";
import type { HerdrClient } from "../src/client.ts";
import { HerdrRunner, paneVerdict, type SpawnRequest } from "../src/runner.ts";
import { createHcCli, HC_AGENT_LABEL, HcError } from "../src/hc.ts";

function fixture(t: TestContext, extra: Partial<HerdrClient> = {}, now = Date.now, sleep?: (ms: number) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "herdr-claude space-'$`&-é-"));
	const live = new Map<string, string>();
	const prompts: string[] = [];
	const starts: string[][] = [];
	let closes = 0;
	const client: HerdrClient = {
		split: async () => ({ paneId: "w1:p2" }),
		createTab: async () => ({ paneId: "w1:p2", tabId: "w1:t2" }),
		startPi: async () => { throw new Error("Claude must not launch Pi"); },
		startClaude: async ({ name, paneId, args }) => { live.set(name, paneId); starts.push(args); },
		promptAgent: async (_name, text) => { prompts.push(text); },
		closePane: async () => { closes++; live.clear(); },
		isAlive: async (name) => live.has(name),
		getAgent: async (name) => live.has(name) ? { name, paneId: live.get(name) } : undefined,
		listAgents: async () => [...live].map(([name, paneId]) => ({ name, paneId })),
		listPanes: async () => [],
		showLabel: async () => {},
		...extra,
	};
	const runner = new HerdrRunner({ root, client, now, sleep });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const request: SpawnRequest = { runtime: "claude-code", prompt: "Review launch code", description: "Review launch code", subagentType: "reviewer", cwd: root, paneId: "w1:p1", runInBackground: true };
	const hook = async (event: string, data: Record<string, unknown> = {}) => {
		const record = await runner.resolve("reviewer");
		return handleClaudeHook(runner.store, record.id, { session_id: record.sessionId!, hook_event_name: event, ...data });
	};
	return { root, runner, request, prompts, starts, hook, client, live, closes: () => closes };
}

test("Claude native launch, permission blocking, final results, and resume retain immutable runs", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn({ ...f.request, model: "sonnet", thinking: "high" });
	assert.equal(f.starts.length, 1);
	assert.ok(f.starts[0].includes("--session-id"));
	assert.ok(f.starts[0].includes("sonnet"));
	assert.ok(f.starts[0].includes("--effort"));
	assert.ok(!f.starts[0].includes("--dangerously-skip-permissions"));
	assert.equal(f.prompts.length, 1);
	assert.match(f.prompts[0], /own Claude Code pane/);
	assert.equal((await f.runner.read(first)).phase, "starting");
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	assert.equal((await f.runner.read(first)).accepted, false, "receipt alone cannot confirm execution while other input hooks run");
	await f.hook("PreToolUse", { tool_name: "Read" });
	assert.equal((await f.runner.read(first)).accepted, true);
	await f.hook("PermissionRequest");
	assert.equal((await f.runner.wait(first)).phase, "blocked");
	await f.hook("PostToolUse");
	assert.equal((await f.runner.read(first)).phase, "running");
	await f.hook("Stop", { last_assistant_message: "First review" });
	assert.equal((await f.runner.wait(first)).result, "First review");
	assert.equal((await f.runner.store.notices("w1:p1"))[0].runId, first.runId);
	const second = await f.runner.resume(first.agentId, "Review follow-up");
	assert.notEqual(second.runId, first.runId);
	assert.equal(f.starts.length, 1, "resume reuses the interactive Claude conversation");
	await f.hook("Stop", { last_assistant_message: "Late first stop" });
	assert.equal((await f.runner.read(second)).phase, "starting", "old hook cannot settle a new unaccepted run");
	await f.hook("UserPromptSubmit", { prompt: f.prompts[1] });
	await f.hook("Stop", { last_assistant_message: "Second review" });
	assert.equal((await f.runner.read(first)).result, "First review");
	assert.equal((await f.runner.read(second)).result, "Second review");
	assert.equal(f.closes(), 0);
});

test("Claude hook rejects stale commands and other sessions", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	const rejected = await handleClaudeHook(f.runner.store, ref.agentId, { session_id: "another-session", hook_event_name: "UserPromptSubmit", prompt: f.prompts[0] });
	assert.equal(rejected?.decision, "block");
	assert.equal((await f.runner.read(ref)).accepted, false);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("Stop", { last_assistant_message: "Done" });
	assert.equal((await f.hook("UserPromptSubmit", { prompt: f.prompts[0] }))?.decision, "block");
});

test("Claude accepts prompt receipt after the Pi startup deadline on launch and resume", async (t) => {
	let now = Date.now() - 44_000;
	const f = fixture(t, {}, () => now);
	let ref = await f.runner.spawn(f.request);
	for (const index of [0, 1]) {
		if (index === 1) ref = await f.runner.resume(ref.agentId, "Follow-up");
		// Windows recorded the first UserPromptSubmit rejection about 22 seconds after launch.
		now += 22_000;
		await f.runner.reconcile(ref);
		assert.equal(await f.hook("UserPromptSubmit", { prompt: f.prompts[index] }), undefined);
		const received = await f.runner.read(ref);
		assert.equal(received.inputReceived, true);
		assert.equal(received.accepted, false, "receipt is not proof that Claude executed the task");
		await f.hook("Stop", { last_assistant_message: "Reviewed" });
		assert.equal((await f.runner.read(ref)).phase, "completed");
	}
});

test("Claude prompts target the verified pane and refuse a name taken in another pane", async (t) => {
	const targets: string[] = [];
	const texts: string[] = [];
	const f = fixture(t, { promptAgent: async (target, text) => { targets.push(target); texts.push(text); } });
	const first = await f.runner.spawn(f.request);
	const record = await f.runner.resolve(first.agentId);
	assert.deepEqual(targets, [record.paneId], "the prompt is submitted to the pane, not the reusable name");
	await f.hook("UserPromptSubmit", { prompt: texts[0] });
	await f.hook("PreToolUse", { tool_name: "Read" });
	await f.hook("Stop", { last_assistant_message: "done" });
	// The agent exited without notice and another process took its name elsewhere.
	f.client.getAgent = async (name) => ({ name, paneId: "w1:p99" });
	await assert.rejects(f.runner.resume(first.agentId, "Follow up"), /now in pane w1:p99, not w1:p2/);
	f.client.getAgent = async (name) => ({ name, paneId: "w1:p99", session: "another-session" });
	await assert.rejects(f.runner.resume(first.agentId, "Follow up"), /no longer running/);
	assert.equal(targets.length, 1);
	assert.equal((await f.runner.resolve(first.agentId)).currentRunId, first.runId);
	// A pane move keeps the name and session; prompts follow the agent to its new pane.
	f.client.getAgent = async (name) => ({ name, paneId: "w2:p5", session: record.sessionId });
	await f.runner.resume(first.agentId, "Follow up");
	assert.deepEqual(targets, [record.paneId, "w2:p5"]);
});

test("cancelling a moved Claude agent closes its current pane, never the old one", async (t) => {
	const targets: string[] = [];
	const texts: string[] = [];
	const closed: string[] = [];
	const f = fixture(t, {
		promptAgent: async (target, text) => { targets.push(target); texts.push(text); },
		closePane: async (paneId) => { closed.push(paneId); },
	});
	const first = await f.runner.spawn(f.request);
	const record = await f.runner.resolve(first.agentId);
	await f.hook("UserPromptSubmit", { prompt: texts[0] });
	await f.hook("PreToolUse", { tool_name: "Read" });
	await f.hook("Stop", { last_assistant_message: "done" });
	f.client.getAgent = async (name) => ({ name, paneId: "w2:p5", session: record.sessionId });
	const second = await f.runner.resume(first.agentId, "Follow up");
	await f.hook("UserPromptSubmit", { prompt: texts[1] });
	await f.hook("PreToolUse", { tool_name: "Read" });
	assert.equal((await f.runner.cancel(second)).phase, "stopped");
	assert.deepEqual(closed, ["w2:p5"]);
	assert.deepEqual(targets, [record.paneId, "w2:p5"]);
});

test("Claude cancellation confirms owned pane closure and refuses resume after exit", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("PermissionRequest");
	assert.equal((await f.runner.cancel(ref)).phase, "stopped");
	assert.equal(f.closes(), 1);
	await f.hook("Stop", { last_assistant_message: "Late completion" });
	assert.equal((await f.runner.read(ref)).phase, "stopped");
	await assert.rejects(f.runner.resume(ref.agentId, "Continue"), /no longer running/);
});

test("cancellation closes only a pane proven to run this agent's exact session", async (t) => {
	let lookAlike: string | undefined;
	const f = sessionFixture(t, { occupant: () => lookAlike });
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("PermissionRequest");
	lookAlike = `${(await f.runner.resolve(ref.agentId)).sessionId}-different.jsonl`;
	await f.runner.cancel(ref);
	assert.equal(f.closes(), 0, "a look-alike session's pane is not this agent's to close");
});

test("cancellation leaves a pane the pane lookup says runs another session", async (t) => {
	let other: string | undefined;
	const f = sessionFixture(t, { paneOccupant: () => other });
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("PermissionRequest");
	other = "someone-elses-session";
	await f.runner.cancel(ref).catch(() => undefined);
	assert.equal(f.closes(), 0);
	assert.notEqual((await f.runner.read(ref)).phase, "stopped", "cancellation stays pending rather than closing another conversation");
});

test("a kept quarantined intent is reported before any pane diagnostics", async (t) => {
	let status = "idle";
	let armed = false;
	const holder: { root?: string } = {};
	const f = sessionFixture(t, { status: () => status, onPane: () => {
		if (!armed) return;
		armed = false;
		status = "working";
		const db = new DatabaseSync(join(holder.root!, "control.sqlite"));
		db.exec("UPDATE lifecycle_guard SET allowed=0, reason='late quarantine' WHERE id=1");
		db.close();
	} });
	holder.root = f.root;
	const first = await unconfirmedFollowUp(f);
	armed = true;
	await assert.rejects(f.runner.resume(first.agentId, "Follow up again"), /lifecycle-upgrade\.mjs/);
});

test("one Claude agent's servicing failure neither stalls the others nor goes unreported", async (t) => {
	const f = fixture(t);
	await f.runner.spawn(f.request);
	await f.runner.spawn({ ...f.request, description: "Second review" });
	const calls: string[] = [];
	(f.runner as unknown as { serviceClaude(id: string): Promise<void> }).serviceClaude = async (id) => {
		calls.push(id);
		if (calls.length === 1) throw new Error("binding read failed");
	};
	await assert.rejects(f.runner.maintain(), /binding read failed/);
	assert.equal(calls.length, 2, "the second agent was still serviced");
});

test("every maintenance failure reaches the report by name, launch recovery included", async (t) => {
	const f = fixture(t);
	await f.runner.spawn(f.request);
	await f.runner.spawn({ ...f.request, description: "Second review" });
	const runner = f.runner as unknown as { serviceClaude(id: string): Promise<void>; recoverLaunches(): Promise<void> };
	runner.serviceClaude = async (id) => { throw new Error(`binding read failed for ${id}`); };
	runner.recoverLaunches = async () => { throw new Error("launch inventory unavailable"); };
	const error = await f.runner.maintain().then(() => undefined, (e: Error) => e);
	assert.ok(error instanceof AggregateError);
	assert.equal(error.errors.length, 3);
	for (const part of ["binding read failed for reviewer", "binding read failed for reviewer-2", "launch inventory unavailable"]) assert.match(error.message, new RegExp(part));
});

test("maintenance reports name the agent behind a generic error, and keep them when the placement lock fails", async (t) => {
	const f = fixture(t);
	await f.runner.spawn(f.request);
	await f.runner.spawn({ ...f.request, description: "Second review" });
	let serviced = 0;
	(f.runner as unknown as { serviceClaude(id: string): Promise<void> }).serviceClaude = async () => { serviced++; throw new Error("remote worker connection closed"); };
	// Only the lock taken for launch recovery, after both agents were serviced, fails.
	const store = f.runner.store as unknown as { tryPlacementLock(token: string): Promise<boolean> };
	const lock = store.tryPlacementLock.bind(store);
	store.tryPlacementLock = async (token) => { if (serviced >= 2) throw new Error("placement database I/O error"); return lock(token); };
	const error = await f.runner.maintain().then(() => undefined, (e: Error) => e);
	assert.ok(error instanceof AggregateError);
	assert.equal(error.errors.length, 3);
	for (const part of ["reviewer: remote worker connection closed", "reviewer-2: remote worker connection closed", "placement database I/O error"]) assert.ok(error.message.includes(part), part);
});

test("a failing recovery after a lost close reply still names the upgrade step and keeps both errors", async (t) => {
	let phase: "armed" | "closing" | "recovering" | "done" = "done";
	const holder: { root?: string } = {};
	const f = sessionFixture(t, { lingering: true });
	holder.root = f.root;
	const first = await unconfirmedFollowUp(f);
	const close = f.client.closePane;
	f.client.closePane = async (paneId) => {
		if (phase !== "armed") return close(paneId);
		phase = "recovering";
		await close(paneId);
		throw new Error("close reply lost");
	};
	const get = f.client.getAgent;
	f.client.getAgent = async (...args) => {
		if (phase !== "recovering") return get(...args);
		phase = "done";
		const db = new DatabaseSync(join(holder.root!, "control.sqlite"));
		db.exec("UPDATE lifecycle_guard SET allowed=0, reason='late quarantine' WHERE id=1");
		db.close();
		throw new Error("recovery lookup timed out");
	};
	phase = "armed";
	const error = await f.runner.resume(first.agentId, "Follow up again").then(() => undefined, (e: Error) => e);
	assert.match(error?.message ?? "", /lifecycle-upgrade\.mjs/);
	const causes = (error?.cause as AggregateError | undefined)?.errors?.map((item: Error) => item.message) ?? [];
	assert.deepEqual(causes, ["close reply lost", "recovery lookup timed out"]);
});

test("a kept intent names the upgrade step after a failed lookup or a close in flight", async (t) => {
	for (const when of ["lookup", "close"] as const) {
		await t.test(when, async (t) => {
			let armed = false;
			const holder: { root?: string; f?: ReturnType<typeof fixture> } = {};
			const quarantine = () => {
				const db = new DatabaseSync(join(holder.root!, "control.sqlite"));
				db.exec("UPDATE lifecycle_guard SET allowed=0, reason='late quarantine' WHERE id=1");
				db.close();
			};
			const f = sessionFixture(t, { lingering: when === "close", onPane: () => {
				if (!armed || when !== "lookup") return;
				armed = false;
				quarantine();
				throw new Error("lookup timed out");
			} });
			holder.root = f.root;
			const first = await unconfirmedFollowUp(f);
			if (when === "close") {
				const close = f.client.closePane;
				f.client.closePane = async (paneId) => { if (armed) { armed = false; quarantine(); } return close(paneId); };
			}
			armed = true;
			await assert.rejects(f.runner.resume(first.agentId, "Follow up again"), /lifecycle-upgrade\.mjs/);
		});
	}
});

test("Claude cancellation failure remains pending, not falsely stopped", async (t) => {
	const f = fixture(t, { closePane: async () => { throw new Error("close failed"); } });
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("PreToolUse", { tool_name: "Read" });
	await assert.rejects(f.runner.cancel(ref), /close failed/);
	const run = await f.runner.read(ref);
	assert.equal(run.cancelRequested, true);
	assert.equal(run.phase, "running");
});

test("Claude submission uncertainty is not replayed", async (t) => {
	let submissions = 0;
	const f = fixture(t, { promptAgent: async () => { submissions++; throw new Error("transport lost"); } });
	await assert.rejects(f.runner.spawn(f.request), /transport lost/);
	const record = await f.runner.resolve("reviewer");
	const ref = { agentId: record.id, runId: record.currentRunId };
	assert.equal((await f.runner.read(ref)).phase, "failed");
	await f.runner.maintain();
	assert.equal(submissions, 1);
});

test("Claude errors and session exit never report success", async (t) => {
	for (const event of ["StopFailure", "SessionEnd"]) {
		const f = fixture(t);
		const ref = await f.runner.spawn(f.request);
		await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
		await f.hook(event, { error: "authentication_failed" });
		assert.equal((await f.runner.read(ref)).phase, "failed");
	}
});

test("Unsupported Claude controls fail before opening a pane", async (t) => {
	const f = fixture(t);
	for (const extra of [{ inheritContext: true }, { maxTurns: 1 }, { thinking: "off" }]) {
		await assert.rejects(f.runner.spawn({ ...f.request, ...extra }));
	}
	assert.equal(f.starts.length, 0);
	assert.deepEqual(await f.runner.store.listAgents(), []);
	const ref = await f.runner.spawn(f.request);
	await assert.rejects(f.runner.steer(ref, "Change focus"), /Live steering is not supported/);
});

test("Claude tool selection maps built-ins without granting permission bypass", () => {
	assert.deepEqual(claudeTools(["read", "find", "ls"]), ["Read", "Glob"]);
	assert.throws(() => claudeTools(["customTool"]), /cannot enforce/);
	const args = claudeArgs({ id: "agent", allowedTools: ["read"], description: "", prompt: "", herdrName: "agent", paneId: "p", depth: 1, type: "review", createdAt: "" }, "session", localClaudeHook("/state path/'quoted"));
	assert.equal(args[args.indexOf("--tools") + 1], "Read");
	assert.ok(args.includes("--strict-mcp-config"));
	assert.ok(!args.includes("--allowedTools"));
	const hooks = JSON.parse(args[args.indexOf("--settings") + 1]).hooks;
	const entry = fileURLToPath(new URL("../src/claude-hook-entry.mjs", import.meta.url));
	for (const event of Object.keys(hooks)) {
		assert.deepEqual(hooks[event][0].hooks, [{
			type: "command", command: process.execPath, args: [entry, "/state path/'quoted", "agent"], timeout: 10,
		}], `${event} must launch Node directly, without a shell or embedded quotes`);
	}
});

test("a resolved definition replaces the agent file, keeping only grants Claude can enforce", async (t) => {
	const f = fixture(t);
	mkdirSync(join(f.root, ".pi", "agents"), { recursive: true });
	writeFileSync(join(f.root, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ntools: write\n---\nFile body\n");
	await f.runner.spawn({ ...f.request, resolved: { instructions: "Resolved body", allowedTools: ["read", "SendMessage", "mcp__docs__search", "find"] } });
	const record = await f.runner.resolve("reviewer");
	assert.equal(record.instructions, "Resolved body");
	assert.deepEqual(record.allowedTools, ["read", "find"]);
	assert.equal(f.starts[0][f.starts[0].indexOf("--tools") + 1], "Read,Glob");
});

test("Claude launch arguments carry multiline instructions only through task submission", async (t) => {
	const f = fixture(t);
	const task = { id: "reviewer", herdrName: "reviewer", paneId: "w1:p2", depth: 1, type: "reviewer", description: "Review", prompt: "Task", createdAt: "", instructions: "First paragraph\n\nSecond paragraph" };
	const args = claudeArgs(task, "session", localClaudeHook(f.root));
	assert.ok(args.every((arg) => !/[\r\n]/.test(arg)), "Herdr rejects any newline in native launch arguments");
});

test("Claude accepts paste-wrapped markers and blocks wrapped expired markers", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	const wrapped = `<pasted_content>\n${f.prompts[0]}\n</pasted_content>`;
	assert.equal(await f.hook("UserPromptSubmit", { prompt: wrapped }), undefined);
	await f.hook("Stop", { last_assistant_message: "Wrapped result" });
	assert.equal((await f.runner.read(ref)).result, "Wrapped result");
	assert.equal((await f.hook("UserPromptSubmit", { prompt: wrapped }))?.decision, "block");
});

type SessionOptions = {
	getPane?: boolean;
	/** Replaces the session the name lookup reports. */
	occupant?: () => string | undefined;
	/** Replaces the session the pane lookup reports. */
	paneOccupant?: () => string | undefined;
	/** Runs on each pane lookup, before it answers. */
	onPane?: () => void;
	/** The pane stays listed after closePane, like a pane still shutting down. */
	lingering?: boolean;
	/** Herdr reports no session at all. */
	noSession?: boolean;
	/** The pane lookup reports no session, while the name lookup does. */
	noPaneSession?: boolean;
	/** Pane activity and focus, idle and unfocused by default. */
	status?: () => string;
	focused?: () => boolean | undefined;
};

/** A client that, like Herdr, reports each pane's session from both the name and the pane lookups. */
function sessionFixture(t: TestContext, options: SessionOptions = {}) {
	const time = clock();
	const holder: { f?: ReturnType<typeof fixture> } = {};
	let closed = 0;
	// One agent per fixture; a reopened pane gets a new Herdr name, so look the agent up by its ID.
	const own = async () => options.noSession ? undefined : (await holder.f!.runner.resolve("reviewer")).sessionId;
	// Like both real clients, only the pane lookup reports focus; the name lookup carries none.
	const ref = async (name: string, paneId: string, override?: () => string | undefined) => ({
		name, paneId, session: override?.() ?? await own(), status: options.status?.() ?? "idle",
	});
	const f = fixture(t, {
		...(options.getPane === false ? {} : {
			getPane: async (paneId: string) => {
				options.onPane?.();
				const entry = [...holder.f!.live].find(([, id]) => id === paneId);
				if (!entry) return undefined;
				const found = { ...await ref(entry[0], paneId, options.paneOccupant ?? options.occupant), focused: options.focused ? options.focused() : false };
				return options.noPaneSession ? { ...found, session: undefined } : found;
			},
		}),
		getAgent: async (name) => holder.f!.live.has(name) ? ref(name, holder.f!.live.get(name)!, options.occupant) : undefined,
		listAgents: async () => Promise.all([...holder.f!.live].map(([name, paneId]) => ref(name, paneId, options.occupant))),
		...(options.lingering ? { closePane: async () => { closed++; } } : {}),
	// Bounded waits (readiness, departure) advance a fake clock, so a correct refusal costs milliseconds, not 45 s.
	}, time.now, time.sleep);
	holder.f = f;
	const fixtureCloses = f.closes;
	return Object.assign(f, { closes: () => fixtureCloses() + closed });
}

async function completedReview(f: ReturnType<typeof fixture>) {
	const first = await f.runner.spawn(f.request);
	const record = await f.runner.resolve(first.agentId);
	const transcript = join(f.root, `${record.sessionId}.jsonl`);
	writeFileSync(transcript, JSON.stringify({ sessionId: record.sessionId, cwd: f.root, uuid: "u1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "First review" }] } }) + "\n");
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0], transcript_path: transcript });
	await f.hook("Stop", { last_assistant_message: "First review" });
	await f.runner.wait(first);
	return first;
}

/** A completed first review with a saved conversation, then a follow-up that reached the pane but was never submitted. */
async function unconfirmedFollowUp(f: ReturnType<typeof fixture>) {
	const first = await completedReview(f);
	const second = await f.runner.resume(first.agentId, "Follow up");
	await f.runner.store.expireUnacceptedRun(second, (await f.runner.read(second)).deadline + 1);
	assert.equal((await f.runner.read(second)).phase, "failed");
	assert.equal(f.closes(), 0);
	return first;
}

test("an expired prompt that was never claimed keeps its healthy pane", async (t) => {
	let disputed = false;
	const f = sessionFixture(t, { paneOccupant: () => disputed ? "another-session" : undefined });
	const first = await completedReview(f);
	disputed = true;
	const second = await f.runner.resume(first.agentId, "Conflicted follow-up");
	assert.equal(f.prompts.length, 1);
	await f.runner.store.expireUnacceptedRun(second, (await f.runner.read(second)).deadline + 1);
	disputed = false;
	await f.runner.resume(first.agentId, "Try again");
	assert.equal(f.closes(), 0);
	assert.equal(f.starts.length, 1);
	assert.equal(f.prompts.length, 2);
});

test("a Claude pane whose last prompt was never confirmed is replaced, not reused", async (t) => {
	const f = sessionFixture(t);
	const first = await unconfirmedFollowUp(f);
	const third = await f.runner.resume(first.agentId, "Follow up again");
	assert.equal(f.closes(), 1, "the pane holding the unsubmitted prompt is closed");
	assert.equal(f.starts.length, 2);
	assert.equal(f.starts[1][0], "--resume", "the conversation continues in a fresh pane");
	assert.equal(f.prompts.length, 3);
	assert.equal((await f.runner.resolve(first.agentId)).paneClose, undefined, "the close intent settled");
	await f.hook("UserPromptSubmit", { prompt: f.prompts[2] });
	await f.hook("Stop", { last_assistant_message: "Third review" });
	assert.equal((await f.runner.read(third)).result, "Third review");
	// A confirmed run keeps its pane for the next follow-up.
	await f.runner.resume(first.agentId, "Again");
	assert.equal(f.closes(), 1);
	assert.equal(f.starts.length, 2);
});

test("the stale pane stays when replacing it is not allowed or not provable", async (t) => {
	for (const [label, options, quarantine] of [["quarantined lifecycle", {}, true], ["no departure evidence", { getPane: false }, false]] as const) {
		await t.test(label, async (t) => {
			const f = sessionFixture(t, options);
			const first = await unconfirmedFollowUp(f);
			if (quarantine) {
				const db = new DatabaseSync(join(f.root, "control.sqlite"));
				db.exec("UPDATE lifecycle_guard SET allowed=0, reason='test quarantine' WHERE id=1");
				db.close();
			}
			// Warm resume stays available: nothing is closed before replacement is certain.
			await f.runner.resume(first.agentId, "Follow up again");
			assert.equal(f.closes(), 0);
			assert.equal(f.starts.length, 1);
			assert.equal(f.prompts.length, 3);
		});
	}
});

test("a pane taken over after the close intent is never closed as this agent's", async (t) => {
	for (const [label, where] of [["name lookup", "occupant"], ["pane lookup", "paneOccupant"]] as const) {
		await t.test(label, async (t) => {
			// The pane changes hands after the resume first sees it, between the intent and the close.
			let lookups = 0;
			let armed = false;
			const swap = () => armed && lookups++ > 0 ? "someone-elses-session" : undefined;
			const f = sessionFixture(t, where === "occupant" ? { occupant: swap } : { paneOccupant: () => armed ? "someone-elses-session" : undefined });
			const first = await unconfirmedFollowUp(f);
			armed = true;
			await f.runner.resume(first.agentId, "Follow up again").catch(() => undefined);
			assert.equal(f.closes(), 0, "the other session's pane is untouched");
			assert.equal((await f.runner.resolve(first.agentId)).paneClose, undefined, "the intent was withdrawn: nothing was closed");
		});
	}
});

test("a close intent never outlives a decision not to close", async (t) => {
	await t.test("no session reported", async (t) => {
		const f = sessionFixture(t, { noSession: true });
		const first = await unconfirmedFollowUp(f);
		await f.runner.resume(first.agentId, "Follow up again");
		assert.equal(f.closes(), 0);
		assert.equal((await f.runner.resolve(first.agentId)).paneClose, undefined);
		await f.runner.store.expireUnacceptedRun({ agentId: first.agentId, runId: (await f.runner.resolve(first.agentId)).currentRunId }, Date.now() + 10_000_000);
		await f.runner.resume(first.agentId, "And again");
		assert.equal(f.prompts.length, 4, "later resumes still work");
	});
	await t.test("quarantine begins after the intent", async (t) => {
		let armed = false;
		const holder: { root?: string } = {};
		const f = sessionFixture(t, { onPane: () => {
			if (!armed) return;
			armed = false;
			const db = new DatabaseSync(join(holder.root!, "control.sqlite"));
			db.exec("UPDATE lifecycle_guard SET allowed=0, reason='late quarantine' WHERE id=1");
			db.close();
		} });
		holder.root = f.root;
		const first = await unconfirmedFollowUp(f);
		armed = true;
		// Like every quarantined intent, it is kept for explicit upgrade recovery: no close, nothing sent, and a clear error.
		await assert.rejects(f.runner.resume(first.agentId, "Follow up again"), /lifecycle is quarantined/);
		assert.equal(f.closes(), 0, "no close after permission was revoked");
		assert.ok((await f.runner.resolve(first.agentId)).paneClose);
		assert.equal(f.prompts.length, 2);
	});
});

test("the stale pane is kept for a received prompt, a cancelled resume and a look-alike session", async (t) => {
	await t.test("received, still working", async (t) => {
		const f = sessionFixture(t);
		const first = await f.runner.spawn(f.request);
		const record = await f.runner.resolve(first.agentId);
		const transcript = join(f.root, `${record.sessionId}.jsonl`);
		writeFileSync(transcript, JSON.stringify({ sessionId: record.sessionId, cwd: f.root, uuid: "u1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }) + "\n");
		await f.hook("UserPromptSubmit", { prompt: f.prompts[0], transcript_path: transcript });
		await f.hook("Stop", { last_assistant_message: "x" });
		const second = await f.runner.resume(first.agentId, "Long follow-up");
		await f.hook("UserPromptSubmit", { prompt: f.prompts[1] });
		await f.runner.store.expireUnacceptedRun(second, (await f.runner.read(second)).deadline + 1);
		await f.runner.resume(first.agentId, "Next");
		assert.equal(f.closes(), 0, "a prompt Claude received is not a stuck paste");
	});
	await t.test("cancelled at the close", async (t) => {
		const abort = new AbortController();
		let armed = false;
		const f = sessionFixture(t, { onPane: () => { if (armed) abort.abort(); } });
		const first = await unconfirmedFollowUp(f);
		armed = true;
		await assert.rejects(f.runner.resume(first.agentId, "Follow up again", abort.signal));
		assert.equal(f.closes(), 0);
		assert.equal((await f.runner.resolve(first.agentId)).paneClose, undefined);
	});
	await t.test("look-alike session name", async (t) => {
		const holder: { id?: string } = {};
		const lookAlike = () => holder.id ? `${holder.id}-different.jsonl` : undefined;
		const f = sessionFixture(t, { occupant: lookAlike });
		const first = await unconfirmedFollowUp(f);
		holder.id = (await f.runner.resolve(first.agentId)).sessionId;
		await f.runner.resume(first.agentId, "Follow up again").catch(() => undefined);
		assert.equal(f.closes(), 0, "a substring of the session ID is not ownership");
	});
	await t.test("name and pane lookups disagree", async (t) => {
		let armed = false;
		const f = sessionFixture(t, { paneOccupant: () => armed ? "someone-elses-session" : undefined });
		const first = await unconfirmedFollowUp(f);
		armed = true;
		await assert.rejects(f.runner.resume(first.agentId, "Follow up again"), /running another session/);
		assert.equal(f.closes(), 0);
		assert.equal(f.prompts.length, 2, "nothing was sent while Herdr disagrees about the pane");
	});
});

test("a pane in use is neither closed nor typed into, and missing pane evidence keeps it", async (t) => {
	await t.test("working on a human's turn", async (t) => {
		let status = "idle";
		const f = sessionFixture(t, { status: () => status });
		const first = await unconfirmedFollowUp(f);
		status = "working";
		await assert.rejects(f.runner.resume(first.agentId, "Follow up again"), /busy with another turn/);
		assert.equal(f.closes(), 0);
		assert.equal(f.prompts.length, 2, "nothing typed into the human's turn");
		assert.equal((await f.runner.resolve(first.agentId)).paneClose, undefined);
	});
	await t.test("activity unknown", async (t) => {
		let status = "idle";
		const f = sessionFixture(t, { status: () => status });
		const first = await unconfirmedFollowUp(f);
		status = "unknown";
		await f.runner.resume(first.agentId, "Follow up again");
		assert.equal(f.closes(), 0, "only known idle is closed");
		assert.equal(f.prompts.length, 3, "unknown activity resumes warm, as before");
	});
	await t.test("focused by the user", async (t) => {
		let focused = false;
		const f = sessionFixture(t, { focused: () => focused });
		const first = await unconfirmedFollowUp(f);
		focused = true;
		await f.runner.resume(first.agentId, "Follow up again");
		assert.equal(f.closes(), 0, "a pane the user is looking at is not closed");
		assert.equal((await f.runner.resolve(first.agentId)).paneClose, undefined);
	});
	await t.test("pane lookup without a session", async (t) => {
		const f = sessionFixture(t, { noPaneSession: true });
		const first = await unconfirmedFollowUp(f);
		await f.runner.resume(first.agentId, "Follow up again");
		assert.equal(f.closes(), 0, "uncertainty keeps the pane, as before the replacement existed");
		assert.equal(f.prompts.length, 3, "and resumes warm instead of refusing");
	});
});

test("through the Herdr app adapter, an idle stale pane is replaced", async (t) => {
	// The real hc adapter over a fake app: name lookups carry no focus, pane lookups do, and kill removes the terminal.
	const f = fixture(t, { getPane: async () => undefined });
	const first = await unconfirmedFollowUp(f);
	const record = await f.runner.resolve(first.agentId);
	const live = (name: string, paneId: string, argv: string[]) => ({
		address: paneId, labels: { [HC_AGENT_LABEL]: name }, argv, pid: 123, foreground: { pid: 123, name: "claude" }, state: "live", status: { app: "claude", state: "idle" },
	});
	let terminals = [live(record.herdrName, record.paneId, ["claude", "--session-id", record.sessionId!])];
	const stale = terminals[0];
	const alive = () => terminals.includes(stale);
	const app = createHcCli({}, {
		call: async (method, params) => {
			const address = (params as { terminal?: string }).terminal;
			if (method === "terminal.kill") { terminals = terminals.filter((item) => item.address !== address); return {}; }
			if (method === "terminal.rm") return {};
			if (method === "terminal.get") {
				const found = terminals.find((item) => item.address === address);
				if (!found) throw new HcError("gone", "not_found");
				return found;
			}
			if (method === "terminal.list") return { terminals };
			throw new Error(`unexpected ${method}`);
		},
		focus: async () => "some-other-pane",
	});
	// The reopened conversation registers its own terminal, as the app would.
	const start = f.client.startClaude!;
	f.client.startClaude = async (options) => { await start(options); terminals.push(live(options.name, options.paneId, ["claude", ...options.args])); };
	assert.equal((await app.getAgent(record.herdrName))?.focused, undefined, "the app's name lookup reports no focus");
	assert.equal((await app.getPane!(record.paneId))?.focused, false);
	Object.assign(f.client, { getAgent: app.getAgent, getPane: app.getPane, listAgents: app.listAgents, listPanes: app.listPanes, closePane: app.closePane });
	await f.runner.resume(first.agentId, "Follow up again");
	assert.equal(alive(), false, "the stale pane was closed");
	assert.equal(f.starts.at(-1)?.[0], "--resume", "and the conversation continued in a fresh pane");
});

test("a closed pane that is still shutting down never receives the follow-up", async (t) => {
	const f = sessionFixture(t, { lingering: true });
	const first = await unconfirmedFollowUp(f);
	await assert.rejects(f.runner.resume(first.agentId, "Follow up again"), /still shutting down/);
	assert.equal(f.closes(), 1);
	assert.equal(f.prompts.length, 2, "nothing was sent into the closing pane");
});

test("an unconfirmed first Claude prompt keeps its pane: there is no saved conversation to resume", async (t) => {
	const f = sessionFixture(t);
	const first = await f.runner.spawn(f.request);
	await f.runner.store.expireUnacceptedRun(first, (await f.runner.read(first)).deadline + 1);
	await f.runner.resume(first.agentId, "Follow up");
	assert.equal(f.closes(), 0);
	assert.equal(f.starts.length, 1);
});

test("one pane verdict decides every destructive close", () => {
	const record = { sessionFile: "/s/abc.jsonl", sessionId: "abc" };
	const pane = (extra: Record<string, unknown> = {}) => ({ paneId: "p1", session: "abc", status: "idle", focused: false, ...extra });
	const named = (extra: Record<string, unknown> = {}) => ({ paneId: "p1", session: "/claude/abc.jsonl", status: "idle", ...extra });
	assert.deepEqual(paneVerdict(record, "p1", named(), pane()), { identity: "ours", activity: "idle", unfocused: true });
	assert.equal(paneVerdict(record, "p1", named(), pane({ session: "other" })).identity, "pane-disagrees");
	for (const [label, n, p] of [
		["no name session", named({ session: undefined }), pane()],
		["look-alike name", named({ session: "abc-different.jsonl" }), pane()],
		["name on another pane", named({ paneId: "p2" }), pane()],
		["no pane session", named(), pane({ session: undefined })],
		["no pane", named(), undefined],
	] as const) assert.equal(paneVerdict(record, "p1", n, p).identity, "unknown", label);
	assert.equal(paneVerdict(record, "p1", named({ status: "working" }), pane()).activity, "busy");
	assert.equal(paneVerdict(record, "p1", named(), pane({ status: "blocked" })).activity, "busy");
	assert.equal(paneVerdict(record, "p1", named({ status: undefined }), pane()).activity, "unknown");
	assert.equal(paneVerdict(record, "p1", named(), pane({ focused: undefined })).unfocused, false, "missing focus is not proof");
	assert.equal(paneVerdict(record, "p1", named({ focused: true }), pane()).unfocused, false);
});

/** A clock the runner's readiness polling advances, so bounded waits run in milliseconds. */
function clock(start = Date.now()) {
	let at = start;
	return { now: () => at, sleep: async (ms: number) => { at += ms; await new Promise((resolve) => setImmediate(resolve)); }, advance: (ms: number) => { at += ms; } };
}

test("a Claude prompt waits until the pane is ready, before it is claimed", async (t) => {
	// The Herdr app reports "unknown", then idle, as a resumed Claude finishes loading its conversation.
	const time = clock();
	let lookups = 0;
	const claimedDuringWait: string[] = [];
	const holder: { f?: ReturnType<typeof fixture> } = {};
	const f = fixture(t, {
		getPane: async (paneId) => {
			lookups++;
			const record = await holder.f!.runner.resolve("reviewer").catch(() => undefined);
			if (record && lookups === 2) claimedDuringWait.push((await holder.f!.runner.read({ agentId: record.id, runId: record.currentRunId })).phase);
			return { paneId, status: lookups < 3 ? "unknown" : "idle" };
		},
	}, time.now, time.sleep);
	holder.f = f;
	await f.runner.spawn(f.request);
	assert.equal(f.prompts.length, 1, "sent once the pane reported idle");
	assert.ok(lookups >= 3);
	assert.deepEqual(claimedDuringWait, ["queued"], "nothing is claimed while waiting");
});

test("readiness is bounded: an unclassified pane gets a short grace, a busy one waits within the start window", async (t) => {
	for (const [status, maxWaitMs] of [["unknown", 16_000], ["working", 50_000]] as const) {
		await t.test(status, async (t) => {
			const time = clock();
			const started = time.now();
			const f = fixture(t, { getPane: async (paneId) => ({ paneId, status }) }, time.now, time.sleep);
			await f.runner.spawn(f.request);
			assert.equal(f.prompts.length, 1, "it sends when the wait ends");
			assert.ok(time.now() - started <= maxWaitMs, `waited ${time.now() - started} ms`);
		});
	}
});

test("readiness follows a moved agent, survives a failed lookup, and never outlives the run", async (t) => {
	await t.test("a failed status lookup is retried, not fatal", async (t) => {
		const time = clock();
		let lookups = 0;
		const f = fixture(t, { getPane: async (paneId) => { if (++lookups === 1) throw new Error("terminal.get timed out"); return { paneId, status: "idle" }; } }, time.now, time.sleep);
		const ref = await f.runner.spawn(f.request);
		assert.equal(f.prompts.length, 1);
		assert.notEqual((await f.runner.read(ref)).phase, "failed");
	});
	await t.test("a stop during the wait sends nothing", async (t) => {
		const time = clock();
		const holder: { f?: ReturnType<typeof fixture>; stopped?: boolean } = {};
		const f = fixture(t, { getPane: async (paneId) => {
			const record = await holder.f!.runner.resolve("reviewer").catch(() => undefined);
			if (record && !holder.stopped) { holder.stopped = true; await holder.f!.runner.store.requestCancellation({ agentId: record.id, runId: record.currentRunId }, time.now()); }
			return { paneId, status: holder.stopped ? "idle" : "unknown" };
		} }, time.now, time.sleep);
		holder.f = f;
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0, "a stopped run's prompt is never typed");
	});
	await t.test("a servicer that loses the claim stops waiting at once", async (t) => {
		const time = clock();
		const started = time.now();
		const holder: { f?: ReturnType<typeof fixture>; claimed?: boolean } = {};
		const f = fixture(t, { getPane: async (paneId) => {
			const record = await holder.f!.runner.resolve("reviewer").catch(() => undefined);
			// Another servicer claims the prompt while this one waits; the pane then reports a working turn.
			if (record && !holder.claimed) { holder.claimed = true; await holder.f!.runner.store.claimNextCommand(record.id, (await holder.f!.runner.store.claudeBinding(record.id))!.token, false); }
			return { paneId, status: "working" };
		} }, time.now, time.sleep);
		holder.f = f;
		await f.runner.spawn(f.request);
		assert.ok(time.now() - started < 5_000, `waited ${time.now() - started} ms after the claim`);
	});
	await t.test("a waiter whose run is replaced claims nothing of the next run", async (t) => {
		const time = clock();
		const holder: { f?: ReturnType<typeof fixture>; replaced?: boolean } = {};
		let calls = 0;
		const f = fixture(t, { getPane: async (paneId) => {
			calls++;
			const record = await holder.f!.runner.resolve("reviewer").catch(() => undefined);
			if (record && !holder.replaced) {
				holder.replaced = true;
				// Run A is stopped and run B published while A's servicer waits; the pane is busy with something else.
				const a = { agentId: record.id, runId: record.currentRunId };
				await holder.f!.runner.store.requestCancellation(a, time.now());
				await holder.f!.runner.store.beginRun(record.id, a.runId, "new task", false, time.now());
			}
			return { paneId, status: "working" };
		} }, time.now, time.sleep);
		holder.f = f;
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.ok(!f.prompts.some((text) => text.includes("new task")), "run B's prompt is not typed by A's waiter");
		assert.ok(calls >= 1);
	});
	await t.test("a pane that keeps naming another session gets nothing at the timeout", async (t) => {
		const time = clock();
		const f = fixture(t, { getPane: async (paneId) => ({ paneId, session: "someone-elses-session", status: "idle" }) }, time.now, time.sleep);
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0);
	});
	await t.test("a final lookup that outlasts the start window types nothing", async (t) => {
		const time = clock();
		let jumped = false;
		const f = fixture(t, { getPane: async (paneId) => ({ paneId, status: "idle" }) }, time.now, time.sleep);
		const get = f.client.getAgent;
		// The first name lookup after the prompt is claimed takes past the start window.
		f.client.getAgent = async (...args) => {
			const record = await f.runner.resolve("reviewer").catch(() => undefined);
			const phase = record && (await f.runner.read({ agentId: record.id, runId: record.currentRunId })).phase;
			if (phase === "starting" && !jumped) { jumped = true; time.advance(70_000); }
			return get(...args);
		};
		const ref = await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0, "nothing typed after the deadline");
		if (ref) assert.equal((await f.runner.read(ref)).phase, "failed");
	});
	await t.test("an older worker without claimPrompt claims nothing and asks for an update", async (t) => {
		const time = clock();
		const f = fixture(t, { getPane: async (paneId) => ({ paneId, status: "idle" }) }, time.now, time.sleep);
		const store = f.runner.store as unknown as { call(op: string, ...args: unknown[]): Promise<unknown> };
		const call = store.call.bind(store);
		let legacyClaims = 0;
		store.call = async (op, ...args) => {
			if (op === "claimPrompt") throw new Error("Unknown Herdr control operation");
			if (op === "claimNextCommand") legacyClaims++;
			return call(op, ...args);
		};
		await assert.rejects(f.runner.spawn(f.request), /too old to send Claude Code prompts safely/);
		assert.equal(f.prompts.length, 0);
		assert.equal(legacyClaims, 0, "no agent-scoped claim that could take another run's prompt");
	});
	await t.test("a retry with no time left still checks the pane, and a conflict there sends nothing", async (t) => {
		const time = clock();
		const f = fixture(t, { getPane: async (paneId) => ({ paneId, session: "someone-elses-session", status: "idle" }) }, time.now, time.sleep);
		const ref = await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0, "first pass leaves the prompt queued");
		// Maintenance meets it again inside the send margin, five seconds before its deadline.
		const record = await f.runner.resolve("reviewer");
		const run = await f.runner.read({ agentId: record.id, runId: record.currentRunId });
		time.advance(run.deadline - time.now() - 5_000);
		await f.runner.maintain().catch(() => undefined);
		assert.equal(f.prompts.length, 0, "an exhausted budget is not ownership evidence");
		void ref;
	});
	await t.test("a physical conflict survives a subsequent name lookup error", async (t) => {
		const time = clock();
		let failLookup = false;
		let session: string | undefined = "another-session";
		const f = fixture(t, { getPane: async (paneId) => {
			failLookup = !!session;
			return { paneId, status: "idle", session };
		} }, time.now, time.sleep);
		const get = f.client.getAgent;
		f.client.getAgent = async (name) => {
			if (failLookup) throw new Error("temporary Herdr lookup failure");
			return get(name);
		};
		await f.runner.spawn(f.request).catch(() => undefined);
		session = undefined;
		failLookup = false;
		await f.runner.maintain();
		const record = await f.runner.resolve("reviewer");
		assert.equal((await f.runner.read({ agentId: record.id, runId: record.currentRunId })).paneConflict, "w1:p2");
		assert.equal(f.prompts.length, 0);
	});
	await t.test("only a new run can send after an ownership conflict", async (t) => {
		const time = clock();
		let session: string | undefined = "another-session";
		const f = fixture(t, { getPane: async (paneId) => ({ paneId, status: "idle", session }) }, time.now, time.sleep);
		const first = await f.runner.spawn(f.request);
		session = (await f.runner.resolve("reviewer")).sessionId;
		await f.runner.maintain();
		assert.equal(f.prompts.length, 0);
		time.advance(70_000);
		await f.runner.maintain();
		assert.match((await f.runner.read(first)).error ?? "", /another session in pane w1:p2.*nothing was sent.*resume/i);
		const second = await f.runner.resume(first.agentId, "Review again");
		assert.notEqual(second.runId, first.runId);
		assert.equal((await f.runner.read(first)).paneConflict, "w1:p2");
		assert.equal((await f.runner.read(second)).paneConflict, undefined);
		assert.equal(f.prompts.length, 1);
	});
	await t.test("a known conflict survives a failed lookup on the retry", async (t) => {
		const time = clock();
		let outage = false;
		const f = fixture(t, { getPane: async (paneId) => {
			if (outage) throw new Error("terminal.get timed out");
			return { paneId, session: "someone-elses-session", status: "idle" };
		} }, time.now, time.sleep);
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0);
		const record = await f.runner.resolve("reviewer");
		const run = await f.runner.read({ agentId: record.id, runId: record.currentRunId });
		time.advance(run.deadline - time.now() - 5_000);
		outage = true;
		await f.runner.maintain().catch(() => undefined);
		assert.equal(f.prompts.length, 0, "a failed lookup does not clear a known conflict");
	});
	await t.test("a conflict seen by one runner holds for another runner of the same store", async (t) => {
		const time = clock();
		let sessionless = false;
		const f = fixture(t, { getPane: async (paneId) => sessionless ? { paneId, status: "idle" } : { paneId, session: "someone-elses-session", status: "idle" } }, time.now, time.sleep);
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0);
		// A second runner (another process) services the same run; Herdr now reports the pane with no session at all.
		sessionless = true;
		const other = new HerdrRunner({ root: f.root, client: f.client, now: time.now, sleep: time.sleep });
		t.after(() => other.close());
		await other.maintain().catch(() => undefined);
		assert.equal(f.prompts.length, 0, "no observation showed the other session left");
		const record = await f.runner.resolve("reviewer");
		assert.ok((await f.runner.read({ agentId: record.id, runId: record.currentRunId })).paneConflict, "the conflict is on the shared run");
	});
	await t.test("a waiter never clears another runner's conflict without its own evidence", async (t) => {
		const time = clock();
		const holder: { f?: ReturnType<typeof fixture>; noted?: boolean } = {};
		let polls = 0;
		const f = fixture(t, { getPane: async (paneId) => {
			polls++;
			const record = await holder.f!.runner.resolve("reviewer").catch(() => undefined);
			// While this runner waits, another runner records that the pane runs someone else's session.
			if (record && polls === 2 && !holder.noted) { holder.noted = true; await holder.f!.runner.store.notePaneConflict({ agentId: record.id, runId: record.currentRunId }, paneId); }
			return polls === 1 ? { paneId, status: "unknown" } : { paneId, status: "idle" };
		} }, time.now, time.sleep);
		holder.f = f;
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0, "a session-less observation is no evidence the other session left");
		const record = await f.runner.resolve("reviewer");
		assert.equal((await f.runner.read({ agentId: record.id, runId: record.currentRunId })).paneConflict, "w1:p2");
	});
	await t.test("a conflict after claim prevents typing", async (t) => {
		const time = clock();
		const f = fixture(t, {}, time.now, time.sleep);
		const claim = f.runner.store.claimPrompt.bind(f.runner.store);
		f.runner.store.claimPrompt = async (...args) => {
			const command = await claim(...args);
			if (command) await f.runner.store.notePaneConflict(command, "w1:p2");
			return command;
		};
		const ref = await f.runner.spawn(f.request);
		assert.equal(f.prompts.length, 0);
		assert.match((await f.runner.read(ref)).error ?? "", /another session.*nothing was typed/i);
	});
	await t.test("a sessionless return does not clear another pane's conflict", async (t) => {
		const time = clock();
		let returned = false;
		const f = fixture(t, { getPane: async (paneId) => ({ paneId, status: "idle", session: returned ? undefined : "another-session" }) }, time.now, time.sleep);
		const get = f.client.getAgent;
		f.client.getAgent = async (name) => {
			const found = await get(name);
			if (!found || returned) return found;
			return { ...found, paneId: "w1:p7", session: (await f.runner.resolve("reviewer")).sessionId };
		};
		const ref = await f.runner.spawn(f.request);
		assert.equal((await f.runner.read(ref)).paneConflict, "w1:p7");
		returned = true;
		await f.runner.maintain();
		assert.equal((await f.runner.read(ref)).paneConflict, "w1:p7");
		assert.equal(f.prompts.length, 0);
	});
	for (const mode of ["stale-move", "wrong-readiness", "lookalike", "before-claim", "after-claim"]) await t.test(mode, async (t) => {
		const time = clock();
		let polls = 0;
		const holder: { f?: ReturnType<typeof fixture> } = {};
		const f = fixture(t, { getPane: async (paneId) => {
			polls++;
			if (mode === "stale-move" && polls === 1) {
				const record = await holder.f!.runner.resolve("reviewer");
				await holder.f!.runner.store.notePaneConflict({ agentId: record.id, runId: record.currentRunId }, "w1:p7");
			}
			if (mode === "wrong-readiness" && polls === 2) time.advance(45_000);
			if (mode === "lookalike" && polls === 1 || mode === "wrong-readiness" && polls === 2) return { paneId, session: "different", status: "idle" };
			return { paneId, status: polls === 1 && ["stale-move", "wrong-readiness"].includes(mode) ? "working" : "idle" };
		} }, time.now, time.sleep);
		holder.f = f;
		const get = f.client.getAgent;
		f.client.getAgent = async (name) => {
			const found = await get(name);
			if (!found || !polls || (mode === "wrong-readiness" && polls < 2)) return found;
			const record = await f.runner.resolve("reviewer");
			if (mode === "after-claim" && (await f.runner.read({ agentId: record.id, runId: record.currentRunId })).phase !== "starting") return found;
			return { ...found, paneId: "w1:p7", session: mode === "lookalike" ? `copy-${record.sessionId}` : record.sessionId };
		};
		await f.runner.spawn(f.request).catch(() => undefined);
		const record = await f.runner.resolve("reviewer");
		const run = await f.runner.read({ agentId: record.id, runId: record.currentRunId });
		if (mode === "stale-move") assert.equal(run.paneConflict, "w1:p7");
		if (mode === "after-claim") assert.match(run.error ?? "", /pane changed.*nothing was typed/i);
		else if (mode !== "lookalike") assert.equal(run.phase, "queued");
		assert.equal(f.prompts.length, 0);
	});
	await t.test("a verified move does not clear the old pane's conflict", async (t) => {
		const time = clock();
		const holder: { f?: ReturnType<typeof fixture> } = {};
		let phase = 0;
		const f = fixture(t, { getPane: async (paneId) => {
			const record = await holder.f!.runner.resolve("reviewer");
			if (phase === 0) return { paneId, session: "someone-elses-session", status: "idle" };
			return { paneId, status: "idle" };
		} }, time.now, time.sleep);
		holder.f = f;
		await f.runner.spawn(f.request).catch(() => undefined);
		const record = await f.runner.resolve("reviewer");
		const ref = { agentId: record.id, runId: record.currentRunId };
		assert.equal((await f.runner.read(ref)).paneConflict, "w1:p2");
		// The agent is verified in w1:p7 (its own session by name); that pane reports no session.
		phase = 1;
		f.live.set(record.herdrName, "w1:p7");
		const get = f.client.getAgent;
		f.client.getAgent = async (name) => { const found = await get(name); return found && { ...found, session: record.sessionId }; };
		await f.runner.maintain().catch(() => undefined);
		assert.equal((await f.runner.read(ref)).paneConflict, "w1:p2");
		assert.equal(f.prompts.length, 0);
	});
	await t.test("a run stopped during the final read is never typed", async (t) => {
		const time = clock();
		let stopped = false;
		const f = fixture(t, { getPane: async (paneId) => ({ paneId, status: "idle" }) }, time.now, time.sleep);
		const get = f.client.getAgent;
		f.client.getAgent = async (...args) => {
			const record = await f.runner.resolve("reviewer").catch(() => undefined);
			const run = record && await f.runner.read({ agentId: record.id, runId: record.currentRunId });
			if (run?.phase === "starting" && !stopped) { stopped = true; await f.runner.store.requestCancellation(run, time.now()); }
			return get(...args);
		};
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0);
	});
	await t.test("past the start deadline nothing is sent", async (t) => {
		const time = clock();
		const f = fixture(t, { getPane: async (paneId) => { time.advance(70_000); return { paneId, status: "idle" }; } }, time.now, time.sleep);
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.equal(f.prompts.length, 0);
	});
	await t.test("a pane that changed hands is not the one written to", async (t) => {
		const time = clock();
		const holder: { f?: ReturnType<typeof fixture> } = {};
		let lookups = 0;
		const f = fixture(t, { getPane: async (paneId) => {
			lookups++;
			const record = await holder.f!.runner.resolve("reviewer");
			// The first look finds another session in the old pane; the agent now lives in w1:p7.
			if (lookups === 1) { holder.f!.live.set(record.herdrName, "w1:p7"); return { paneId, session: "someone-elses-session", status: "idle" }; }
			return { paneId, session: record.sessionId, status: "idle" };
		} }, time.now, time.sleep);
		holder.f = f;
		const targets: string[] = [];
		f.client.promptAgent = async (target, text) => { targets.push(target); f.prompts.push(text); };
		await f.runner.spawn(f.request).catch(() => undefined);
		assert.ok(!targets.includes("w1:p2") || targets.length === 0, `sent to ${targets.join(",")}`);
	});
});

test("a machine whose runner cannot claim a run's own prompt is refused before any pane opens", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-claude-machine-"));
	const starts: string[][] = [];
	const client: HerdrClient = {
		split: async () => ({ paneId: "w1:p2" }), createTab: async () => ({ paneId: "w1:p2", tabId: "w1:t2" }),
		startPi: async () => { throw new Error("no Pi"); }, startClaude: async ({ args }) => { starts.push(args); },
		promptAgent: async () => {}, closePane: async () => {}, isAlive: async () => false, getAgent: async () => undefined,
		listAgents: async () => [], listPanes: async () => [], showLabel: async () => {},
	};
	const runner = new HerdrRunner({ root, client, machine: "box" });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const store = runner.store as unknown as { call(op: string, ...args: unknown[]): Promise<unknown> };
	const call = store.call.bind(store);
	store.call = async (op, ...args) => { if (op === "claimPrompt") throw new Error("Unknown Herdr control operation"); return call(op, ...args); };
	await assert.rejects(runner.spawn({ runtime: "claude-code", prompt: "Review", description: "Review", subagentType: "reviewer", cwd: root, paneId: "w1:p1", runInBackground: true }), /too old to send Claude Code prompts safely/);
	assert.equal(starts.length, 0, "no pane was started");
	// Whatever record the reservation left, its run is settled: nothing can be typed later.
	for (const agent of await runner.store.listAgents()) {
		const run = await runner.read({ agentId: agent.id, runId: agent.currentRunId });
		assert.ok(["failed", "stopped"].includes(run.phase), `run left ${run.phase}`);
	}
});

test("Claude rejected input hooks expire rather than leaving a permanently running run", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	const received = await f.runner.read(ref);
	assert.equal(received.accepted, false);
	assert.ok(received.deadline > Date.now() + 240_000, "give slow model-only responses a bounded execution-confirmation window");
	await f.runner.store.expireUnacceptedRun(ref, received.deadline + 1);
	assert.equal((await f.runner.read(ref)).phase, "failed");
});

test("Claude overlapping approvals stay blocked until every matching tool finishes", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	const a = { tool_name: "Bash", tool_input: { command: "first", description: "A" } };
	const b = { tool_name: "Bash", tool_input: { command: "second" } };
	await f.hook("PermissionRequest", a);
	await f.hook("PermissionRequest", b);
	await f.hook("Notification", { notification_type: "permission_prompt" });
	await f.hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "unrelated" } });
	assert.equal((await f.runner.read(ref)).phase, "blocked");
	await f.hook("PostToolUse", { tool_name: "Bash", tool_input: { description: "A", command: "first" } });
	assert.equal((await f.runner.read(ref)).phase, "blocked");
	await f.hook("PostToolUseFailure", b);
	assert.equal((await f.runner.read(ref)).phase, "running");
});

test("Cancelling a resumed Claude dispatch closes the pane even after acceptance", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("Stop", { last_assistant_message: "First" });
	const abort = new AbortController();
	f.client.promptAgent = async (_name, prompt, signal) => {
		await f.hook("UserPromptSubmit", { prompt });
		await f.hook("PreToolUse", { tool_name: "Read" });
		abort.abort();
		signal!.throwIfAborted();
	};
	await assert.rejects(f.runner.resume(first.agentId, "Follow up", abort.signal), /abort/i);
	const record = await f.runner.resolve(first.agentId);
	assert.equal((await f.runner.read({ agentId: record.id, runId: record.currentRunId })).phase, "stopped");
	assert.equal(f.closes(), 1);
	assert.equal((await f.runner.read(first)).result, "First");
});

test("Cancelling Claude after input receipt but before execution confirmation closes its pane", async (t) => {
	for (const resume of [false, true]) {
		const f = fixture(t);
		let first;
		if (resume) {
			first = await f.runner.spawn(f.request);
			await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
			await f.hook("Stop", { last_assistant_message: "First" });
		}
		const abort = new AbortController();
		f.client.promptAgent = async (_name, prompt, signal) => {
			await f.hook("UserPromptSubmit", { prompt });
			abort.abort();
			signal!.throwIfAborted();
		};
		await assert.rejects(first ? f.runner.resume(first.agentId, "Follow up", abort.signal) : f.runner.spawn(f.request, abort.signal), /abort/i);
		const record = await f.runner.resolve("reviewer");
		const run = await f.runner.read({ agentId: record.id, runId: record.currentRunId });
		assert.equal(run.phase, "stopped");
		assert.equal(run.cancelRequested, true);
		assert.equal(f.closes(), 1);
	}
});

test("Durable Claude input receipt repairs a lost transport reply without accepting execution", async (t) => {
	const f = fixture(t);
	f.client.promptAgent = async (_name, prompt) => {
		await f.hook("UserPromptSubmit", { prompt });
		throw new Error("lost reply");
	};
	const ref = await f.runner.spawn(f.request);
	const run = await f.runner.read(ref);
	assert.equal(run.inputReceived, true);
	assert.equal(run.accepted, false);
	assert.equal(run.phase, "starting");
	assert.equal(f.closes(), 0);
	await f.hook("Stop", { last_assistant_message: "Recovered result" });
	assert.equal((await f.runner.read(ref)).result, "Recovered result");
});

test("Resolved tool batches clear denied and identity-free permission prompts", async (t) => {
	for (const notification of [true, false]) {
		const f = fixture(t);
		const ref = await f.runner.spawn(f.request);
		await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
		const tool = { tool_name: "Bash", tool_input: { command: "network request" } };
		await f.hook("PreToolUse", tool);
		if (notification) {
			await f.hook("Notification", { notification_type: "permission_prompt" });
			await f.hook("PostToolUse", tool);
		} else {
			await f.hook("PermissionRequest", tool);
			// A manual denial has no PostToolUseFailure, but the tool batch still settles.
		}
		assert.equal((await f.runner.read(ref)).phase, "blocked");
		await f.hook("PostToolBatch");
		assert.equal((await f.runner.read(ref)).phase, "running");
	}
});

test("Native Claude agents cannot clear each other's approvals or settle the main run", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	const tool = { tool_name: "Read", tool_input: { file_path: "same-file" } };
	await f.hook("PermissionRequest", tool);
	await f.hook("PermissionRequest", { ...tool, agent_id: "native-child" });
	await f.hook("PostToolBatch", { agent_id: "native-child" });
	assert.equal((await f.runner.read(ref)).phase, "blocked", "child batch must preserve the main approval");
	await f.hook("Stop", { agent_id: "native-child", last_assistant_message: "Child result" });
	assert.equal((await f.runner.read(ref)).phase, "blocked", "child lifecycle must not settle the main run");
	await f.hook("PostToolUse", tool);
	assert.equal((await f.runner.read(ref)).phase, "running");
	await f.hook("PermissionRequest", { ...tool, agent_id: "native-child" });
	await f.hook("PostToolBatch");
	assert.equal((await f.runner.read(ref)).phase, "blocked", "main batch must preserve the child approval");
	await f.hook("PostToolBatch", { agent_id: "native-child" });
	assert.equal((await f.runner.read(ref)).phase, "running");
	await f.hook("Stop", { last_assistant_message: "Main result" });
	assert.equal((await f.runner.read(ref)).result, "Main result");
});

test("Generated exec-form Claude hooks communicate through SQLite with native paths and shell metacharacters", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	const record = await f.runner.resolve(ref.agentId);
	const hooks = JSON.parse(f.starts[0][f.starts[0].indexOf("--settings") + 1]).hooks;
	const invoke = (event: string, data: Record<string, unknown>) => {
		const hook = hooks[event][0].hooks[0];
		return spawnSync(hook.command, hook.args, { input: JSON.stringify({ session_id: record.sessionId, hook_event_name: event, ...data }), encoding: "utf8", timeout: 15_000 });
	};
	for (const [event, data] of [["UserPromptSubmit", { prompt: f.prompts[0] }], ["Stop", { last_assistant_message: "Entry result é" }]] as const) {
		const result = invoke(event, data);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
	}
	assert.equal((await f.runner.read(ref)).result, "Entry result é");
	const stale = invoke("UserPromptSubmit", { prompt: f.prompts[0] });
	assert.equal(stale.status, 0, stale.stderr);
	assert.equal(JSON.parse(stale.stdout).decision, "block", "exec form preserves fail-closed input decisions");
});

test("a machine's Claude child runs its hooks with that machine's Node, hook entry and store", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-claude-machine-"));
	const starts: string[][] = [];
	const live = new Map<string, string>();
	const client = {
		createTab: async () => ({ paneId: "m:p2", tabId: "m:t2" }),
		startClaude: async ({ name, paneId, args }: { name: string; paneId: string; args: string[] }) => { live.set(name, paneId); starts.push(args); },
		promptAgent: async () => {},
		closePane: async () => {},
		isAlive: async (name: string) => live.has(name),
		getAgent: async (name: string) => live.has(name) ? { name, paneId: live.get(name) } : undefined,
		listAgents: async () => [...live].map(([name, paneId]) => ({ name, paneId })),
		listPanes: async () => [],
		showLabel: async () => {},
	} as unknown as HerdrClient;
	// The store answers as the machine's worker would; here it is a local worker over `root`.
	const runner = new HerdrRunner({ root, client, machine: "laptop" });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	await runner.spawn({ runtime: "claude-code", prompt: "x", description: "x", subagentType: "reviewer", cwd: root, paneId: "host/w1:p1", runInBackground: true });
	const hooks = JSON.parse(starts[0][starts[0].indexOf("--settings") + 1]).hooks.Stop[0].hooks[0];
	assert.deepEqual({ command: hooks.command, args: hooks.args.slice(0, 2) }, { command: process.execPath, args: [fileURLToPath(new URL("../src/claude-hook-entry.mjs", import.meta.url)), root] });
});
