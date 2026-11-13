import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transition } from "../src/state.ts";
import test from "node:test";
import { HerdrCliError, panesFromList, type HerdrAgentRef, type HerdrClient } from "../src/client.ts";
import { HerdrRunner, spawnHerdrAgent } from "../src/runner.ts";
import type { ChildBinding } from "../src/store.ts";

const emptyClient = () => ({ listAgents: async () => [], listPanes: async () => [], getAgent: async () => undefined, getPane: async () => undefined }) as unknown as HerdrClient;
/** A server's client that reaches `sessions` by name, like `herdr --session`. */
const withSessions = (client: HerdrClient, sessions: Record<string, HerdrClient>): HerdrClient => ({ ...client, forSession: (name) => sessions[name] });
/** A session's client while `up()` is false reports a stopped server. */
const stoppable = (client: HerdrClient, up: () => boolean): HerdrClient => {
	const guard = <T extends unknown[], R>(call: (...args: T) => Promise<R>) => async (...args: T) => {
		if (!up()) throw new HerdrCliError("no herdr server is running", "server_not_running");
		return call(...args);
	};
	return { ...client, listAgents: guard(client.listAgents), listPanes: guard(client.listPanes), getAgent: guard(client.getAgent), getPane: guard(client.getPane!) };
};

async function fixture(t: test.TestContext, options: { herdrSession?: string; keep?: boolean; closeWhenDone?: boolean; ownerSession?: boolean; runtime?: "claude-code"; machine?: string; parentPaneId?: string; workspaceId?: string; sleep?: (ms: number) => Promise<void>; owner?: { sessionFile: string; reported: string } } = {}) {
	const root = mkdtempSync(join(tmpdir(), "herdr-lifecycle-"));
	let now = 1_000_000;
	let sequence = 1;
	let binding: ChildBinding | undefined;
	const parent: HerdrAgentRef = { paneId: options.parentPaneId ?? "w1:p1", session: options.owner?.reported ?? "/owner.jsonl", focused: false };
	const panes = new Map<string, HerdrAgentRef>([[parent.paneId!, parent]]);
	const named = new Map<string, HerdrAgentRef>();
	const starts: Array<{ name: string; paneId: string; args: string[] }> = [];
	const closed: string[] = [];
	const prompts: string[] = [];
	let runner: HerdrRunner;
	const client: HerdrClient = {
		async split() { throw new Error("Unexpected split"); },
		async createTab() {
			const paneId = `w1:p${++sequence}`;
			panes.set(paneId, { paneId, focused: false, plainShell: true });
			return { paneId, tabId: "w1:t2", workspaceId: "w1" };
		},
		async startPi(start) {
			starts.push(start);
			const session = start.args[start.args.indexOf("--session") + 1];
			const header = JSON.parse(readFileSync(session, "utf8").split("\n")[0]);
			binding = await runner.store.attach(start.paneId, session, header.id);
			const pane = { paneId: start.paneId, name: start.name, session, focused: false, status: "idle" };
			named.set(start.name, pane);
			panes.set(start.paneId, pane);
		},
		async startClaude(start) {
			starts.push(start);
			const session = start.args[1];
			const pane = { paneId: start.paneId, name: start.name, session, focused: false, status: "idle" };
			named.set(start.name, pane);
			panes.set(start.paneId, pane);
		},
		async promptAgent(_target, text) { prompts.push(text); },
		async closePane(paneId) {
			closed.push(paneId);
			panes.delete(paneId);
			for (const [name, pane] of named) if (pane.paneId === paneId) named.delete(name);
		},
		async isAlive(name) { return named.has(name); },
		async getAgent(name) { return named.get(name); },
		async getPane(paneId) { return panes.get(paneId); },
		async showLabel() {},
		async listAgents() { return structuredClone([...named.values()]); },
		async listPanes() { return structuredClone([...panes.values()]); },
	};
	runner = new HerdrRunner({ root, client, now: () => now, closeWhenDone: options.closeWhenDone, machine: options.machine, herdrSession: options.herdrSession, sleep: options.sleep ?? (async (ms) => { now += ms; }) });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const ref = await runner.spawn({
		prompt: "remember this", description: "test", subagentType: "test", runtime: options.runtime,
		cwd: root, paneId: parent.paneId!, workspaceId: options.workspaceId, sessionFile: options.ownerSession === false ? undefined : options.owner?.sessionFile ?? parent.session,
		runInBackground: true, keep: options.keep, model: "test-model", thinking: "high",
		resolved: { instructions: "test instructions", allowedTools: ["read"] },
	});
	async function complete(acknowledge = true) {
		const current = await runner.resolve(ref.agentId);
		if (options.runtime) {
			const transcript = join(root, `${current.sessionId}.jsonl`);
			writeFileSync(transcript, `${JSON.stringify({ type: "assistant", sessionId: current.sessionId, cwd: root, uuid: "00000000-0000-4000-8000-000000000001", message: { role: "assistant", content: "remembered" } })}\n`);
			await runner.store.claudeHook(current.id, {
				session_id: current.sessionId!, hook_event_name: "UserPromptSubmit", prompt: prompts.at(-1), transcript_path: transcript,
			}, now);
			await runner.store.claudeHook(current.id, {
				session_id: current.sessionId!, hook_event_name: "Stop", last_assistant_message: "remembered", transcript_path: transcript,
			}, now);
			if (!(await runner.read(ref)).result) throw new Error("Claude fixture did not complete");
		} else {
			assert.ok(binding);
			await runner.store.claimNextCommand(current.id, binding.token, false);
			await runner.store.recordExecutionEvent(ref, binding.token, { type: "live" }, now);
			await runner.store.recordExecutionEvent(ref, binding.token, { type: "completed", result: "remembered" }, now);
		}
		if (acknowledge) await runner.store.acknowledgeNotice(ref.runId);
	}
	async function accept() {
		const current = await runner.resolve(ref.agentId);
		await runner.store.claimNextCommand(current.id, binding!.token, false);
		await runner.store.recordExecutionEvent(ref, binding!.token, { type: "live" }, now);
	}
	/** Pi exits: its name goes and its pane drops to a shell. */
	const kill = (...names: string[]) => {
		for (const name of names.length ? names : [...named.keys()]) {
			const pane = named.get(name);
			named.delete(name);
			if (pane?.paneId) panes.set(pane.paneId, { paneId: pane.paneId, focused: false, plainShell: true });
		}
	};
	const claim = async () => runner.store.claimNextCommand(ref.agentId, binding!.token, false);
	return { runner, client, ref, panes, named, starts, closed, complete, accept, claim, root, kill, now: () => now, advance: (ms = 901_000) => { now += ms; } };
}

test("completed panes park and resume on the same session with original settings", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const before = await f.runner.resolve(f.ref.agentId);
	f.advance();
	await f.runner.maintain();
	assert.deepEqual(f.closed, [before.paneId]);
	assert.equal((await f.runner.resolve(before.id)).paneState, "parked");
	assert.equal((await f.runner.read(f.ref)).result, "remembered");
	const next = await f.runner.resume(before.id, "what did I say?");
	assert.notEqual(next.runId, f.ref.runId);
	const after = await f.runner.resolve(before.id);
	assert.notEqual(after.paneId, before.paneId);
	assert.equal(after.sessionFile, before.sessionFile);
	assert.deepEqual(f.starts[1].args, ["--session", before.sessionFile, "--model", "test-model", "--thinking", "high"]);
	assert.deepEqual(after.allowedTools, ["read"]);
	const reopened = (await f.runner.store.launches()).filter((launch) => launch.stage === "published")[0];
	assert.equal(reopened.paneId, after.paneId);
	assert.equal(reopened.owner, f.runner.owner);
});

for (const reason of ["running", "pinned", "focused", "unknown-focus", "disabled", "missing-session", "mismatched-session", "working", "unknown-status"] as const) {
	test(`completion reaper preserves ${reason} panes`, async (t) => {
		const f = await fixture(t, { keep: reason === "pinned", closeWhenDone: reason === "disabled" ? false : undefined });
		if (reason !== "running") await f.complete();
		const record = await f.runner.resolve(f.ref.agentId);
		const pane = f.panes.get(record.paneId)!;
		if (reason === "focused") pane.focused = true;
		if (reason === "working") pane.status = "working";
		if (reason === "unknown-status") delete pane.status;
		if (reason === "unknown-focus") delete pane.focused;
		if (reason === "missing-session") delete pane.session;
		if (reason === "mismatched-session") pane.session = "/other.jsonl";
		f.advance();
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
	});
}

test("owner disappearance stops an active pinned child independently of completion closure", async (t) => {
	const f = await fixture(t, { keep: true, closeWhenDone: false });
	f.panes.delete("w1:p1");
	await f.runner.maintain();
	assert.equal(f.closed.length, 1);
	assert.equal((await f.runner.read(f.ref)).phase, "stopped");
	assert.equal((await f.runner.resolve(f.ref.agentId)).paneState, "parked");
});

test("a Claude Code owner, reported by session ID, owns children it records by transcript", async (t) => {
	const owner = { sessionFile: "/home/me/.claude/projects/-repo/1b2c3d4e-0000-4000-8000-000000000001.jsonl", reported: "1b2c3d4e-0000-4000-8000-000000000001" };
	const f = await fixture(t, { keep: true, closeWhenDone: false, owner });
	await f.runner.maintain();
	assert.notEqual((await f.runner.read(f.ref)).phase, "stopped");
	assert.deepEqual(f.closed, []);
	f.panes.delete("w1:p1");
	f.advance(10_000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "stopped");
	assert.equal(f.closed.length, 1);
});

for (const stage of ["initial", "final"] as const) {
	for (const occupant of ["shell", "agent", "malformed", "missing"] as const) {
		test(`${stage} native ${occupant} metadata ${occupant === "shell" ? "permits" : "preserves uncertainty during"} owner-gone cleanup`, async (t) => {
			const f = await fixture(t, { keep: true, closeWhenDone: false });
			const record = await f.runner.resolve(f.ref.agentId);
			const binding = (await f.runner.store.attach(record.paneId, record.sessionFile, record.sessionId!))!;
			await f.runner.store.claimNextCommand(record.id, binding.token, false);
			await f.runner.store.recordExecutionEvent(f.ref, binding.token, { type: "live" }, 1_000_000);
			f.panes.delete("w1:p1");
			const [pane] = panesFromList({ result: { panes: [{ pane_id: "w2:p10",
				...(occupant === "missing" ? {} : { agent_status: "unknown" }),
				...(occupant === "agent" ? { agent: "pi" } : occupant === "malformed" ? { agent: null } : {}),
			}] } });
			if (stage === "initial") f.panes.set("w2:p10", pane);
			else {
				const get = f.client.getAgent;
				f.client.getAgent = async (...args) => {
					const value = await get(...args);
					if ((await f.runner.resolve(record.id)).paneClose) f.panes.set("w2:p10", pane);
					return value;
				};
			}
			await f.runner.maintain();
			assert.equal((await f.runner.read(f.ref)).phase, occupant === "shell" ? "stopped" : "running");
			assert.deepEqual(f.closed, occupant === "shell" ? [record.paneId] : []);
		});
	}
}

for (const surface of ["resume", "maintenance"] as const) {
	for (const identity of ["matching", "unknown"] as const) {
		test(`${surface} close recovery preserves ${identity} moved-session execution and binding`, async (t) => {
			const f = await fixture(t, { keep: true, closeWhenDone: false });
			const record = await f.runner.resolve(f.ref.agentId);
			const binding = (await f.runner.store.attach(record.paneId, record.sessionFile, record.sessionId!))!;
			await f.runner.store.claimNextCommand(record.id, binding.token, false);
			await f.runner.store.recordExecutionEvent(f.ref, binding.token, { type: "live" }, 1_000_000);
			assert.equal(await f.runner.store.preparePaneClose(f.ref, record.paneId, true, 1_000_000), true);
			const moved = { ...f.named.get(record.herdrName)!, paneId: "w2:p10", name: "renamed-live", status: "working" };
			if (identity === "unknown") delete moved.session;
			f.named.delete(record.herdrName);
			f.panes.delete(record.paneId);
			f.named.set(moved.name, moved);
			f.panes.set(moved.paneId, moved);
			if (surface === "resume") await assert.rejects(f.runner.resume(record.id, "follow up"));
			else await f.runner.maintain();
			assert.equal((await f.runner.read(f.ref)).phase, "running");
			const recovered = await f.runner.resolve(record.id);
			assert.equal(recovered.paneState, undefined);
			assert.equal(Boolean(recovered.paneClose), identity === "unknown");
			f.advance(2000);
			await f.runner.maintain();
			assert.equal((await f.runner.read(f.ref)).phase, "running", "later maintenance must also recognize the surviving conversation");
			await f.runner.reconcile(f.ref);
			assert.equal((await f.runner.read(f.ref)).phase, "running", "explicit result reconciliation must preserve the survivor too");
			const late = await f.runner.store.recordExecutionEvent(f.ref, binding.token, { type: "completed", result: "survivor finished" }, 1_002_000);
			assert.equal(late.result, "survivor finished", "close recovery must not fence the surviving binding");
			assert.deepEqual(f.closed, []);
		});
	}
}

for (const cleanup of ["done", "owner-gone"] as const) {
	test(`a quarantined database does not prepare ${cleanup} cleanup`, async (t) => {
		const f = await fixture(t);
		if (cleanup === "done") await f.complete();
		else f.panes.delete("w1:p1");
		f.runner.store.lifecycleAllowed = async () => false;
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
		assert.equal((await f.runner.resolve(f.ref.agentId)).paneClose, undefined);
		assert.equal((await f.runner.read(f.ref)).phase, cleanup === "done" ? "completed" : "queued");
	});

	test(`quarantine enabled at the final ${cleanup} close boundary retains intent`, async (t) => {
		const f = await fixture(t);
		if (cleanup === "done") await f.complete();
		else f.panes.delete("w1:p1");
		const record = await f.runner.resolve(f.ref.agentId);
		let allowed = true;
		f.runner.store.lifecycleAllowed = async () => allowed;
		const get = f.client.getAgent;
		f.client.getAgent = async (...args) => {
			const value = await get(...args);
			if ((await f.runner.resolve(record.id)).paneClose) allowed = false;
			return value;
		};
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
		assert.ok((await f.runner.resolve(record.id)).paneClose);
		assert.equal((await f.runner.read(f.ref)).phase, cleanup === "done" ? "completed" : "queued");
	});
}

for (const occupant of ["live", "departed"] as const) {
	for (const pause of ["before", "during"] as const) {
		test(`quarantine ${pause} ${occupant} close recovery retains the run and intent`, async (t) => {
			const f = await fixture(t);
			const record = await f.runner.resolve(f.ref.agentId);
			await f.runner.store.preparePaneClose(f.ref, record.paneId, true, 1_000_000);
			if (occupant === "departed") {
				f.named.delete(record.herdrName);
				f.panes.delete(record.paneId);
			}
			let allowed = pause === "during";
			f.runner.store.lifecycleAllowed = async () => allowed;
			if (pause === "during") {
				const get = f.client.getAgent;
				f.client.getAgent = async (...args) => { allowed = false; return get(...args); };
			}
			await assert.rejects(f.runner.resume(record.id, "follow up"), /pending pane close.*lifecycle-upgrade\.mjs/);
			assert.ok((await f.runner.resolve(record.id)).paneClose);
			assert.equal((await f.runner.read(f.ref)).phase, "queued");
			assert.deepEqual(f.closed, []);
		});
	}
}

test("quarantine refuses cold resume before pane creation or startup", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	f.runner.store.lifecycleAllowed = async () => false;
	f.client.getPane = async () => { throw new Error("unavailable departure evidence must not hide the upgrade diagnostic"); };
	f.client.listAgents = async () => { throw new Error("quarantined cold resume must not probe inventory"); };
	let creates = 0;
	const create = f.client.createTab;
	f.client.createTab = async (...args) => { creates++; return create(...args); };
	await assert.rejects(f.runner.resume(record.id, "cold follow up"), /lifecycle-upgrade\.mjs/);
	assert.equal(creates, 0);
	assert.equal(f.starts.length, 1);
	assert.deepEqual(f.closed, [record.paneId]);
	assert.equal((await f.runner.resolve(record.id)).currentRunId, f.ref.runId);
	assert.equal((await f.runner.read(f.ref)).result, "remembered");
});

test("failed cold startup never closes a newer legacy-accepted run", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	const begin = f.runner.store.beginRun.bind(f.runner.store);
	const start = f.client.startPi;
	let accepted: Awaited<ReturnType<typeof begin>> | undefined;
	let token = "";
	f.client.startPi = async (...args) => {
		await start(...args);
		// A legacy parent does not honor the new placement lock or unpublished-launch guard.
		accepted = await begin(record.id, record.currentRunId, "legacy accepted follow up", true, 1_000_000);
		const current = await f.runner.resolve(record.id);
		const binding = (await f.runner.store.attach(current.paneId, current.sessionFile, current.sessionId!))!;
		token = binding.token;
		await f.runner.store.claimNextCommand(current.id, token, false);
		await f.runner.store.recordExecutionEvent(accepted, token, { type: "live" }, 1_000_000);
		throw new Error("lost cold start reply");
	};
	await assert.rejects(f.runner.resume(record.id, "new cold follow up"), /lost cold start reply/);
	assert.ok(accepted);
	const current = await f.runner.resolve(record.id);
	assert.equal(current.currentRunId, accepted.runId);
	assert.equal((await f.runner.read(accepted)).phase, "running");
	assert.deepEqual(f.closed, [record.paneId]);
	assert.equal((await f.runner.store.launches())[0].stage, "ambiguous");
	await f.runner.close();
	const survivor = new HerdrRunner({ root: record.cwd!, client: f.client, now: () => 1_002_000 });
	try {
		await survivor.reconcile();
		assert.deepEqual(f.closed, [record.paneId], "a later runner must retain the unresolved launch too");
		const late = await survivor.store.recordExecutionEvent(accepted, token, { type: "completed", result: "accepted run survived" }, 1_002_000);
		assert.equal(late.result, "accepted run survived");
	} finally { await survivor.close(); }
});

test("lost cold-start replies never reach a close boundary where legacy work could be accepted", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	const start = f.client.startPi;
	const close = f.client.closePane;
	const begin = f.runner.store.beginRun.bind(f.runner.store);
	let accepted: Awaited<ReturnType<typeof begin>> | undefined;
	let closes = 0;
	f.client.startPi = async (...args) => { await start(...args); throw new Error("lost startup response"); };
	f.client.closePane = async (paneId) => {
		closes++;
		// This would run after cleanup's record/phase check, outside the new placement lock's protection.
		accepted = await begin(record.id, record.currentRunId, "legacy accepted at close boundary", true, 1_000_000);
		await close(paneId);
	};
	await assert.rejects(f.runner.resume(record.id, "new cold attempt"), /cleanup withheld/);
	assert.equal(closes, 0);
	assert.equal(accepted, undefined);
	assert.equal((await f.runner.store.launches())[0].stage, "ambiguous");
	const current = await f.runner.resolve(record.id);
	assert.ok(f.panes.has(current.paneId));
	// The surviving process remains usable if the old caller accepts work after the failed new attempt.
	accepted = await begin(record.id, record.currentRunId, "legacy follow up after uncertain startup", true, 1_000_000);
	const binding = (await f.runner.store.attach(current.paneId, current.sessionFile, current.sessionId!))!;
	await f.runner.store.claimNextCommand(current.id, binding.token, false);
	await f.runner.store.recordExecutionEvent(accepted, binding.token, { type: "live" }, 1_000_000);
	const late = await f.runner.store.recordExecutionEvent(accepted, binding.token, { type: "completed", result: "boundary survivor result" }, 1_000_000);
	assert.equal(late.result, "boundary survivor result");
	assert.deepEqual(f.closed, [record.paneId]);
});

test("a losing new warm resume leaves a legacy winner's ownership and notice route unchanged", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.runner.store.lifecycleAllowed = async () => false;
	const before = await f.runner.resolve(f.ref.agentId);
	const begin = f.runner.store.beginRun.bind(f.runner.store);
	let accepted: Awaited<ReturnType<typeof begin>> | undefined;
	f.runner.store.beginRun = async (...args) => {
		accepted = await begin(before.id, before.currentRunId, "legacy original owner wins", true, 1_000_000);
		return begin(...args);
	};
	await assert.rejects(f.runner.resume(before.id, "new owner loses", undefined, true, {
		paneId: "w1:p99", sessionFile: "/new-owner.jsonl", tabId: "w1:t99", workspaceId: "w99",
	}));
	assert.ok(accepted);
	const after = await f.runner.resolve(before.id);
	assert.equal(after.parentPaneId, before.parentPaneId);
	assert.equal(after.parentSessionFile, before.parentSessionFile);
	assert.equal(after.parentTabId, before.parentTabId);
	assert.equal(after.parentWorkspaceId, before.parentWorkspaceId);
	assert.equal(after.parentAgentId, before.parentAgentId);
	assert.equal(after.currentRunId, accepted.runId);
	const binding = (await f.runner.store.attach(after.paneId, after.sessionFile, after.sessionId!))!;
	await f.runner.store.claimNextCommand(after.id, binding.token, false);
	await f.runner.store.recordExecutionEvent(accepted, binding.token, { type: "live" }, 1_000_000);
	await f.runner.store.recordExecutionEvent(accepted, binding.token, { type: "completed", result: "legacy winner result" }, 1_000_000);
	assert.equal((await f.runner.store.notices(before.parentPaneId!)).length, 1);
	assert.equal((await f.runner.store.notices("w1:p99")).length, 0);
	assert.deepEqual(f.closed, []);
});

test("quarantine does not gate a normal warm resume without close intent", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.runner.store.lifecycleAllowed = async () => false;
	const next = await f.runner.resume(f.ref.agentId, "continue");
	assert.equal((await f.runner.read(next)).phase, "queued");
	assert.deepEqual(f.closed, []);
});

test("absent parent identity and unknown owner session do not prove owner departure", async (t) => {
	for (const ownerSession of [true, false]) {
		const f = await fixture(t, { keep: true, ownerSession });
		if (ownerSession) delete f.panes.get("w1:p1")!.session;
		else f.panes.delete("w1:p1");
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
	}
});

test("cold resume refuses corrupt sessions and unknown live identities without creating a pane", async (t) => {
	for (const unknown of [true, false]) {
		const f = await fixture(t);
		await f.complete();
		const record = await f.runner.resolve(f.ref.agentId);
		if (unknown) f.named.set(record.herdrName, { name: record.herdrName, paneId: "w1:p999" });
		else { f.named.delete(record.herdrName); writeFileSync(record.sessionFile, "bad session"); }
		await assert.rejects(f.runner.resume(record.id, "follow up"));
		assert.equal(f.starts.length, 1);
	}
});

test("an expired maintenance lease prevents pane closure", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.advance();
	const list = f.client.listPanes;
	f.client.listPanes = async (...args) => { f.advance(6000); return list(...args); };
	await f.runner.maintain();
	assert.deepEqual(f.closed, []);
});

test("concurrent warm resumes publish only one follow-up run", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const results = await Promise.allSettled([f.runner.resume(f.ref.agentId, "one"), f.runner.resume(f.ref.agentId, "two")]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(f.starts.length, 1);
});

test("unexpected pane death during a run still fails instead of parking", async (t) => {
	const f = await fixture(t);
	const record = await f.runner.resolve(f.ref.agentId);
	f.named.delete(record.herdrName);
	f.panes.delete(record.paneId);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
	assert.equal((await f.runner.resolve(record.id)).paneState, undefined);
});

test("a moved root parent is resolved through its old pane alias", async (t) => {
	const f = await fixture(t);
	f.panes.delete("w1:p1");
	f.client.getPane = async (paneId) => paneId === "w1:p1" ? { paneId: "w2:p10", session: "/owner.jsonl" } : undefined;
	await f.runner.maintain();
	assert.deepEqual(f.closed, []);
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
});

for (const oldPane of ["absent", "replaced"] as const) {
	test(`an unmanaged owner session moved to another pane survives an ${oldPane} old alias`, async (t) => {
		const f = await fixture(t, { keep: true, closeWhenDone: false });
		f.panes.delete("w1:p1");
		if (oldPane === "replaced") f.panes.set("w1:p1", { paneId: "w1:p1", session: "/replacement.jsonl", focused: false });
		f.panes.set("w2:p10", { paneId: "w2:p10", session: "/owner.jsonl", focused: false });
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
		assert.equal((await f.runner.read(f.ref)).phase, "queued");
	});
}

for (const uncertainty of ["pane-id", "pane-session", "agent-session"] as const) {
	test(`owner-gone cleanup preserves incomplete ${uncertainty} evidence`, async (t) => {
		const f = await fixture(t, { keep: true, closeWhenDone: false });
		f.panes.delete("w1:p1");
		if (uncertainty === "pane-id") f.panes.set("unknown", { session: "/unrelated.jsonl" });
		else if (uncertainty === "pane-session") f.panes.set("w2:p10", { paneId: "w2:p10", status: "working" });
		else f.named.set("unknown", { paneId: "w2:p10", name: "unknown" });
		if (uncertainty === "pane-id") await assert.rejects(f.runner.maintain(), /incomplete listing/);
		else await f.runner.maintain();
		assert.deepEqual(f.closed, []);
		assert.equal((await f.runner.read(f.ref)).phase, "queued");
	});
}

test("an owner returning during readiness prevents an owner-gone close", async (t) => {
	const f = await fixture(t, { keep: true, closeWhenDone: false });
	f.panes.delete("w1:p1");
	const prepare = f.runner.store.preparePaneClose.bind(f.runner.store);
	f.runner.store.preparePaneClose = async (...args) => {
		const ready = await prepare(...args);
		f.panes.set("w2:p10", { paneId: "w2:p10", session: "/owner.jsonl", focused: false });
		return ready;
	};
	await f.runner.maintain();
	assert.deepEqual(f.closed, []);
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
	assert.equal((await f.runner.resolve(f.ref.agentId)).paneClose, undefined);
});

for (const returned of ["session", "unknown-old-pane", "unknown-agent"] as const) {
	test(`the final pre-close snapshot preserves a returned owner with ${returned} evidence`, async (t) => {
		const f = await fixture(t, { keep: true, closeWhenDone: false });
		f.panes.delete("w1:p1");
		const record = await f.runner.resolve(f.ref.agentId);
		const get = f.client.getAgent;
		f.client.getAgent = async (...args) => {
			const result = await get(...args);
			// The final child lookup follows preparePaneClose and the second owner-departure check.
			if (args[0] === record.herdrName && (await f.runner.resolve(record.id)).paneClose) {
				if (returned === "session") f.panes.set("w2:p10", { paneId: "w2:p10", session: "/owner.jsonl", focused: false });
				else if (returned === "unknown-old-pane") f.panes.set("w1:p1", { paneId: "w1:p1", focused: false });
				else f.panes.set("w2:p10", { paneId: "w2:p10", status: "working", focused: false });
			}
			return result;
		};
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
		assert.equal((await f.runner.read(f.ref)).phase, "queued");
		assert.equal((await f.runner.resolve(record.id)).paneClose, undefined);
	});
}

test("a parked managed parent still owns its running child", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const parent = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(parent.paneId);
	await f.runner.store.parkAgent(f.ref, parent.paneId, 1_000_000);
	const child = await f.runner.spawn({
		prompt: "nested", description: "nested", subagentType: "nested", runInBackground: true,
		cwd: parent.cwd!, paneId: parent.paneId, sessionFile: parent.sessionFile,
	});
	const before = f.closed.length;
	await f.runner.maintain();
	assert.equal(f.closed.length, before);
	assert.equal((await f.runner.read(child)).phase, "queued");
});

test("remote pane inventories cannot prove departure of the local owner", async (t) => {
	const f = await fixture(t, { machine: "remote" });
	f.panes.delete("w1:p1");
	await f.runner.maintain();
	assert.deepEqual(f.closed, []);
});

test("a finished Claude pane parks and cold-resumes using its original session ID", async (t) => {
	const f = await fixture(t, { runtime: "claude-code" });
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	f.advance();
	await f.runner.maintain();
	assert.equal(f.closed.length, 1);
	const next = await f.runner.resume(record.id, "follow up");
	assert.notEqual(next.runId, f.ref.runId);
	assert.deepEqual(f.starts[1].args.slice(0, 2), ["--resume", record.sessionId]);
	assert.equal((await f.runner.resolve(record.id)).sessionId, record.sessionId);
});

test("owner disappearance preserves active Claude to avoid destroying resumability", async (t) => {
	const f = await fixture(t, { runtime: "claude-code" });
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	const next = await f.runner.resume(record.id, "follow up");
	f.panes.delete("w1:p1");
	await f.runner.maintain();
	assert.deepEqual(f.closed, []);
	assert.equal((await f.runner.read(next)).phase, "starting");
});

test("cancelled Claude cannot resume even if Herdr still reports a live matching session", async (t) => {
	const f = await fixture(t, { runtime: "claude-code" });
	await f.runner.cancel(f.ref);
	const record = await f.runner.resolve(f.ref.agentId);
	f.named.set(record.herdrName, { paneId: record.paneId, session: record.sessionId });
	await assert.rejects(f.runner.resume(record.id, "follow up"), /cancelled conversation cannot resume/);
});

test("concurrent cold resumes open only one pane and publish only one follow-up", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	const results = await Promise.allSettled([f.runner.resume(record.id, "one"), f.runner.resume(record.id, "two")]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(f.starts.length, 2);
});

test("failed cold startup cleans up the new pane and preserves the previous result", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	f.client.startPi = async () => { throw new Error("startup failed"); };
	await assert.rejects(f.runner.resume(record.id, "follow up"), /startup failed/);
	assert.equal(f.closed.length, 2);
	assert.equal((await f.runner.read(f.ref)).result, "remembered");
	assert.equal((await f.runner.resolve(record.id)).paneState, "parked");
});

test("ambiguous cold pane creation is retained and never blindly retried", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	let attempts = 0;
	f.client.createTab = async () => { attempts++; throw new Error("lost creation reply"); };
	await assert.rejects(f.runner.resume(record.id, "follow up"), /lost creation reply/);
	assert.equal((await f.runner.store.launches())[0].stage, "ambiguous");
	assert.equal((await f.runner.store.launches())[0].paneId, undefined);
	await assert.rejects(f.runner.resume(record.id, "retry"), /earlier pane launch is unresolved/);
	assert.equal(attempts, 1);
});

for (const ownerGone of [false, true]) {
	test(`a runner killed by its own ${ownerGone ? "owner-gone" : "completion"} close leaves recoverable durable intent`, async (t) => {
		const f = await fixture(t, { keep: ownerGone });
		if (!ownerGone) await f.complete();
		else f.panes.delete("w1:p1");
		const record = await f.runner.resolve(f.ref.agentId);
		const close = f.client.closePane;
		f.client.closePane = async (paneId) => {
			assert.deepEqual((await f.runner.resolve(record.id)).paneClose, { runId: f.ref.runId, paneId: record.paneId, ownerGone });
			await close(paneId);
			void f.runner.close();
			throw new Error("runner died with its pane");
		};
		await assert.rejects(f.runner.maintain(), /runner died/);
		await f.runner.close();
		const survivor = new HerdrRunner({ root: record.cwd!, client: f.client, now: () => 3_000_000 });
		try {
			assert.ok((await survivor.resolve(record.id)).paneClose);
			await survivor.maintain();
			assert.equal((await survivor.resolve(record.id)).paneState, "parked");
			assert.equal((await survivor.resolve(record.id)).paneClose, undefined);
			assert.equal((await survivor.read(f.ref)).phase, ownerGone ? "stopped" : "completed");
		} finally { await survivor.close(); }
	});
}

test("a confirmed live pane after close failure rolls back intent without parking", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.advance();
	f.client.closePane = async () => { throw new Error("close refused"); };
	await assert.rejects(f.runner.maintain(), /close refused/);
	const record = await f.runner.resolve(f.ref.agentId);
	assert.equal(record.paneClose, undefined);
	assert.equal(record.paneState, undefined);
	assert.equal((await f.runner.read(f.ref)).phase, "completed");
});

for (const activity of ["working", "blocked", "focused"] as const) {
	for (const late of [false, true]) {
		test(`${activity} activity ${late ? "after" : "while"} a completed pane settles ${late ? "keeps it open" : "delays its close"}`, async (t) => {
			const f = await fixture(t);
			await f.complete();
			const record = await f.runner.resolve(f.ref.agentId);
			const pane = f.panes.get(record.paneId)!;
			if (activity === "focused") pane.focused = true;
			else pane.status = activity;
			f.advance(late ? 121_000 : 60_000);
			await f.runner.maintain();
			assert.deepEqual(f.closed, []);
			pane.focused = false;
			pane.status = "idle";
			f.advance(901_000);
			await f.runner.maintain();
			assert.equal(f.closed.length, late ? 0 : 1);
		});
	}
}

test("a pi that exits during startup fails its run and names the pane it left", async (t) => {
	const f = await fixture(t);
	const record = await f.runner.resolve(f.ref.agentId);
	f.kill();
	f.advance(1000);
	await f.runner.maintain();
	const run = await f.runner.read(f.ref);
	assert.equal(run.phase, "failed");
	assert.match(run.error!, new RegExp(`before accepting the task \\(Herdr pane ${record.paneId}\\)`));
});

test("a failed reap still settles the liveness it observed", async (t) => {
	const f = await fixture(t);
	f.kill();
	f.advance(1000);
	f.client.listPanes = async () => { throw new Error("listing failed"); };
	await assert.rejects(f.runner.maintain(), /listing failed/);
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("a machine's maintenance pass survives calls that outlast the local lease", async (t) => {
	const f = await fixture(t, { machine: "lappy" });
	await f.complete();
	const finished = await f.runner.resolve(f.ref.agentId);
	const dead = await f.runner.spawn({ prompt: "second", description: "second", subagentType: "test", name: "second", cwd: finished.cwd!, paneId: "w1:p1", runInBackground: true });
	f.kill((await f.runner.resolve(dead.agentId)).herdrName);
	const getAgent = f.client.getAgent;
	f.client.getAgent = async (...args) => { f.advance(6000); return getAgent(...args); };
	f.advance(1000);
	await f.runner.maintain();
	assert.deepEqual(f.closed, [finished.paneId], "the reap finished inside its lease");
	assert.equal((await f.runner.read(dead)).phase, "failed", "and its observations were saved");
	assert.equal(await f.runner.store.lifecycleAllowed(), true);
});

for (const [name, listing] of [["completes", false], ["fails", true]] as const) {
	test(`a stale dead observation cannot fail a child that advanced while the reap ${name}`, async (t) => {
		const f = await fixture(t);
		f.kill();
		f.advance(1000);
		const list = f.client.listPanes;
		f.client.listPanes = async (...args) => {
			await f.accept();
			if (listing) throw new Error("listing failed");
			return list(...args);
		};
		await f.runner.maintain().catch(() => undefined);
		assert.equal((await f.runner.read(f.ref)).phase, "running");
	});
}

test("a dead observation yields to any run change, even within one millisecond", async (t) => {
	const f = await fixture(t);
	const seen = await f.runner.read(f.ref);
	assert.equal(await f.runner.store.claimMaintenance("same-ms", seen.updatedAt + 1000), true);
	await f.accept();
	const accepted = await f.runner.read(f.ref);
	assert.notEqual(accepted.accepted, seen.accepted);
	await f.runner.store.finishMaintenance("same-ms", [{ ref: f.ref, alive: false, seen: { ...seen, updatedAt: accepted.updatedAt, phase: accepted.phase } }], seen.updatedAt + 1000);
	assert.equal((await f.runner.read(f.ref)).phase, "running");
});

test("a machine's slow pi keeps its start window on launch and on resume", async (t) => {
	const f = await fixture(t, { machine: "lappy" });
	const assertStartWindow = async (ref: typeof f.ref) => {
		f.advance(30_000);
		await f.runner.maintain();
		assert.equal((await f.runner.read(ref)).phase, "queued", "20s of startup is normal on a loaded laptop");
		f.advance(91_000);
		await f.runner.maintain();
		const run = await f.runner.read(ref);
		assert.equal(run.phase, "failed");
		assert.match(run.error!, /did not confirm task execution/);
	};
	await assertStartWindow(f.ref);
	const next = await f.runner.resume(f.ref.agentId, "again");
	await assertStartWindow(next);
});

test("dismissing a startup prompt restores a machine's start window", () => {
	const run = { agentId: "a", runId: "r", phase: "blocked", accepted: false, cancelRequested: false, deadline: 1, startTimeoutMs: 120_000, turns: 0, updatedAt: 0 } as const;
	assert.equal(transition(run, { type: "unblocked" }, 1000).deadline, 121_000);
	const { startTimeoutMs: _, ...local } = run;
	assert.equal(transition(local, { type: "unblocked" }, 1000).deadline, 16_000);
});

test("a local pi keeps the short start window", async (t) => {
	const f = await fixture(t);
	f.advance(16_000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("a session this runner cannot reach keeps its runs", async (t) => {
	const f = await fixture(t);
	await f.accept();
	const empty = { listAgents: async () => [], listPanes: async () => [], getAgent: async () => undefined, getPane: async () => undefined } as unknown as HerdrClient;
	const other = new HerdrRunner({ root: f.root, client: empty, now: f.now, herdrSession: "hermes-jobs" });
	t.after(() => other.close());
	f.advance(1000);
	await other.maintain();
	await other.reconcile(f.ref);
	assert.equal((await f.runner.read(f.ref)).phase, "running");
});

test("a run's own session can declare it dead", async (t) => {
	const f = await fixture(t, { herdrSession: "hermes-jobs" });
	const record = await f.runner.resolve(f.ref.agentId);
	assert.equal(record.herdrSession, "hermes-jobs");
	const empty = { listAgents: async () => [], listPanes: async () => [], getAgent: async () => undefined, getPane: async () => undefined } as unknown as HerdrClient;
	const standard = new HerdrRunner({ root: f.root, client: empty, now: f.now, herdrSession: "default" });
	t.after(() => standard.close());
	f.advance(1000);
	await standard.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
	f.kill();
	f.advance(2000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("a quarantined machine still settles a dead run", async (t) => {
	const f = await fixture(t, { machine: "lappy" });
	await f.accept();
	f.kill();
	const db = new DatabaseSync(join(f.root, "control.sqlite"));
	db.exec("BEGIN; INSERT OR IGNORE INTO lifecycle_writer(id) VALUES(1); UPDATE lifecycle_guard SET allowed=0 WHERE id=1; COMMIT");
	db.close();
	f.advance(1000);
	await f.runner.maintain();
	assert.equal(await f.runner.store.lifecycleAllowed(), false);
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
	assert.deepEqual(f.closed, []);
});

test("a record from before sessions were tracked belongs to the default session", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const old = new DatabaseSync(join(f.root, "control.sqlite"));
	const { data } = old.prepare("SELECT data FROM agents WHERE id=?").get(f.ref.agentId) as { data: string };
	const record = JSON.parse(data);
	delete record.herdrSession;
	const tag = old.prepare("UPDATE agents SET data=? WHERE id=?");
	old.exec("BEGIN; INSERT OR IGNORE INTO lifecycle_writer(id) VALUES(1)");
	tag.run(JSON.stringify(record), f.ref.agentId);
	old.exec("COMMIT");
	old.close();
	f.advance();
	await f.runner.maintain();
	assert.equal((await f.runner.resolve(f.ref.agentId)).paneState, "parked");
	const other = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { default: f.client }), now: f.now, herdrSession: "hermes-jobs" });
	t.after(() => other.close());
	await assert.rejects(other.resume(f.ref.agentId, "again"), /belongs to Herdr session default/);
	await f.runner.resume(f.ref.agentId, "again");
	assert.equal(f.starts.length, 2);
});

test("a machine renews its lease before a slow confirmation", async (t) => {
	const f = await fixture(t, { machine: "lappy" });
	await f.accept();
	f.kill();
	const getAgent = f.client.getAgent;
	const list = f.client.listAgents;
	f.client.listAgents = async (...args) => { f.advance(9000); return list(...args); };
	f.client.getAgent = async (...args) => { f.advance(59_500); return getAgent(...args); };
	f.advance(1000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("cold resume is refused from another Herdr session", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.advance();
	await f.runner.maintain();
	assert.equal((await f.runner.resolve(f.ref.agentId)).paneState, "parked");
	const other = new HerdrRunner({ root: f.root, client: f.client, now: f.now, herdrSession: "hermes-jobs" });
	t.after(() => other.close());
	await assert.rejects(other.resume(f.ref.agentId, "again"), /belongs to Herdr session default/);
	assert.equal(f.starts.length, 1);
});

test("any session can judge a run through the run's own session", async (t) => {
	const f = await fixture(t);
	await f.accept();
	const other = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { default: f.client }), now: f.now, herdrSession: "hermes-jobs" });
	t.after(() => other.close());
	f.advance(1000);
	await other.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "running");
	f.kill();
	f.advance(2000);
	await other.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("a stopped session's runs fail only once it stays down", async (t) => {
	const f = await fixture(t, { herdrSession: "gone" });
	await f.accept();
	let up = false;
	const survivor = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { gone: stoppable(f.client, () => up) }), now: f.now, herdrSession: "default" });
	t.after(() => survivor.close());
	const pass = async (ms: number) => { f.advance(ms); await survivor.maintain(); return (await f.runner.read(f.ref)).phase; };
	assert.equal(await pass(1000), "running");
	assert.equal(await pass(20_000), "running");
	// A handoff restarts the server in place, so it answers again and the clock restarts.
	up = true;
	assert.equal(await pass(5000), "running");
	up = false;
	assert.equal(await pass(1000), "running");
	assert.equal(await pass(29_000), "running");
	assert.equal(await pass(2000), "failed");
});

test("several slow sessions cannot expire a local pass", async (t) => {
	const f = await fixture(t);
	await f.accept();
	f.kill();
	const slow = { ...emptyClient(), listAgents: async () => { f.advance(1800); return []; } } as unknown as HerdrClient;
	for (const name of ["a", "b", "c"]) {
		const session = new HerdrRunner({ root: f.root, client: { ...f.client, isAlive: async () => false, createTab: async () => ({ paneId: `w7:p${name}`, tabId: "w7:t1" }), startPi: async () => {}, showLabel: async () => {} }, now: f.now, herdrSession: name });
		t.after(() => session.close());
		await session.spawn({ prompt: "p", description: "d", subagentType: "test", name, cwd: f.root, paneId: "w1:p1", runInBackground: true, resolved: {} });
	}
	const local = new HerdrRunner({ root: f.root, client: { ...f.client, forSession: () => slow }, now: f.now, herdrSession: "default" });
	t.after(() => local.close());
	f.advance(1000);
	await local.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("any answer from a session ends its outage", async (t) => {
	const f = await fixture(t, { herdrSession: "gone", keep: true });
	await f.complete();
	let agentsUp = false;
	const down = () => new HerdrCliError("no herdr server is running", "server_not_running");
	const flaky = { ...f.client,
		listAgents: async () => { if (!agentsUp) throw down(); return f.client.listAgents(); },
		listPanes: async () => { throw down(); },
	};
	const survivor = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { gone: flaky }), now: f.now, herdrSession: "default" });
	t.after(() => survivor.close());
	f.advance(1000);
	await survivor.maintain();
	agentsUp = true;
	f.advance(31_000);
	await survivor.maintain();
	assert.equal((await f.runner.resolve(f.ref.agentId)).paneState, undefined, "the agent listing answered, so the clock restarted");
});

test("a record marked missing still takes back a child that survived", async (t) => {
	const f = await fixture(t, { keep: true });
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	const pane = f.panes.get(record.paneId)!;
	const name = f.named.get(record.herdrName)!;
	f.kill();
	f.advance(121_000);
	await f.runner.maintain();
	assert.equal((await f.runner.resolve(record.id)).paneState, "missing");
	f.panes.set(record.paneId, pane);
	f.named.set(record.herdrName, name);
	const ref = await f.runner.resume(record.id, "again");
	assert.equal(f.starts.length, 1, "the surviving child is reused");
	assert.equal((await f.client.isAlive(record.herdrName)), true);
	assert.ok(await f.claim(), "it can take the follow-up");
	assert.equal((await f.runner.read(ref)).phase, "starting");
});

test("a reloaded child reattaches to a record marked missing", async (t) => {
	const f = await fixture(t, { keep: true });
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	f.kill();
	f.advance(121_000);
	await f.runner.maintain();
	assert.deepEqual(await f.runner.store.lifecycleCandidates(), []);
	assert.ok(await f.runner.store.attach(record.paneId, record.sessionFile, record.sessionId!));
	assert.equal((await f.runner.resolve(record.id)).paneState, undefined);
	assert.equal((await f.runner.store.lifecycleCandidates()).length, 1, "a live child's pane is reaped again");
});

test("a closed pane stays fenced: only a missing one can reattach", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	f.advance();
	await f.runner.maintain();
	assert.equal((await f.runner.resolve(record.id)).paneState, "parked");
	assert.equal(await f.runner.store.attach(record.paneId, record.sessionFile, record.sessionId!), undefined);
});

test("slow confirmations in another session cannot expire a local pass", async (t) => {
	const f = await fixture(t);
	await f.accept();
	f.kill();
	const spawnIn = async (session: string) => {
		const owner = new HerdrRunner({ root: f.root, client: { ...f.client, isAlive: async () => false, createTab: async () => ({ paneId: "w7:p1", tabId: "w7:t1" }), startPi: async () => {}, showLabel: async () => {} }, now: f.now, herdrSession: session });
		t.after(() => owner.close());
		await owner.spawn({ prompt: "p", description: "d", subagentType: "test", name: session, cwd: f.root, paneId: "w1:p1", runInBackground: true, resolved: {} });
	};
	await spawnIn("a");
	await spawnIn("b");
	const step = (ms: number, value: unknown) => async () => { f.advance(ms); return value; };
	const slow = { listAgents: step(500, []), listPanes: step(500, []), getAgent: step(2400, undefined), getPane: step(2400, undefined) } as unknown as HerdrClient;
	const local = new HerdrRunner({ root: f.root, client: { ...f.client, forSession: () => slow }, now: f.now, herdrSession: "default" });
	t.after(() => local.close());
	f.advance(1000);
	await local.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("another session's finished panes cost one listing and are left to it", async (t) => {
	const f = await fixture(t, { herdrSession: "jobs" });
	await f.complete();
	const calls: string[] = [];
	const counted = { ...emptyClient(), ...Object.fromEntries((["listAgents", "listPanes", "getAgent", "getPane", "closePane"] as const).map((name) => [name, async () => { calls.push(name); return []; }])) } as unknown as HerdrClient;
	const local = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { jobs: counted }), now: f.now, herdrSession: "default" });
	t.after(() => local.close());
	f.advance();
	await local.maintain();
	assert.deepEqual(calls, ["listAgents"]);
	assert.equal((await f.runner.resolve(f.ref.agentId)).paneState, undefined);
	f.advance(1100);
	await f.runner.maintain();
	assert.equal((await f.runner.resolve(f.ref.agentId)).paneState, "parked", "its own session closes it");
});

test("a stopped session's pending close is finished from another session", async (t) => {
	const f = await fixture(t, { herdrSession: "gone", keep: true, closeWhenDone: false });
	await f.accept();
	const record = await f.runner.resolve(f.ref.agentId);
	assert.equal(await f.runner.store.preparePaneClose(f.ref, record.paneId, true, f.now()), true);
	const survivor = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { gone: stoppable(f.client, () => false) }), now: f.now, herdrSession: "default" });
	t.after(() => survivor.close());
	f.advance(1000);
	await survivor.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "running");
	f.advance(31_000);
	await survivor.maintain();
	const settled = await f.runner.resolve(record.id);
	assert.equal(settled.paneClose, undefined);
	assert.equal(settled.paneState, "parked");
	assert.equal((await f.runner.read(f.ref)).phase, "stopped");
});

test("a liveness confirmation asks for a bounded lookup, and its timeout proves nothing", async (t) => {
	const f = await fixture(t);
	await f.accept();
	let bounded: boolean | undefined;
	const { getAgent } = f.client;
	f.client.getAgent = async (name, signal, limit) => { bounded = limit; throw new Error("timed out"); };
	f.kill();
	f.advance(1000);
	await f.runner.maintain();
	assert.equal(bounded, true);
	assert.equal((await f.runner.read(f.ref)).phase, "running");
	f.client.getAgent = getAgent;
});

test("a timeout after a brief stop proves nothing about a session", async (t) => {
	const f = await fixture(t, { herdrSession: "gone" });
	await f.accept();
	let failure: Error = new HerdrCliError("no herdr server is running", "server_not_running");
	const fail = async () => { throw failure; };
	const flaky = { ...emptyClient(), listAgents: fail, listPanes: fail, getAgent: fail, getPane: fail } as unknown as HerdrClient;
	const survivor = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { gone: flaky }), now: f.now, herdrSession: "default" });
	t.after(() => survivor.close());
	f.advance(1000);
	await survivor.maintain();
	failure = new Error("timed out");
	f.advance(31_000);
	await survivor.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "running");
	failure = new HerdrCliError("no herdr server is running", "server_not_running");
	f.advance(2000);
	await survivor.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "running", "the 30 seconds start again");
});

test("a live agent cannot be adopted from another session", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const other = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { default: f.client }), now: f.now, herdrSession: "jobs" });
	t.after(() => other.close());
	await assert.rejects(other.resume(f.ref.agentId, "again", undefined, true, { paneId: "w1:p7", sessionFile: "/foreign.jsonl" }), /belongs to Herdr session default/);
	assert.equal((await f.runner.resolve(f.ref.agentId)).parentSessionFile, "/owner.jsonl");
});

test("a finished record leaves maintenance once its session has stopped", async (t) => {
	const f = await fixture(t, { herdrSession: "gone", keep: true });
	await f.complete();
	const survivor = new HerdrRunner({ root: f.root, client: withSessions(emptyClient(), { gone: stoppable(f.client, () => false) }), now: f.now, herdrSession: "default" });
	t.after(() => survivor.close());
	f.advance(1000);
	await survivor.maintain();
	assert.equal((await f.runner.store.lifecycleCandidates()).length, 1);
	f.advance(31_000);
	await survivor.maintain();
	assert.deepEqual(await f.runner.store.lifecycleCandidates(), []);
	assert.deepEqual(f.closed, []);
});

test("a finished record whose agent left stops costing Herdr calls", async (t) => {
	const f = await fixture(t, { keep: true });
	await f.complete();
	f.kill();
	let calls = 0;
	const { getAgent, getPane } = f.client;
	f.client.getAgent = async (...args) => { calls++; return getAgent(...args); };
	f.client.getPane = async (...args) => { calls++; return getPane!(...args); };
	f.advance(1000);
	await f.runner.maintain();
	assert.equal(calls, 0);
	assert.equal((await f.runner.store.lifecycleCandidates()).length, 1, "a just-finished agent may still reappear");
	f.advance(121_000);
	await f.runner.maintain();
	assert.equal(calls, 0);
	assert.deepEqual(await f.runner.store.lifecycleCandidates(), []);
	assert.deepEqual((await f.runner.store.launches()).map((launch) => launch.stage), ["closed"]);
	await f.runner.resume(f.ref.agentId, "again");
	assert.equal(f.starts.length, 2, "it still reopens");
});

for (const occupant of ["pane", "name"]) {
	test(`a record stays while its ${occupant} has an unproven occupant`, async (t) => {
		const f = await fixture(t, { keep: true });
		await f.complete();
		const { paneId, herdrName } = await f.runner.resolve(f.ref.agentId);
		f.kill();
		if (occupant === "pane") f.panes.set(paneId, { paneId, status: "working" });
		else f.named.set(herdrName, { paneId: "w9:p9", name: herdrName });
		f.advance(121_000);
		await f.runner.maintain();
		assert.equal((await f.runner.store.lifecycleCandidates()).length, 1);
		assert.equal((await f.runner.resolve(f.ref.agentId)).paneState, undefined);
	});
}

test("placement ignores another session's launches, whose IDs mean nothing here", async (t) => {
	const f = await fixture(t, { herdrSession: "jobs", workspaceId: "w1" });
	const [theirs] = await f.runner.store.launches();
	assert.equal(theirs.herdrSession, "jobs");
	const here = new HerdrRunner({ root: f.root, now: f.now, herdrSession: "default", client: {
		...f.client, listPanes: async () => [], isAlive: async () => false, startPi: async () => {}, showLabel: async () => {},
		createTab: async () => ({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" }),
	} });
	t.after(() => here.close());
	await here.spawn({ prompt: "p", description: "d", subagentType: "test", name: "local", cwd: f.root, paneId: "w1:p1", workspaceId: "w1", runInBackground: true, resolved: {} });
	const launches = await f.runner.store.launches();
	assert.equal(launches.find((launch) => launch.agentId === theirs.agentId)?.stage, "published", "its slot is not released");
	assert.equal(launches.find((launch) => launch.agentId === "local")?.herdrSession, "default");
});

async function interrupted(f: Awaited<ReturnType<typeof fixture>>, herdrSession: string | undefined, id: string) {
	const owner = "2147483646:dead";
	const task = { ...(await f.runner.resolve(f.ref.agentId)), id, herdrName: id, paneId: "", herdrSession };
	const ref = (await f.runner.store.reserveAgent(task, join(f.root, `${id}.jsonl`), owner, f.now()))!;
	await f.runner.store.recordLaunch(ref, owner, "pane-created", { paneId: "w1:p9" }, f.now());
	return ref;
}

test("launch recovery closes a dead launch's pane in that launch's session", async (t) => {
	const f = await fixture(t);
	// The launch rows carry no session at all, as an older worker writes them.
	await interrupted(f, "jobs", "tagged");
	await interrupted(f, undefined, "untagged");
	const closed: Record<string, string[]> = { here: [], jobs: [], default: [] };
	const closes = (name: string) => ({ ...emptyClient(), closePane: async (pane: string) => { closed[name].push(pane); } });
	const here = new HerdrRunner({ root: f.root, now: f.now, herdrSession: "here", client: { ...closes("here"), forSession: (name: string) => closes(name) } as unknown as HerdrClient });
	t.after(() => here.close());
	await here.reconcile();
	assert.deepEqual(closed, { here: [], jobs: ["w1:p9"], default: ["w1:p9"] });
});

test("a machine runner leaves a launch and a run in another session alone", async (t) => {
	const f = await fixture(t, { machine: "lappy", herdrSession: "jobs" });
	assert.equal((await f.runner.resolve(f.ref.agentId)).herdrSession, "jobs");
	await f.accept();
	const ref = await interrupted(f, "other", "stranded");
	f.kill();
	let closes = 0;
	const client = { ...emptyClient(), closePane: async () => { closes++; } } as unknown as HerdrClient;
	const remote = new HerdrRunner({ root: f.root, now: f.now, machine: "lappy", client });
	t.after(() => remote.close());
	f.advance(120_000);
	await remote.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "running");
	assert.equal(closes, 0);
	assert.equal((await f.runner.store.launches()).find((launch) => launch.runId === ref.runId)?.stage, "pane-created");
});

test("cancelling Claude Code closes its pane through its own session", async (t) => {
	const f = await fixture(t, { runtime: "claude-code", herdrSession: "jobs" });
	const pane = (await f.runner.resolve(f.ref.agentId)).paneId;
	const own = { ...emptyClient(), closePane: async () => assert.fail("wrong session") } as unknown as HerdrClient;
	const other = new HerdrRunner({ root: f.root, client: withSessions(own, { jobs: f.client }), now: f.now, herdrSession: "default" });
	t.after(() => other.close());
	await other.cancel(f.ref);
	assert.deepEqual(f.closed, [pane]);
});

test("an agent confirmed alive still meets its start deadline", async (t) => {
	const f = await fixture(t);
	f.client.listAgents = async () => [];
	f.advance(16_000);
	await f.runner.maintain();
	const run = await f.runner.read(f.ref);
	assert.equal(run.phase, "failed");
	assert.match(run.error!, /did not confirm task execution/);
});

test("a name reused in the same pane does not confirm a dead agent", async (t) => {
	const f = await fixture(t);
	await f.accept();
	const { paneId, herdrName } = await f.runner.resolve(f.ref.agentId);
	f.client.listAgents = async () => [];
	f.client.getAgent = async () => ({ name: herdrName, paneId });
	f.client.getPane = async () => ({ paneId, session: "/elsewhere/other.jsonl" });
	f.advance(1000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "failed");
});

test("a failed confirmation leaves that run undecided and others still settle", async (t) => {
	const f = await fixture(t);
	const { cwd } = await f.runner.resolve(f.ref.agentId);
	const dead = await f.runner.spawn({ prompt: "second", description: "second", subagentType: "test", name: "second", cwd: cwd!, paneId: "w1:p1", runInBackground: true });
	const second = (await f.runner.resolve(dead.agentId)).herdrName;
	const first = (await f.runner.resolve(f.ref.agentId)).herdrName;
	f.kill();
	const getAgent = f.client.getAgent;
	f.client.getAgent = async (name, signal) => { if (name === first) throw new Error("lookup timeout"); return getAgent(name, signal); };
	f.advance(1000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
	assert.equal((await f.runner.read(dead)).phase, "failed", second);
});

test("explicit reconciliation also confirms before failing a run", async (t) => {
	const f = await fixture(t);
	await f.accept();
	f.client.listAgents = async () => [];
	f.client.getAgent = async () => undefined;
	f.advance(1000);
	await f.runner.reconcile(f.ref);
	assert.equal((await f.runner.read(f.ref)).phase, "running");
});

test("one listing that omits a live agent cannot fail its run", async (t) => {
	const f = await fixture(t);
	await f.accept();
	const list = f.client.listAgents;
	f.client.listAgents = async () => [];
	f.advance(1000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "running", "the named agent still answers");
	const getAgent = f.client.getAgent;
	f.client.getAgent = async () => undefined;
	f.advance(2000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "running", "the pane still holds its session");
	f.client.listAgents = list;
	f.client.getAgent = getAgent;
});

test("a machine runner leaves a local definition's model to that machine's default", async (t) => {
	const f = await fixture(t, { machine: "lappy" });
	const agentDir = join(f.root, "agent");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "local-model.md"), "---\nname: local-model\ndescription: local\nmodel: claude-sonnet-5-5\n---\nWork.");
	const spawn = { prompt: "work", description: "work", subagentType: "local-model", cwd: f.root, paneId: "w1:p1", runInBackground: true, agentDir };
	await f.runner.spawn({ ...spawn, name: "default" });
	await f.runner.spawn({ ...spawn, name: "named", model: "openai-codex/gpt-6.1-sol" });
	assert.equal(f.starts[1].args.includes("--model"), false);
	assert.equal(f.starts[2].args[f.starts[2].args.indexOf("--model") + 1], "openai-codex/gpt-6.1-sol");
});

test("a local pass over many records outlasts one lease and still saves its observations", async (t) => {
	const f = await fixture(t);
	const { cwd } = await f.runner.resolve(f.ref.agentId);
	const spawn = (name: string) => f.runner.spawn({ prompt: name, description: name, subagentType: "test", name, cwd: cwd!, paneId: "w1:p1", runInBackground: true, sessionFile: "/owner.jsonl" });
	await spawn("second");
	const dead = await spawn("third");
	f.kill((await f.runner.resolve(dead.agentId)).herdrName);
	const getPane = f.client.getPane!;
	f.client.getPane = async (...args) => { f.advance(3000); return getPane(...args); };
	f.advance(1000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(dead)).phase, "failed");
});

test("a machine pass renews before each slow step, however its time is spent", async (t) => {
	for (const [before, steps] of [[0, [29_000, 32_000]], [42_000, [19_000]], [0, [900, 59_500]], [0, [9000, 9000, 9000, 9000, 9000, 9000, 9000, 9000]]] as const) {
		const f = await fixture(t, { machine: "lappy", keep: true });
		await f.complete();
		const { cwd } = await f.runner.resolve(f.ref.agentId);
		const spawn = (name: string) => f.runner.spawn({ prompt: name, description: name, subagentType: "test", name, cwd: cwd!, paneId: "w1:p1", runInBackground: true });
		await f.runner.store.recordPaneClosed(await spawn("finished"), 1_000_000);
		const dead = await spawn("dead");
		f.kill((await f.runner.resolve(dead.agentId)).herdrName);
		const listPanes = f.client.listPanes;
		f.client.listPanes = async (...args) => { f.advance(before); f.client.listPanes = listPanes; return listPanes(...args); };
		const getAgent = f.client.getAgent;
		const remaining: number[] = [...steps];
		f.client.getAgent = async (...args) => { f.advance(remaining.shift() ?? 0); return getAgent(...args); };
		f.advance(1000);
		await f.runner.maintain();
		assert.equal((await f.runner.read(dead)).phase, "failed", `setup ${before}ms, steps ${steps}`);
	}
});

test("renewing a maintenance lease keeps peers out and the pass valid", async (t) => {
	const f = await fixture(t);
	const now = Date.now();
	assert.equal(await f.runner.store.claimMaintenance("holder", now, 60_000), true);
	assert.equal(await f.runner.store.maintenanceValid("holder", now + 50_000, 60_000), true);
	assert.equal(await f.runner.store.claimMaintenance("peer", now + 70_000), false);
	assert.equal(await f.runner.store.finishMaintenance("holder", [], now + 100_000), true);
	assert.equal(await f.runner.store.maintenanceValid("holder", now + 100_001, 60_000), false, "a finished lease cannot be renewed");
	assert.equal(await f.runner.store.lifecycleAllowed(), true, "renewal is a recognized writer, so it cannot trip the legacy guard");
});

test("close intent preserves an active binding and fences liveness failure until settlement", async (t) => {
	const f = await fixture(t);
	const record = await f.runner.resolve(f.ref.agentId);
	const binding = (await f.runner.store.attach(record.paneId, record.sessionFile, record.sessionId!))!;
	assert.equal(await f.runner.store.preparePaneClose(f.ref, record.paneId, true, 1_000_000), true);
	assert.ok(await f.runner.store.claimNextCommand(record.id, binding.token, false), "preparing closure must not fence a surviving child");
	const phase = (await f.runner.read(f.ref)).phase;
	await f.runner.store.recordPaneClosed(f.ref, 2_000_000);
	assert.equal((await f.runner.read(f.ref)).phase, phase);
	assert.equal(await f.runner.store.claimMaintenance("intent-test", 2_000_000), true);
	await f.runner.store.finishMaintenance("intent-test", [{ ref: f.ref, alive: false }], 2_000_000);
	assert.equal((await f.runner.read(f.ref)).phase, phase);
	await f.runner.store.abortPaneClose(f.ref, record.paneId);
	assert.equal((await f.runner.resolve(record.id)).paneClose, undefined);
});

test("pending terminal closure fences direct mutations and resume rolls back a positively live close", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	assert.equal(await f.runner.store.preparePaneClose(f.ref, record.paneId, false, 1_000_000), true);
	await assert.rejects(f.runner.store.beginRun(record.id, f.ref.runId, "bypass", true, 1_000_000));
	await assert.rejects(f.runner.store.rebindPane(record.id, f.ref.runId, "w1:p999", record.herdrName));
	const next = await f.runner.resume(record.id, "follow up");
	assert.notEqual(next.runId, f.ref.runId);
	assert.equal((await f.runner.resolve(record.id)).paneClose, undefined);
	assert.equal(f.starts.length, 1);
});

test("a lost close reply settles the durable intent when closure is positively confirmed", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.advance();
	const close = f.client.closePane;
	f.client.closePane = async (paneId) => { await close(paneId); throw new Error("lost close reply"); };
	await assert.rejects(f.runner.maintain(), /lost close reply/);
	const record = await f.runner.resolve(f.ref.agentId);
	assert.equal(record.paneState, "parked");
	assert.equal(record.paneClose, undefined);
});

test("unknown presence retains close intent and never becomes a false pane-death failure", async (t) => {
	const f = await fixture(t);
	const record = await f.runner.resolve(f.ref.agentId);
	await f.runner.store.preparePaneClose(f.ref, record.paneId, true, 1_000_000);
	delete f.panes.get(record.paneId)!.session;
	f.named.set(record.herdrName, { paneId: "w1:p999" });
	await f.runner.maintain();
	assert.ok((await f.runner.resolve(record.id)).paneClose);
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
	assert.deepEqual(f.closed, []);
});

test("close-intent recovery settles departure without closing a replacement session", async (t) => {
	const f = await fixture(t);
	const record = await f.runner.resolve(f.ref.agentId);
	await f.runner.store.preparePaneClose(f.ref, record.paneId, true, 1_000_000);
	const replacement = { paneId: record.paneId, session: "/other.jsonl" };
	f.named.set(record.herdrName, replacement);
	f.panes.set(record.paneId, replacement);
	await f.runner.maintain();
	assert.equal((await f.runner.resolve(record.id)).paneState, "parked");
	assert.equal((await f.runner.read(f.ref)).phase, "stopped");
	assert.deepEqual(f.closed, []);
});

test("target-host maintenance preserves remotely owned pinned running children", async (t) => {
	for (const legacyKey of [false, true]) {
		const f = await fixture(t, { keep: true, machine: legacyKey ? undefined : "remote", parentPaneId: legacyKey ? "caller-host/w1:p1" : undefined });
		const record = await f.runner.resolve(f.ref.agentId);
		f.panes.delete(legacyKey ? "caller-host/w1:p1" : "w1:p1");
		const binding = (await f.runner.store.attach(record.paneId, record.sessionFile, record.sessionId!))!;
		await f.runner.store.claimNextCommand(record.id, binding.token, false);
		await f.runner.store.recordExecutionEvent(f.ref, binding.token, { type: "live" }, 1_000_000);
		const local = new HerdrRunner({ root: record.cwd!, client: f.client, now: () => 2_000_000 });
		try {
			await local.maintain();
			assert.deepEqual(f.closed, []);
			assert.equal((await local.read(f.ref)).phase, "running");
		} finally { await local.close(); }
	}
});

for (const policy of [false, true]) {
	test(`target-host maintenance retains the owner's closeWhenDone ${policy} policy`, async (t) => {
		const f = await fixture(t, { closeWhenDone: policy });
		const record = await f.runner.resolve(f.ref.agentId);
		assert.equal(record.closeWhenDone, policy);
		f.runner.maintain = async () => {};
		await f.complete();
		const local = new HerdrRunner({ root: record.cwd!, client: f.client, now: () => 1_000_000, closeWhenDone: !policy });
		try {
			await local.maintain();
			assert.equal(f.closed.length, policy ? 1 : 0);
		} finally { await local.close(); }
	});
}

for (const legacy of [0, 900]) {
	test(`a legacy ${legacy}-second idle policy ${legacy ? "closes" : "keeps"} completed panes`, async (t) => {
		const f = await fixture(t);
		const record = await f.runner.resolve(f.ref.agentId);
		const file = readdirSync(record.cwd!, { recursive: true }).map(String).find((name) => name.endsWith("control.sqlite"))!;
		const db = new DatabaseSync(join(record.cwd!, file));
		try {
			db.prepare("UPDATE agents SET data=json_set(json_remove(data,'$.closeWhenDone'),'$.idleCloseSeconds',?) WHERE id=?").run(legacy, record.id);
		} finally { db.close(); }
		// The foreign write quarantines lifecycle like an old worker's would.
		await f.runner.store.confirmLifecycleUpgrade("all-old-workers-stopped");
		await f.complete();
		await f.runner.maintain();
		assert.equal(f.closed.length, legacy ? 1 : 0);
	});
}

test("public resume recovers a self-closed pane directly without a maintenance tick", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.runner.store.preparePaneClose(f.ref, record.paneId, false, 1_000_000);
	await f.client.closePane(record.paneId);
	f.runner.maintain = async () => { throw new Error("resume must not depend on a maintenance timer"); };
	const result = await spawnHerdrAgent({
		resume: record.id, prompt: "follow up", description: record.description, subagentType: record.type,
		cwd: record.cwd!, paneId: "w1:p1", runInBackground: true,
	}, { root: record.cwd!, client: f.client, runner: f.runner });
	assert.equal(result.details.status, "background", result.text);
	assert.notEqual(result.details.runId, f.ref.runId);
	const resumed = await f.runner.resolve(record.id);
	assert.equal(resumed.paneClose, undefined);
	assert.notEqual(resumed.paneId, record.paneId);
	assert.equal(resumed.sessionFile, record.sessionFile);
	assert.equal(f.starts.length, 2);
});

test("explicit resume refuses an unprovable interrupted close without opening another pane", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.runner.store.preparePaneClose(f.ref, record.paneId, false, 1_000_000);
	delete f.panes.get(record.paneId)!.session;
	f.named.set(record.herdrName, { paneId: "w1:p999" });
	await assert.rejects(f.runner.resume(record.id, "follow up"), /outcome Herdr cannot confirm/);
	assert.ok((await f.runner.resolve(record.id)).paneClose);
	assert.equal(f.starts.length, 1);
});

test("a completed pane closes before its notice is acknowledged and keeps the result and notice", async (t) => {
	const f = await fixture(t);
	await f.complete(false);
	await f.runner.maintain();
	assert.equal(f.closed.length, 1);
	assert.equal((await f.runner.read(f.ref)).result, "remembered");
	await f.runner.store.acknowledgeNotice(f.ref.runId);
});

test("cold resume allocates a fresh Herdr name if another session took the old name", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	f.named.set(record.herdrName, { name: record.herdrName, paneId: "w1:p999", session: "/unrelated.jsonl" });
	await f.runner.resume(record.id, "follow up");
	assert.notEqual((await f.runner.resolve(record.id)).herdrName, record.herdrName);
	assert.equal(f.named.get(record.herdrName)?.paneId, "w1:p999");
	assert.deepEqual(f.closed, [record.paneId]);
});

for (const change of ["focused", "working", "blocked", "unknown-focus", "unknown-status", "session"] as const) {
	test(`late ${change} evidence after readiness preserves the pane`, async (t) => {
		const f = await fixture(t);
		await f.complete();
		const record = await f.runner.resolve(f.ref.agentId);
		f.advance();
		const prepare = f.runner.store.preparePaneClose.bind(f.runner.store);
		f.runner.store.preparePaneClose = async (...args) => {
			const ready = await prepare(...args);
			const pane = f.panes.get(record.paneId)!;
			if (change === "focused") pane.focused = true;
			else if (change === "unknown-focus") delete pane.focused;
			else if (change === "unknown-status") delete pane.status;
			else if (change === "session") pane.session = "/replacement.jsonl";
			else pane.status = change;
			return ready;
		};
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
		assert.equal((await f.runner.resolve(record.id)).paneClose, undefined);
	});
}

for (const activity of ["focused", "working"] as const) {
	test(`${activity} changing after cloned agent evidence never closes the pane`, async (t) => {
		const f = await fixture(t);
		await f.complete();
		const record = await f.runner.resolve(f.ref.agentId);
		f.advance();
		const get = f.client.getAgent;
		let observations = 0;
		f.client.getAgent = async (...args) => {
			const result = structuredClone(await get(...args));
			if (args[0] === record.herdrName && ++observations === 2) {
				if (activity === "focused") f.panes.get(record.paneId)!.focused = true;
				else f.panes.get(record.paneId)!.status = "working";
			}
			return result;
		};
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
	});
}

test("an explicitly resumed orphan is adopted by its current caller", async (t) => {
	const f = await fixture(t);
	f.panes.delete("w1:p1");
	await f.runner.maintain();
	assert.equal((await f.runner.read(f.ref)).phase, "stopped");
	f.panes.set("w1:p99", { paneId: "w1:p99", session: "/new-owner.jsonl", focused: false });
	const next = await f.runner.resume(f.ref.agentId, "continue", undefined, true, { paneId: "w1:p99", sessionFile: "/new-owner.jsonl" });
	f.advance(2000);
	await f.runner.maintain();
	assert.equal((await f.runner.read(next)).phase, "queued");
	const adopted = await f.runner.resolve(f.ref.agentId);
	assert.equal(adopted.parentPaneId, "w1:p99");
	assert.equal(adopted.parentSessionFile, "/new-owner.jsonl");
	assert.equal(adopted.parentAgentId, undefined);
});

test("cold-resumed managed parents retain running children and rebind pending notices", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const parent = await f.runner.resolve(f.ref.agentId);
	const child = await f.runner.spawn({
		prompt: "nested", description: "nested", subagentType: "nested", runInBackground: true,
		cwd: parent.cwd!, paneId: parent.paneId, sessionFile: parent.sessionFile, keep: true,
	});
	const childRecord = await f.runner.resolve(child.agentId);
	assert.equal(childRecord.parentAgentId, parent.id);
	const finished = await f.runner.spawn({
		prompt: "finish early", description: "finished child", subagentType: "finished", runInBackground: true,
		cwd: parent.cwd!, paneId: parent.paneId, sessionFile: parent.sessionFile, keep: true,
	});
	const finishedRecord = await f.runner.resolve(finished.agentId);
	const earlyBinding = (await f.runner.store.attach(finishedRecord.paneId, finishedRecord.sessionFile, finishedRecord.sessionId!))!;
	await f.runner.store.claimNextCommand(finished.agentId, earlyBinding.token, false);
	await f.runner.store.recordExecutionEvent(finished, earlyBinding.token, { type: "live" }, 1_000_000);
	await f.runner.store.recordExecutionEvent(finished, earlyBinding.token, { type: "completed", result: "pending notice" }, 1_000_000);
	assert.equal((await f.runner.store.notices(parent.paneId)).length, 1);
	await f.client.closePane(parent.paneId);
	await f.runner.store.parkAgent(f.ref, parent.paneId, 1_000_000);
	await f.runner.resume(parent.id, "continue parent");
	const resumed = await f.runner.resolve(parent.id);
	const closed = f.closed.length;
	await f.runner.maintain();
	assert.equal((await f.runner.read(child)).phase, "queued");
	assert.equal(f.closed.length, closed);
	assert.equal((await f.runner.resolve(child.agentId)).parentPaneId, resumed.paneId);
	assert.equal((await f.runner.store.notices(resumed.paneId)).length, 1, "already-pending notices follow the parent");
	assert.equal((await f.runner.store.notices(parent.paneId)).length, 0);
	const binding = (await f.runner.store.attach(childRecord.paneId, childRecord.sessionFile, childRecord.sessionId!))!;
	await f.runner.store.claimNextCommand(child.agentId, binding.token, false);
	await f.runner.store.recordExecutionEvent(child, binding.token, { type: "live" }, 1_000_000);
	await f.runner.store.recordExecutionEvent(child, binding.token, { type: "completed", result: "child finished" }, 1_000_000);
	assert.equal((await f.runner.store.notices(resumed.paneId)).length, 2);
	assert.equal((await f.runner.store.notices(parent.paneId)).length, 0);
});

test("unresolved cold startup refuses warm retry before accepting work", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const before = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(before.paneId);
	await f.runner.store.parkAgent(f.ref, before.paneId, 1_000_000);
	const start = f.client.startPi;
	const close = f.client.closePane;
	f.client.startPi = async (...args) => { await start(...args); throw new Error("lost start reply"); };
	f.client.closePane = async () => { throw new Error("close refused"); };
	await assert.rejects(f.runner.resume(before.id, "one"), /Cold resume cleanup withheld/);
	f.client.closePane = close;
	f.client.startPi = start;
	assert.equal((await f.runner.store.launches())[0].stage, "ambiguous");
	await assert.rejects(f.runner.resume(before.id, "two"), /earlier pane launch is unresolved/);
	assert.equal((await f.runner.resolve(before.id)).currentRunId, f.ref.runId);
	assert.equal((await f.runner.read(f.ref)).phase, "completed");
});

for (const replacedName of [true, false]) {
	test(`a renamed live session with ${replacedName ? "replaced" : "missing"} old name cannot cold-resume`, async (t) => {
		const f = await fixture(t);
		await f.complete();
		const before = await f.runner.resolve(f.ref.agentId);
		const original = f.named.get(before.herdrName)!;
		original.name = "renamed-live";
		f.named.delete(before.herdrName);
		f.named.set("renamed-live", original);
		if (replacedName) f.named.set(before.herdrName, { name: before.herdrName, paneId: "w1:p999", session: "/other.jsonl" });
		await assert.rejects(f.runner.resume(before.id, "follow up"), /original session may still be live/);
		assert.equal(f.starts.length, 1);
		assert.equal((await f.runner.resolve(before.id)).paneId, before.paneId);
	});
}

test("session inventory catches a live original that moved beyond its recorded alias", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	const original = f.named.get(record.herdrName)!;
	f.panes.delete(record.paneId);
	f.named.delete(record.herdrName);
	const moved = { ...original, paneId: "w2:p10", name: "renamed-live" };
	f.panes.set(moved.paneId, moved);
	f.named.set(moved.name, moved);
	await assert.rejects(f.runner.resume(record.id, "follow up"), /session inventory/);
	assert.equal(f.starts.length, 1);
});

test("public spawn resume uses the caller workspace after the original workspace disappears", async (t) => {
	const f = await fixture(t, { workspaceId: "deleted-workspace" });
	await f.complete();
	const before = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(before.paneId);
	await f.runner.store.parkAgent(f.ref, before.paneId, 1_000_000);
	const attempts: Array<string | undefined> = [];
	const create = f.client.createTab;
	f.client.createTab = async (options) => {
		attempts.push(options.workspaceId);
		if (options.workspaceId === "deleted-workspace") throw new HerdrCliError("workspace missing", "workspace_not_found");
		return create(options);
	};
	const result = await spawnHerdrAgent({
		resume: before.id, prompt: "resume here", description: "follow up", subagentType: "test", runInBackground: true,
		cwd: before.cwd!, paneId: "new-workspace:p1", tabId: "new-workspace:t1", workspaceId: "new-workspace", sessionFile: "/current.jsonl",
	}, { root: before.cwd!, client: f.client, runner: f.runner });
	assert.equal(result.details.status, "background", result.text);
	assert.deepEqual(attempts, ["new-workspace"]);
	assert.equal((await f.runner.store.launches())[0].stage, "published");
	assert.equal((await f.runner.resolve(before.id)).parentWorkspaceId, "new-workspace");
});

for (const uncertainty of ["alias", "inventory", "missing-alias-api", "pane-id", "named-pane-session"] as const) {
	test(`cold resume preserves the conversation under ${uncertainty} uncertainty`, async (t) => {
		const f = await fixture(t);
		await f.complete();
		const record = await f.runner.resolve(f.ref.agentId);
		await f.client.closePane(record.paneId);
		await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
		if (uncertainty === "alias") f.client.getPane = async () => ({ paneId: "w2:p10" });
		else if (uncertainty === "inventory") f.client.listAgents = async () => [{ paneId: "w2:p10", name: "unknown" }];
		else if (uncertainty === "pane-id") f.client.listPanes = async () => [{ session: "/unrelated.jsonl" }];
		else if (uncertainty === "named-pane-session") f.client.listPanes = async () => [{ paneId: "w2:p10", name: "renamed" }];
		else delete f.client.getPane;
		await assert.rejects(f.runner.resume(record.id, "follow up"));
		assert.equal(f.starts.length, 1);
		assert.equal((await f.runner.resolve(record.id)).currentRunId, f.ref.runId);
	});
}

test("cold resume permits unnamed shell panes without session metadata", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	const [shell] = panesFromList({ result: { panes: [{ pane_id: "w2:p10", agent_status: "unknown", focused: false }] } });
	f.panes.set("w2:p10", shell);
	const next = await f.runner.resume(record.id, "follow up");
	assert.equal((await f.runner.read(next)).phase, "queued");
});

test("definite cold pane creation rejection releases its reservation for retry", async (t) => {
	const f = await fixture(t);
	await f.complete();
	const record = await f.runner.resolve(f.ref.agentId);
	await f.client.closePane(record.paneId);
	await f.runner.store.parkAgent(f.ref, record.paneId, 1_000_000);
	const create = f.client.createTab;
	f.client.createTab = async () => { throw new HerdrCliError("workspace missing", "workspace_not_found"); };
	await assert.rejects(f.runner.resume(record.id, "first"), /workspace missing/);
	assert.equal((await f.runner.store.launches())[0].stage, "closed");
	f.client.createTab = create;
	const next = await f.runner.resume(record.id, "retry");
	assert.equal((await f.runner.read(next)).phase, "queued");
});

for (const guard of ["disabled", "pinned", "focused", "working", "blocked", "unknown-focus", "unknown-status", "unknown-session"] as const) {
	test(`unacknowledged completion preserves the ${guard} guard`, async (t) => {
		const f = await fixture(t, { closeWhenDone: guard === "disabled" ? false : undefined, keep: guard === "pinned" });
		await f.complete(false);
		const record = await f.runner.resolve(f.ref.agentId);
		const pane = f.panes.get(record.paneId)!;
		if (guard === "focused") pane.focused = true;
		if (guard === "unknown-focus") delete pane.focused;
		if (guard === "unknown-status") delete pane.status;
		if (guard === "unknown-session") delete pane.session;
		if (guard === "working" || guard === "blocked") pane.status = guard;
		f.advance(100_000);
		await f.runner.maintain();
		assert.deepEqual(f.closed, []);
	});
}

test("cold resume waits out a pane that has not published its session yet", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.advance();
	await f.runner.maintain();
	const list = f.client.listPanes;
	let observations = 0;
	f.client.listPanes = async (...args) => [...await list(...args), ...(++observations < 3 ? [{ paneId: "w2:p10", name: "starting" }] : [])];
	await f.runner.resume(f.ref.agentId, "follow up");
	assert.equal(observations >= 3, true);
	assert.equal(f.starts.length, 2);
});

test("cold resume still refuses a session uncertainty that never clears", async (t) => {
	const f = await fixture(t);
	await f.complete();
	f.advance();
	await f.runner.maintain();
	const list = f.client.listPanes;
	let observations = 0;
	f.client.listPanes = async (...args) => {
		// The settle window counts time spent observing, not only the sleeps between observations.
		observations++;
		f.advance(800);
		return [...await list(...args), { paneId: "w2:p10", name: "agent without a session" }];
	};
	await assert.rejects(f.runner.resume(f.ref.agentId, "follow up"), /original session may still be live/);
	assert.equal(f.starts.length, 1);
	assert.ok(observations > 1 && observations < 15, `observed ${observations} times`);
});
