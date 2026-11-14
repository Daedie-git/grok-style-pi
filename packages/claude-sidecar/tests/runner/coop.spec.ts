import assert from "node:assert/strict";
import test from "node:test";
import { coopReview, type Launch } from "../../src/coop.ts";

function orchestrate(answer: (args: string[], stdin: string) => { code: number; report: string; question?: string }) {
	const calls: Array<{ args: string[]; stdin: string }> = [];
	const reports = new Map<string, string>();
	let out = "", err = "", saved = "";
	const launch: Launch = async (args, stdin, onStderr) => {
		calls.push({ args, stdin });
		const { code, report, question } = answer(args, stdin);
		const path = `/reports/${calls.length}.md`;
		reports.set(path, report);
		onStderr("still working");
		return { code, stdout: `# Sidecar report (${path})\n${report}\n${question ? `NEEDS_ANSWER: ${question}\n` : ""}` };
	};
	return {
		calls, run: () => coopReview({
			launch, base: "main", context: "ctx", piSlot: "98", claudeSlot: "99", extra: ["--machine", "lappy"], reportPath: "/reports/coop.md",
			save: (text) => { saved = text; }, readReport: (path) => reports.get(path)!, stdout: (text) => { out += text; }, stderr: (text) => { err += text; },
		}),
		out: () => out, err: () => err, saved: () => saved,
	};
}

test("coop-review runs both reviews independently and lists them", async () => {
	const f = orchestrate((args) => ({ code: 0, report: args[3] === "pi" ? "### 1. Bug A\nx" : "### 1. Bug B\ny" }));
	assert.equal(await f.run(), 0);
	assert.deepEqual(f.calls.map((call) => call.args), [
		["--slot", "98", "--agent", "pi", "--role", "adversarial-reviewer", "--machine", "lappy", "diff", "main", "ctx"],
		["--slot", "99", "--agent", "claude", "--role", "reviewer", "--machine", "lappy", "diff", "main", "ctx"],
	]);
	assert.match(f.out(), /^# Sidecar report \(\/reports\/coop\.md\)\n# Cooperative review/);
	assert.match(f.saved(), /## pi adversarial reviewer \(slot 98\)\n\nReport: \/reports\/1\.md\n\n### 1\. Bug A\nx\n\n## Claude Code reviewer \(slot 99\)\n\nReport: \/reports\/2\.md\n\n### 1\. Bug B\ny\n$/);
	assert.match(f.err(), /^\[pi slot 98\] still working$/m);
});

test("coop-review stops on a reviewer's question with exit 3 and how to answer", async () => {
	const f = orchestrate((args) => args[1] === "99" ? { code: 3, report: "## Question", question: "which base?" } : { code: 0, report: "### 1. A\nx" });
	assert.equal(await f.run(), 3);
	assert.match(f.out(), /Claude Code reviewer \(slot 99\): asked a question: which base\?\n  Reply with: sidecar --slot 99 answer TEXT/);
	assert.match(f.err(), /blocked on a question/);
});

test("coop-review reports the first failing reviewer's exit", async () => {
	const f = orchestrate((args) => ({ code: args[1] === "98" ? 2 : 0, report: "" }));
	assert.equal(await f.run(), 2);
	assert.match(f.out(), /incomplete[\s\S]*pi adversarial reviewer \(slot 98\): failed with exit 2/);
	assert.equal(f.calls.length, 2);
});

test("coop-review validates its slots and refuses a slot that is busy", async (t) => {
	const { fixture } = await import("./fixture.ts");
	const { mkdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const f = fixture(t, () => ({ type: "completed", result: "x" }));
	assert.match((await f.run("coop-review", "--pi-slot", "5", "--claude-slot", "5")).stderr, /must differ/);
	assert.match((await f.run("--slot", "2", "coop-review")).stderr, /chooses its own slots/);
	assert.match((await f.run("coop-review", "--pi-slot", "0")).stderr, /integer from 1 to 9999/);
	// A request holds slot 99.
	const { acquireLock } = await import("../../src/state.ts");
	mkdirSync(join(f.root, "state", "runner"), { recursive: true });
	const release = await acquireLock(join(f.root, "state", "runner", "sc-w1-p1-99.lock"));
	t.after(release);
	const busy = await f.run("coop-review");
	assert.equal(busy.code, 1);
	assert.match(busy.stderr, /slot 99 is busy with another request/);
});
