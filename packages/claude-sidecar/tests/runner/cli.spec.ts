import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../../src/cli.ts";
import { claudeQuestion, roleInstructions } from "../../src/prompts.ts";
import { fixture } from "./fixture.ts";
import { SlotState } from "../../src/state.ts";
import { MachineSelectionError } from "../../herdr-runner/src/client.ts";
import { HcError } from "../../herdr-runner/src/hc.ts";
import { workerChannel, type StoreChannel, type StoreEvents } from "../../herdr-runner/src/store.ts";

test("ask starts a Pi sidecar owned by the Claude session and prints its report", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "## Verdict\nship" }));
	const result = await f.run("--slot", "2", "ask", "Review the parser.");
	assert.equal(result.code, EXIT.report, result.stderr);
	const [header, ...body] = result.stdout.trimEnd().split("\n");
	const path = /^# Sidecar report \((.+)\)$/.exec(header)?.[1];
	assert.ok(path && existsSync(path));
	assert.equal(body.join("\n"), "## Verdict\nship");
	assert.match(f.prompts[0], /Review the parser\./);
	assert.match(f.prompts[0], /your final reply is the report/);
	assert.deepEqual(f.starts[0].slice(2), ["--model", "openai-codex/gpt-6.2-astra", "--thinking", "high"]);
	const status = await f.run("--slot", "2", "status");
	assert.match(status.stdout, /^slot 2: adversarial-reviewer · pi · sidecar-2-adversarial-reviewer · completed/m);
	const report = await f.run("--slot", "2", "report");
	assert.match(report.stdout, /## Verdict\nship/);
});

test("follow-ups resume the same conversation; a question exits 3 and answer continues it", async (t) => {
	const f = fixture(t, (prompt, n) => n === 2 ? { type: "needs-answer", result: "Keep the old API?" } : { type: "completed", result: `report ${n}` });
	assert.equal((await f.run("ask", "first")).code, EXIT.report);
	const asked = await f.run("ask", "second");
	assert.equal(asked.code, EXIT.question);
	assert.match(asked.stdout, /^NEEDS_ANSWER: Keep the old API\?$/m);
	// A completed pane may close between requests; a resumed pane reopens the same session.
	assert.equal(new Set(f.starts.map((args) => args[args.indexOf("--session") + 1])).size, 1, "the slot keeps one conversation");
	const answered = await f.run("answer", "yes");
	assert.equal(answered.code, EXIT.report, answered.stderr);
	assert.match(answered.stdout, /report 3/);
	assert.match(f.prompts[2], /^# Answer from Claude[\s\S]*Answer: yes/);
	const again = await f.run("answer", "no");
	assert.equal(again.code, EXIT.failed);
	assert.match(again.stderr, /no pending question/);
});

test("a slot keeps its role, and unsupported launcher features refuse", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	assert.equal((await f.run("--role", "implementer", "ask", "-")).code, EXIT.report);
	assert.match(f.prompts[0], /from stdin/);
	assert.match(f.prompts[0], /implementer/);
	const mismatch = await f.run("--role", "reviewer", "ask", "x");
	assert.equal(mismatch.code, EXIT.failed);
	assert.match(mismatch.stderr, /already a implementer/);
	assert.match((await f.run("reload")).stderr, /reload is not a sidecar command/);
});

test("reviewers run Claude Code and adversarial reviewers run pi; a conflicting --agent refuses", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	assert.match((await f.run("--slot", "2", "--role", "adversarial-reviewer", "--agent", "claude", "ask", "x")).stderr, /--role adversarial-reviewer runs pi; --role reviewer runs claude/);
	assert.match((await f.run("--slot", "3", "--role", "reviewer", "--agent", "pi", "ask", "x")).stderr, /--role reviewer runs claude; --role adversarial-reviewer runs pi/);
	assert.equal(f.starts.length, 0);
});

test("only Opus 5.5 and Sonnet 5.5 run as Claude sidecars", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	assert.match((await f.runWith({ env: { SIDECAR_CLAUDE_MODEL: "claude-haiku-4-5" } }, "--slot", "2", "--role", "reviewer", "ask", "x")).stderr, /model claude-haiku-4-5 is not allowed/);
	assert.match((await f.runWith({ env: { SIDECAR_CLAUDE_MODEL: "default" } }, "--slot", "4", "--role", "reviewer", "ask", "x")).stderr, /model default is not allowed/);
	assert.match((await f.runWith({ env: { SIDECAR_MODEL: "anthropic/claude-opus-4-1" } }, "--slot", "3", "ask", "x")).stderr, /not allowed/);
	assert.equal(f.starts.length, 0);
});

test("piModel selects the pi model unless overridden by SIDECAR_MODEL or --model", async (t) => {
	const sol = "openai-codex/gpt-6.2-sol", astra = "openai-codex/gpt-6.2-astra";
	const roles = { default: sol, "adversarial-reviewer": astra };
	for (const [piModel, expected, env, flags] of [
		[sol, sol, {}, []],
		[roles, astra, {}, []],
		[roles, sol, {}, ["--role", "implementer"]],
		[{ implementer: sol }, astra, {}, []],
		[roles, astra, { SIDECAR_MODEL: "gpt-6.2-astra" }, []],
		[roles, "provider/env-model", { SIDECAR_MODEL: "provider/env-model" }, []],
		[roles, "provider/flag-model", { SIDECAR_MODEL: "provider/env-model" }, ["--model", "provider/flag-model"]],
	] as const) {
		const f = fixture(t, () => ({ type: "completed", result: "done" }));
		const config = join(f.root, "config.json");
		writeFileSync(config, JSON.stringify({ piModel }));
		const run = await f.runWith({ env: { SIDECAR_CONFIG_FILE: config, ...env } }, ...flags, "ask", "x");
		assert.equal(run.code, 0, run.stderr);
		assert.deepEqual(f.starts.at(-1)!.slice(2, 4), ["--model", expected]);
	}
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const config = join(f.root, "config.json");
	for (const piModel of [42, "  ", null, [], { default: 0 }, { explorer: "  " }]) {
		writeFileSync(config, JSON.stringify({ piModel }));
		assert.match((await f.runWith({ env: { SIDECAR_CONFIG_FILE: config } }, "--slot", "4", "ask", "x")).stderr, /piModel .* must be a model id/);
	}
	writeFileSync(config, JSON.stringify({ piModel: { typo: sol } }));
	assert.match((await f.runWith({ env: { SIDECAR_CONFIG_FILE: config } }, "ask", "x")).stderr, /unknown piModel role typo/);
	writeFileSync(config, JSON.stringify({ piModel: { reviewer: sol } }));
	assert.match((await f.runWith({ env: { SIDECAR_CONFIG_FILE: config } }, "ask", "x")).stderr, /runs Claude Code; use adversarial-reviewer/);
});

test("Pi model shorthand uses the role or slot provider and refuses unmatched bare IDs before launch", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const config = join(f.root, "config.json");
	const env = { SIDECAR_CONFIG_FILE: config };
	const sol = "openai-codex/gpt-6.2-sol";
	writeFileSync(config, JSON.stringify({ piModel: { researcher: sol } }));
	const run = await f.runWith({ env }, "--slot", "2", "--role", "researcher", "--model", "gpt-6.2-sol", "--thinking", "high", "ask", "x");
	assert.equal(run.code, EXIT.report, run.stderr);
	assert.deepEqual(f.starts[0].slice(2), ["--model", sol, "--thinking", "high"]);
	// A changed default must not change the provider on an already bound slot.
	writeFileSync(config, JSON.stringify({ piModel: { researcher: "openai/gpt-6.2-sol" } }));
	const followUp = await f.runWith({ env }, "--slot", "2", "--model", "gpt-6.2-sol", "ask", "again");
	assert.equal(followUp.code, EXIT.report, followUp.stderr);
	assert.ok(f.starts.every((args) => args[3] === sol));
	const starts = f.starts.length;
	const refused = await f.runWith({ env }, "--slot", "3", "--role", "researcher", "--model", "gpt-6.2-astra", "ask", "x");
	assert.equal(refused.code, EXIT.failed);
	assert.match(refused.stderr, /use provider\/model or omit the override/);
	assert.equal(f.prompts.length, 2);
	assert.equal(f.starts.length, starts);
	assert.equal(new SlotState(join(f.root, "state"), "sc-w1-p1-3").read(), undefined);
	writeFileSync(config, JSON.stringify({ piModel: { researcher: "gpt-6.2-sol" } }));
	const unqualifiedConfig = await f.runWith({ env }, "--slot", "3", "--role", "researcher", "ask", "x");
	assert.equal(unqualifiedConfig.code, EXIT.failed);
	assert.match(unqualifiedConfig.stderr, /Set piModel and SIDECAR_MODEL to provider\/model/);
	assert.equal(f.starts.length, starts);
});

test("an explicit Pi provider wins even when it appears inside a configured model ID", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const config = join(f.root, "config.json");
	const env = { SIDECAR_CONFIG_FILE: config };
	writeFileSync(config, JSON.stringify({ piModel: "openrouter/openai/gpt-4.1" }));
	assert.equal((await f.runWith({ env }, "--slot", "2", "--model", "openai/gpt-4.1", "ask", "x")).code, EXIT.report);
	assert.equal(f.starts[0][3], "openai/gpt-4.1");
	const bound = fixture(t, () => ({ type: "completed", result: "done" }));
	const configured = await bound.runWith({ env }, "--slot", "3", "ask", "use the configured model");
	assert.equal(configured.code, EXIT.report, configured.stderr);
	assert.equal(bound.starts[0][3], "openrouter/openai/gpt-4.1");
	const refused = await bound.runWith({ env }, "--slot", "3", "--model", "openai/gpt-4.1", "ask", "x");
	assert.equal(refused.code, EXIT.failed);
	assert.match(refused.stderr, /runs openrouter\/openai\/gpt-4\.1/);
});

test("claudeModels in the sidecar config replaces the allowlist", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const config = join(f.root, "config.json");
	writeFileSync(config, JSON.stringify({ claudeModels: ["claude-opus-6", "claude-sonnet-6"] }));
	const env = { SIDECAR_CONFIG_FILE: config };
	assert.match((await f.runWith({ env: { ...env, SIDECAR_CLAUDE_MODEL: "claude-opus-5-5" } }, "--slot", "2", "--role", "reviewer", "ask", "x")).stderr, /claude-opus-5-5 is not allowed; Claude sidecars run claude-opus-6 or claude-sonnet-6/);
	const run = await f.runWith({ env: { ...env, SIDECAR_MODEL: "anthropic/claude-sonnet-6" } }, "--slot", "3", "ask", "x");
	assert.equal(run.code, 0, run.stderr);
	assert.deepEqual(f.starts.at(-1)!.slice(2, 4), ["--model", "anthropic/claude-sonnet-6"]);
});

test("--model and --thinking choose a fresh slot's model; follow-ups refuse another model", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const run = await f.run("--slot", "4", "--role", "implementer", "--model", "openai-codex/gpt-6.2-sol", "--thinking", "high", "ask", "x");
	assert.equal(run.code, 0, run.stderr);
	assert.deepEqual(f.starts.at(-1)!.slice(2), ["--model", "openai-codex/gpt-6.2-sol", "--thinking", "high"]);
	assert.match((await f.run("--slot", "4", "--model", "openai-codex/gpt-6.2-astra", "ask", "again")).stderr, /runs openai-codex\/gpt-6.2-sol; use stop --fresh/);
	assert.equal(f.prompts.length, 1);
});

test("pi roles default to astra; reviewers and researchers think at high, others at medium", async (t) => {
	for (const [role, thinking] of [["implementer", "medium"], ["explorer", "medium"], ["researcher", "high"]]) {
		const f = fixture(t, () => ({ type: "completed", result: "done" }));
		const run = await f.run("--slot", "5", "--role", role, "ask", "x");
		assert.equal(run.code, 0, run.stderr);
		assert.deepEqual(f.starts.at(-1)!.slice(2), ["--model", "openai-codex/gpt-6.2-astra", "--thinking", thinking]);
	}
});

test("sidecar Claude aliases follow claudeModels, and follow-ups refuse a model since removed", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const config = join(f.root, "config.json");
	writeFileSync(config, JSON.stringify({ claudeModels: ["claude-opus-6", "claude-sonnet-6"] }));
	const env = { SIDECAR_CONFIG_FILE: config, SIDECAR_MODEL: "anthropic/sonnet" };
	assert.equal((await f.runWith({ env }, "--slot", "2", "ask", "x")).code, 0);
	assert.deepEqual(f.starts.at(-1)!.slice(2, 4), ["--model", "anthropic/claude-sonnet-6"]);
	writeFileSync(config, JSON.stringify({ claudeModels: ["claude-opus-6"] }));
	assert.match((await f.runWith({ env }, "--slot", "2", "ask", "again")).stderr, /claude-sonnet-6 is not allowed/);
	assert.equal(f.prompts.length, 1);
});

test("Pi resolves a matching Claude alias against the allowlist after choosing the provider", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "done" }));
	const config = join(f.root, "config.json");
	writeFileSync(config, JSON.stringify({ piModel: "anthropic/sonnet", claudeModels: ["claude-sonnet-6"] }));
	const run = await f.runWith({ env: { SIDECAR_CONFIG_FILE: config } }, "--model", "sonnet", "ask", "x");
	assert.equal(run.code, EXIT.report, run.stderr);
	assert.equal(f.starts[0][3], "anthropic/claude-sonnet-6");
});

test("a slot recorded as a pi reviewer is the adversarial reviewer", async (t) => {
	const { SlotState } = await import("../../src/state.ts");
	const root = mkdtempSync(join(tmpdir(), "sidecar-legacy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const slot = new SlotState(root, "s");
	slot.write({ agentId: "a1", role: "reviewer", agent: "pi" });
	assert.equal(slot.read()?.role, "adversarial-reviewer");
	slot.write({ agentId: "a2", role: "reviewer", agent: "claude" });
	assert.equal(slot.read()?.role, "reviewer");
});

test("a failed run reports no report and exits 2", async (t) => {
	const f = fixture(t, () => ({ type: "failed", error: "model unavailable" }));
	const result = await f.run("ask", "x");
	assert.equal(result.code, EXIT.noReport);
	assert.match(result.stderr, /no report .* failed: model unavailable/);
});

test("a Pi pane that exits before accepting the prompt tells Claude not to retry blindly", async (t) => {
	const f = fixture(t, () => { throw new Error("the prompt must not run"); });
	f.client.startPi = async ({ paneId }) => { f.panes.delete(paneId); };
	const result = await f.run("ask", "x");
	assert.equal(result.code, EXIT.noReport);
	assert.match(result.stderr, /before accepting the task \(Herdr pane w1:p2\)/);
	assert.match(result.stderr, /Do not retry on the same slot/);
});

test("a provider safety block is reported to Claude as a failed request, without a report or retry", async (t) => {
	const message = "The run was blocked by the provider's safety policy.";
	const f = fixture(t, () => ({ type: "failed", error: message, result: "Unfinished sidecar output" }));
	const result = await f.run("ask", "Review the parser.");
	assert.equal(result.code, EXIT.noReport);
	assert.match(result.stderr, /the run failed: The run was blocked by the provider's safety policy\./);
	assert.ok(!result.stdout.includes("Unfinished sidecar output"));
	assert.equal(f.prompts.length, 1);
});

test("role instructions keep the guidance and replace the launcher's delivery protocol", () => {
	for (const backend of ["pi", "claude"] as const) {
		const text = roleInstructions("reviewer", backend);
		assert.doesNotMatch(text, /submit_review|Messages you receive/);
		assert.match(text, /Be adversarial/);
		assert.match(text, backend === "pi" ? /call needs_answer/ : /NEEDS_ANSWER:/);
	}
});

test("a Claude Code sidecar's final NEEDS_ANSWER line is its question", () => {
	assert.deepEqual(claudeQuestion("state\n\nNEEDS_ANSWER: which base?"), { report: "state", question: "which base?" });
	assert.deepEqual(claudeQuestion("NEEDS_ANSWER: x\nmore"), { report: "NEEDS_ANSWER: x\nmore" });
});

test("scripts/sidecar runs the front-end, and its hook entries return at once", async () => {
	const { spawnSync } = await import("node:child_process");
	const launcher = new URL("../../scripts/sidecar", import.meta.url).pathname;
	const home = mkdtempSync(join(tmpdir(), "sidecar-shim-"));
	try {
		const env = { PATH: process.env.PATH, HOME: home, SIDECAR_STATE_DIR: join(home, "state") };
		const status = spawnSync(launcher, ["--slot", "3", "status"], { env, encoding: "utf8" });
		assert.equal(status.status, EXIT.failed);
		assert.match(status.stderr, /run inside a herdr pane or a Herdr app terminal/);
		for (const hook of ["session-end", "sweep", "done-close"]) assert.equal(spawnSync(launcher, [hook], { env }).status, 0);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * Routes slot 2's agent through a "lappy" channel onto the fixture's store. `channel` sees each request on the Nth open
 * and returns true to swallow it; for the pseudo-request "open" it may return "offline", "hang" or an error to throw instead.
 */
async function onMachine(t: test.TestContext, env: Record<string, string>, channel: (open: number, request: Parameters<StoreChannel["post"]>[0], events: StoreEvents) => boolean | "offline" | "hang" | Error) {
	const f = fixture(t, (_prompt, n) => ({ type: "completed", result: `report ${n}` }));
	assert.equal((await f.run("--slot", "2", "ask", "first")).code, EXIT.report);
	const slot = new SlotState(join(f.root, "state"), "sc-w1-p1-2");
	const record = slot.read()!;
	slot.write({ ...record, agentId: `${record.agentId}@lappy`, machine: "lappy" });
	let opens = 0;
	const machineChannel = async () => {
		const open = ++opens;
		const setup = channel(open, { id: 0, operation: "open" } as never, undefined as never);
		if (setup === "offline") throw new Error("ssh: connect to host lappy port 22: Connection timed out");
		if (setup === "hang") await new Promise(() => undefined);
		if (setup instanceof Error) throw setup;
		const factory = workerChannel(join(f.root, "store"));
		return (events: StoreEvents) => {
			const inner = factory(events);
			return { ...inner, post: (request: Parameters<StoreChannel["post"]>[0]) => { if (!channel(open, request, events)) inner.post(request); } };
		};
	};
	const result = await f.runWith({ reconnectMs: 10, env, parent: {
		listMachines: async () => [{ id: "m1", label: "lappy", target: "lappy", enabled: true }],
		machineClient: () => f.client, machineChannel,
	} }, "--slot", "2", "ask", "second");
	return { ...result, opens };
}

test("a request on a machine reconnects a dropped control channel and the recovered channel delivers the report", async (t) => {
	let begun = false, acknowledged = 0;
	const result = await onMachine(t, {}, (open, request, events) => {
		if (request.operation === "open") return open === 2 ? "offline" : false;
		if (request.operation === "beginRun") begun = true;
		if (open === 1 && begun && request.operation === "read") { events.fail(new Error("Timeout, server lappy not responding.")); return true; }
		if (open === 3 && request.operation === "acknowledgeNotice") acknowledged++;
		return false;
	});
	assert.equal(result.code, EXIT.report, result.stderr);
	assert.match(result.stdout, /report 2/);
	assert.match(result.stderr, /lost the connection to lappy; the run continues there, reconnecting \(Timeout, server lappy not responding\.\)/);
	assert.match(result.stderr, /reconnected to lappy/);
	assert.equal(result.opens, 3);
	assert.equal(acknowledged, 1, "the recovered channel acknowledges the run's notice");
});

test("a machine that stays unreachable, or keeps dropping before it reads the run, fails at SIDECAR_RECONNECT_S", async (t) => {
	for (const flap of [false, true]) {
		let begun = false;
		const result = await onMachine(t, { SIDECAR_RECONNECT_S: "0.2" }, (open, request, events) => {
			if (request.operation === "open") return open > 1 && !flap ? "offline" : false;
			if (request.operation === "beginRun") begun = true;
			if (begun && request.operation === "read") { events.fail(new Error("closed")); return true; }
			return false;
		});
		assert.equal(result.code, EXIT.failed, result.stderr);
		assert.match(result.stderr, /lappy unreachable for 0s; the run may still be working there/);
		assert.doesNotMatch(result.stderr, /reconnected/);
		assert.ok(result.opens < 40, `retries keep their cadence (${result.opens} opens)`);
	}
});

test("a stalled reconnect handshake ends at the deadline; a protocol mismatch or disabled machine fails at once", async (t) => {
	let begun = false;
	const stalled = await onMachine(t, { SIDECAR_RECONNECT_S: "0.2" }, (open, request, events) => {
		if (request.operation === "beginRun") begun = true;
		if (open === 1 && begun && request.operation === "read") { events.fail(new Error("closed")); return true; }
		return open > 1 && request.operation === "remoteProtocol";
	});
	assert.equal(stalled.code, EXIT.failed);
	assert.match(stalled.stderr, /lappy unreachable for 0s; the run may still be working there: no reply from lappy/);
	begun = false;
	const mismatch = await onMachine(t, {}, (open, request, events) => {
		if (request.operation === "beginRun") begun = true;
		if (open === 1 && begun && request.operation === "read") { events.fail(new Error("closed")); return true; }
		if (open > 1 && request.operation === "remoteProtocol") { events.reply({ id: request.id, value: 999 }); return true; }
		return false;
	});
	assert.equal(mismatch.code, EXIT.failed);
	assert.match(mismatch.stderr, /lappy speaks remote protocol 999/);
	assert.equal(mismatch.opens, 2);
	for (const refusal of [new MachineSelectionError("Herdr machine 'lappy' is disabled."), new HcError("hc machine lappy is not listed", "machine_unknown")]) {
		begun = false;
		const gone = await onMachine(t, {}, (open, request, events) => {
			if (request.operation === "open") return open > 1 ? refusal : false;
			if (request.operation === "beginRun") begun = true;
			if (begun && request.operation === "read") { events.fail(new Error("closed")); return true; }
			return false;
		});
		assert.equal(gone.code, EXIT.failed);
		assert.ok(gone.stderr.includes(refusal.message), gone.stderr);
		assert.equal(gone.opens, 2);
	}
	// The replacement answers the handshake, then never answers the read.
	begun = false;
	const stalledRead = await onMachine(t, { SIDECAR_RECONNECT_S: "0.2" }, (open, request, events) => {
		if (request.operation === "beginRun") begun = true;
		if (open === 1 && begun && request.operation === "read") { events.fail(new Error("closed")); return true; }
		return open > 1 && request.operation === "read";
	});
	assert.equal(stalledRead.code, EXIT.failed);
	assert.match(stalledRead.stderr, /lappy unreachable for 0s; the run may still be working there: no reply from lappy/);
});

test("reconnect gives up on a setup that never opens a channel, and refuses an invalid budget", async (t) => {
	for (const [env, expected] of [[{ SIDECAR_RECONNECT_S: "0.2" }, /lappy unreachable for 0s; the run may still be working there: no reply from lappy/], [{ SIDECAR_RECONNECT_S: "soon" }, /SIDECAR_RECONNECT_S must be a number of seconds/]] as const) {
		let begun = false, dropped = 0;
		const result = await onMachine(t, env, (open, request, events) => {
			if (request.operation === "open") return open > 1 ? "hang" : false;
			if (request.operation === "beginRun") begun = true;
			if (begun && request.operation === "read") { dropped = Date.now(); events.fail(new Error("closed")); return true; }
			return false;
		});
		assert.equal(result.code, EXIT.failed);
		assert.match(result.stderr, expected);
		assert.ok(Date.now() - dropped < 3000, "the request ends near its budget, not when the setup does");
	}
});
