import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrCliError, panesFromList, type HerdrAgentRef, type HerdrClient } from "../src/herdr/client.ts";
import { HerdrRunner, spawnHerdrAgent } from "../src/herdr/runner.ts";
import type { ChildBinding } from "../src/herdr/store.ts";

async function fixture(t: test.TestContext, options: { keep?: boolean; closeWhenDone?: boolean; ownerSession?: boolean; runtime?: "claude-code"; machine?: string; parentPaneId?: string; workspaceId?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "herdr-lifecycle-"));
	let now = 1_000_000;
	let sequence = 1;
	let binding: ChildBinding | undefined;
	const parent: HerdrAgentRef = { paneId: options.parentPaneId ?? "w1:p1", session: "/owner.jsonl", focused: false };
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
	runner = new HerdrRunner({ root, client, now: () => now, closeWhenDone: options.closeWhenDone, machine: options.machine });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const ref = await runner.spawn({
		prompt: "remember this", description: "test", subagentType: "test", runtime: options.runtime,
		cwd: root, paneId: parent.paneId!, workspaceId: options.workspaceId, sessionFile: options.ownerSession === false ? undefined : parent.session,
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
	return { runner, client, ref, panes, named, starts, closed, complete, advance: (ms = 901_000) => { now += ms; } };
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
		if (uncertainty === "pane-id") await assert.rejects(f.runner.maintain(), /incomplete pane listing/);
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
