import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { combine, coopReview, inventory, verifyRequest, type Launch } from "../../src/coop.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/coop/${name}`, import.meta.url), "utf8");

test("inventory numbers ### findings and ignores headings inside code fences", () => {
	assert.deepEqual(inventory(fixture("pi.md"), "P").map((f) => [f.id, f.title]), [["P1", "Race in lock"], ["P2", "Missing test"], ["P3", "Same title"]]);
	assert.match(inventory(fixture("pi.md"), "P")[0].body, /### not a heading in code/);
	assert.deepEqual(inventory(fixture("claude.md"), "C").map((f) => f.id), ["C1", "C2"]);
});

test("combine matches the Bash launcher's output: IDs, titles, withdrawals, wrong sides and repeats", () => {
	// The expected file is the Bash launcher's coop_combine output for these inputs, recorded before its removal.
	const actual = combine(["pi (slot 98)", "Claude Code (slot 99)"], [inventory(fixture("pi.md"), "P"), inventory(fixture("claude.md"), "C")],
		[fixture("pi-verify.md"), fixture("claude-verify.md")]);
	assert.equal(actual, fixture("combined.expected.md"));
});

test("combine warns when a review has no findings or a check has no verdicts", () => {
	const text = combine(["A", "B"], [[], inventory("### 1. Only\nbody\n", "C")], ["nothing parseable\n", ""]);
	assert.match(text, /No findings were extracted from A's review/);
	assert.match(text, /A returned no parseable verdicts; every finding of B is listed as unchecked/);
	assert.match(text, /### C1: Only\nOrigin: B\. A did not check it; unverified\./);
});

test("the verify request lists the peer's findings and the entry format", () => {
	const peer = inventory(fixture("claude.md"), "C");
	const text = verifyRequest("Claude Code (slot 99)", fixture("claude.md"), peer, inventory(fixture("pi.md"), "P"));
	assert.match(text, /- C1: Null deref\n- C2: Same title/);
	assert.match(text, /### \[CONFIRMED\] <ID> <title>/);
	assert.match(text, /- P3: Same title/);
	// Recorded from the Bash launcher's coop_verify_request.
	assert.equal(text + "\n", fixture("verify.expected.md"));
});


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

test("coop-review runs both reviews, cross-checks, and combines", async () => {
	const f = orchestrate((args) => args.includes("diff")
		? { code: 0, report: args[3] === "pi" ? "### 1. Bug A\nx" : "### 1. Bug B\ny" }
		: { code: 0, report: args[3] === "pi" ? "### [CONFIRMED] C1 Bug B\nok" : "### [CONFIRMED] P1 Bug A\nok" });
	assert.equal(await f.run(), 0);
	assert.deepEqual(f.calls[0].args, ["--slot", "98", "--agent", "pi", "--role", "reviewer", "--machine", "lappy", "diff", "main", `ctx\n\n## Report format (cooperative review)\nGive each finding its own \`### N. Title\` heading, numbered from 1, and use no other \`###\` headings. The other reviewer will check every finding by its number.`]);
	assert.deepEqual(f.calls[2].args.slice(-2), ["ask", "-"]);
	assert.match(f.calls[2].stdin, /check Claude Code \(slot 99\)'s findings[\s\S]*- C1: Bug B/);
	assert.match(f.out(), /^# Sidecar report \(\/reports\/coop\.md\)\n# Cooperative review/);
	assert.match(f.saved(), /Confirmed by both 2, disputed 0/);
	assert.match(f.err(), /^\[pi slot 98\] still working$/m);
});

test("coop-review stops on a reviewer's question with exit 3 and how to answer", async () => {
	const f = orchestrate((args) => args.includes("diff") ? { code: 0, report: "### 1. A\nx" }
		: args[1] === "99" ? { code: 3, report: "## Question", question: "which base?" } : { code: 0, report: "" });
	assert.equal(await f.run(), 3);
	assert.match(f.out(), /Claude Code \(slot 99\): asked a question: which base\?\n  Reply with: sidecar --slot 99 answer TEXT/);
	assert.match(f.err(), /blocked on a question/);
});

test("coop-review reports the first failing reviewer's exit during review", async () => {
	const f = orchestrate((args) => ({ code: args[1] === "98" ? 2 : 0, report: "" }));
	assert.equal(await f.run(), 2);
	assert.match(f.out(), /incomplete \(during review\)[\s\S]*pi \(slot 98\): failed with exit 2/);
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
