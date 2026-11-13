import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
	assert.match(status.stdout, /^slot 2: reviewer · pi · sidecar-2-reviewer · completed/m);
	const report = await f.run("--slot", "2", "report");
	assert.match(report.stdout, /## Verdict\nship/);
});

test("follow-ups resume the same conversation; a question exits 3 and answer continues it", async (t) => {
	const f = fixture(t, (prompt, n) => n === 2 ? { type: "needs-answer", result: "Keep the old API?" } : { type: "completed", result: `report ${n}` });
	assert.equal((await f.run("ask", "first")).code, EXIT.report);
	const asked = await f.run("ask", "second");
	assert.equal(asked.code, EXIT.question);
	assert.match(asked.stdout, /^NEEDS_ANSWER: Keep the old API\?$/m);
	assert.equal(f.starts.length, 1, "the slot keeps one conversation");
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
	assert.match((await f.run("coop-review", "x")).stderr, /not supported with SIDECAR_RUNNER=1/);
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

test("the Bash launcher hands runner commands to the front-end only with SIDECAR_RUNNER=1", async () => {
	const { spawnSync } = await import("node:child_process");
	const launcher = new URL("../../scripts/sidecar", import.meta.url).pathname;
	const home = mkdtempSync(join(tmpdir(), "sidecar-switch-"));
	try {
		const env = { PATH: process.env.PATH, HOME: home, SIDECAR_STATE_DIR: join(home, "state") };
		const delegated = spawnSync(launcher, ["--slot", "3", "status"], { env: { ...env, SIDECAR_RUNNER: "1" }, encoding: "utf8" });
		assert.equal(delegated.status, EXIT.failed);
		assert.match(delegated.stderr, /run inside a herdr pane or a Herdr app terminal/);
		const bash = spawnSync(launcher, ["--slot", "3", "status"], { env, encoding: "utf8" });
		assert.doesNotMatch(bash.stderr, /herdr pane or a Herdr app terminal/);
	} finally { rmSync(home, { recursive: true, force: true }); }
});
