import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../../src/cli.ts";
import { claudeQuestion, roleInstructions } from "../../src/prompts.ts";
import { fixture } from "./fixture.ts";

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
	assert.deepEqual(f.starts[0].slice(2), ["--model", "openai-codex/gpt-6.1-sol", "--thinking", "high"]);
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
