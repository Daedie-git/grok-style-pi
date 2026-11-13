import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../../src/cli.ts";
import { bashQuote } from "../../src/git.ts";
import { Rejections } from "../../src/rejections.ts";
import { publishDirs } from "../../src/push-gate.ts";
import { fixture } from "./fixture.ts";

function repoIn(root: string) {
	const repo = join(root, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => { const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-qm", "Initial");
	writeFileSync(join(repo, "a.txt"), "two\n");
	return { repo, git };
}

const ship = () => ({ type: "completed", result: "## Verdict\nship" }) as const;
const hook = (command: string, cwd: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });

test("plan sends the plan prompt with its context", async (t) => {
	const f = fixture(t, ship);
	writeFileSync(join(f.root, "plan.md"), "# Plan\n");
	const result = await f.run("plan", "plan.md", "Ship by Friday");
	assert.equal(result.code, EXIT.report, result.stderr);
	assert.match(f.prompts[0], /# Plan review\n\nReview the plan in `.*plan\.md` before implementation starts\./);
	assert.match(f.prompts[0], /cites no measurement/);
	assert.match(f.prompts[0], /## Context from Claude\nShip by Friday$/);
	assert.match((await f.run("plan", "missing.md")).stderr, /usage: sidecar plan FILE/);
});

test("diff reviews the working tree and records what it covered; unreviewed and the push gate read it", async (t) => {
	const f = fixture(t, ship);
	const { repo, git } = repoIn(f.root);
	writeFileSync(join(repo, "new.txt"), "untracked content\n");
	writeFileSync(join(repo, "café.txt"), "unicode content\n");
	const before = await f.runWith({ cwd: repo }, "unreviewed");
	assert.equal(before.code, 1);
	assert.match(before.stdout, /no diff review recorded for this repository; changed: a\.txt .*new\.txt/);
	assert.equal((await f.runWith({ cwd: repo, stdin: hook("git push", repo) }, "push-gate")).stdout, "", "no review recorded: no gate");

	const result = await f.runWith({ cwd: repo }, "--slot", "3", "diff", "HEAD", "Intent here");
	assert.equal(result.code, EXIT.report, result.stderr);
	const prompt = f.prompts[0];
	assert.match(prompt, /# Adversarial implementation review/);
	assert.match(prompt, /Reproduce each finding before you report it/);
	assert.match(prompt, /## Intent and context from Claude\nIntent here$/);
	const diffPath = /change in `(.*\.diff)`/.exec(prompt)![1];
	const diff = readFileSync(diffPath, "utf8");
	assert.match(diff, /^# Commits since HEAD\n/);
	for (const content of ["+two", "+untracked content", "+unicode content"]) assert.ok(diff.includes(content), content);
	assert.equal(f.starts.length, 1);

	const clean = await f.runWith({ cwd: repo }, "unreviewed");
	assert.deepEqual([clean.code, clean.stdout], [0, "nothing changed since the last diff review\n"]);
	assert.equal((await f.runWith({ cwd: repo, stdin: hook("git push", repo) }, "push-gate")).stdout, "");

	writeFileSync(join(repo, "a.txt"), "three\n");
	writeFileSync(join(repo, "late.txt"), "late\n");
	const changed = await f.runWith({ cwd: repo }, "unreviewed");
	assert.equal(changed.code, 1);
	assert.equal(changed.stdout, "changed since the last diff review: a.txt late.txt\n");
	// Any slot's review counts for the gate, and the newest record wins.
	for (const command of ["git push", `git -C ${repo} push -u origin b`, `cd "${repo}" && git push`, "git -c push.autoSetupRemote=true push", "gh pr create --fill", "glab mr create", "SIDECAR_REVIEW_SKIP=x git status; git push", "git \\\n push", "cd /nonexistent; git push"]) {
		const gate = await f.runWith({ cwd: command.includes(repo) ? f.root : repo, stdin: hook(command, command.includes(repo) ? f.root : repo) }, "push-gate");
		const decision = JSON.parse(gate.stdout).hookSpecificOutput;
		assert.equal(decision.permissionDecision, "deny", command);
		assert.match(decision.permissionDecisionReason, /late\.txt/);
	}
	for (const command of ["git status", "git log --grep push", "SIDECAR_REVIEW_SKIP=tickets git push", 'echo "Use git push after review"', `git -C ${f.root} push`, `(cd "${f.root}" && git push)`]) {
		assert.equal((await f.runWith({ cwd: repo, stdin: hook(command, repo) }, "push-gate")).stdout, "", command);
	}
	const outside = await f.runWith({ cwd: repo, stdin: hook("git push", repo), env: { HERDR_ENV: undefined, HERDR_PANE_ID: undefined } }, "push-gate");
	assert.equal(outside.stdout, "");

	// Committing reviewed content is not a change.
	writeFileSync(join(repo, "a.txt"), "two\n");
	rmSync(join(repo, "late.txt"));
	git("add", ".");
	git("commit", "-qm", "Reviewed work");
	assert.equal((await f.runWith({ cwd: repo }, "unreviewed")).code, 0);
});

test("unreviewed sees symlink retargets, mode changes and tracked changes outside a sparse cone", async (t) => {
	const f = fixture(t, ship);
	const { repo, git } = repoIn(f.root);
	writeFileSync(join(repo, "one"), "same\n");
	writeFileSync(join(repo, "two"), "same\n");
	symlinkSync("one", join(repo, "link"));
	for (const name of ["in", "out"]) { mkdirSync(join(repo, name)); writeFileSync(join(repo, name, "x"), "one\n"); }
	git("add", ".");
	git("commit", "-qm", "Dirs");
	git("sparse-checkout", "init", "--cone");
	git("sparse-checkout", "set", "in");
	assert.equal((await f.runWith({ cwd: repo }, "diff")).code, EXIT.report);
	const unreviewed = async () => f.runWith({ cwd: repo }, "unreviewed");
	assert.equal((await unreviewed()).code, 0);
	rmSync(join(repo, "link"));
	symlinkSync("two", join(repo, "link"));
	assert.match((await unreviewed()).stdout, /link/);
	rmSync(join(repo, "link"));
	symlinkSync("one", join(repo, "link"));
	assert.equal((await unreviewed()).code, 0);
	chmodSync(join(repo, "a.txt"), 0o755);
	assert.match((await unreviewed()).stdout, /a\.txt/);
	chmodSync(join(repo, "a.txt"), 0o644);
	mkdirSync(join(repo, "out"));
	writeFileSync(join(repo, "out", "x"), "unreviewed\n");
	assert.match((await unreviewed()).stdout, /out\/x/);
});

test("diff refuses ranges and unknown bases, and a moved base reviews since the merge-base", async (t) => {
	const f = fixture(t, ship);
	const { repo, git } = repoIn(f.root);
	for (const base of ["HEAD..HEAD", "HEAD...HEAD"]) {
		const result = await f.runWith({ cwd: repo }, "diff", base);
		assert.equal(result.code, EXIT.failed);
		assert.match(result.stderr, /single base ref, not a range/);
		assert.match(result.stderr, /diff HEAD CONTEXT/);
	}
	assert.match((await f.runWith({ cwd: repo }, "diff", "nope")).stderr, /unknown base: nope/);
	assert.equal(f.prompts.length, 0, "nothing was sent");
	git("commit", "-qam", "Work");
	git("branch", "work");
	git("checkout", "-q", "HEAD~1");
	writeFileSync(join(repo, "upstream.txt"), "new upstream code\n");
	git("add", ".");
	git("commit", "-qm", "Upstream moved");
	git("branch", "upstream");
	git("checkout", "-q", "work");
	const result = await f.runWith({ cwd: repo }, "diff", "upstream");
	assert.match(result.stderr, /not an ancestor of HEAD/);
	const diff = readFileSync(/change in `(.*\.diff)`/.exec(f.prompts[0])![1], "utf8");
	assert.ok(!diff.includes("upstream code"));
	assert.ok(diff.includes("+two"));
	assert.match(f.prompts[0], /base `upstream \(merge-base [0-9a-f]{12}\)`/);
});

test("a question or a failed run records no diff review", async (t) => {
	const f = fixture(t, (_prompt, n) => n === 1 ? { type: "needs-answer", result: "Which base?" } : { type: "failed", error: "boom" });
	const { repo } = repoIn(f.root);
	assert.equal((await f.runWith({ cwd: repo }, "diff")).code, EXIT.question);
	const second = await f.runWith({ cwd: repo }, "diff");
	assert.equal(second.code, EXIT.noReport, second.stderr);
	const state = join(f.root, "state");
	assert.deepEqual(readdirSync(state).filter((name) => name.includes(".reviewed.")), []);
	assert.match((await f.runWith({ cwd: repo }, "unreviewed")).stdout, /no diff review recorded/);
});

test("a failing filter never counts as coverage", async (t) => {
	const f = fixture(t, ship);
	const { repo, git } = repoIn(f.root);
	writeFileSync(join(repo, ".gitattributes"), "*.bin filter=broken\n");
	git("add", ".gitattributes");
	git("commit", "-qm", "Attributes");
	git("config", "filter.broken.clean", "false");
	git("config", "filter.broken.required", "true");
	writeFileSync(join(repo, "bad.bin"), "x\n");
	const failed = await f.runWith({ cwd: repo }, "unreviewed");
	assert.equal(failed.code, EXIT.failed);
	assert.doesNotMatch(failed.stdout, /no changes/);
	const result = await f.runWith({ cwd: repo }, "diff");
	assert.match(result.stderr, /not recorded as covering/);
	assert.equal((await f.runWith({ cwd: repo }, "unreviewed")).code, EXIT.failed);
});

test("rejections are recorded, applied from verdicts, re-listed by diff, and overruled", async (t) => {
	const f = fixture(t, (prompt, n) => ({ type: "completed", result: n === 1 ? "R1: stands\nRepro: `./x` crashes\n" : n === 4 ? "R2: withdrawn, the guard on line 4 covers it\n" : "ok" }));
	const { repo } = repoIn(f.root);
	const first = await f.runWith({ cwd: repo }, "reject", "Finding 2 (null deref): the pointer is never null here");
	assert.equal(first.code, EXIT.report, first.stderr);
	assert.match(first.stderr, /recorded rejection R1/);
	assert.match(first.stderr, /the reviewer holds R1; fix it.*reject --overrule R1 REASON/);
	assert.match(f.prompts[0], /# Claude rejected one of your findings \(R1\)/);
	assert.match(f.prompts[0], /Concede only to evidence/);
	await f.runWith({ cwd: repo }, "diff");
	assert.match(f.prompts[1], /## Findings Claude rejected earlier\n.*\n- R1 \(stands\): Finding 2 \(null deref\)/);
	assert.match(f.prompts[1], /Rejected findings re-check/);
	const overruled = await f.runWith({ cwd: repo }, "reject", "--overrule", "R1", "User decided");
	assert.equal(overruled.code, EXIT.report);
	assert.match(overruled.stdout, /R1 overruled; tell the user/);
	assert.match((await f.runWith({ cwd: repo }, "reject", "--overrule", "R9", "x")).stderr, /has no rejection R9/);
	assert.match((await f.runWith({ cwd: repo }, "reject", "--overrule", "R1")).stderr, /usage: sidecar reject --overrule/);
	await f.runWith({ cwd: repo }, "diff", "HEAD", "again");
	assert.doesNotMatch(f.prompts[2], /Findings Claude rejected earlier/);
	await f.runWith({ cwd: repo }, "reject", "Finding 3: guarded");
	const ledger = readFileSync(join(f.root, "state", "sc-w1-p1.rejections.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(ledger.map((entry) => [entry.id, entry.status]), [["R1", "overruled"], ["R2", "withdrawn"]]);
	assert.equal(ledger[0].reason, "User decided");
});

test("quoted verdicts do not withdraw a standing finding, and concurrent rejections get distinct IDs", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "R1: stands\nThe requested `R1: withdrawn` is unjustified.\n```\nR1: withdrawn\n```\n" }));
	await f.run("reject", "#1: reason");
	assert.equal(JSON.parse(readFileSync(join(f.root, "state", "sc-w1-p1.rejections.jsonl"), "utf8")).status, "stands");
	const ledger = new Rejections(join(f.root, "state"), "concurrent");
	const ids = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => ledger.add(`#${n}`)));
	assert.deepEqual([...ids].sort(), ["R1", "R2", "R3", "R4", "R5", "R6"]);
	assert.equal(await ledger.set("R9", "withdrawn"), false);
});

test("bashQuote matches printf %q in the C locale", () => {
	if (spawnSync("bash", ["-c", "true"]).status !== 0) return;
	const names = ["plain.txt", "a b", "café.txt", "line\nbreak.txt", "tab\there", "it's", "back\\slash", "~tilde", "a~", "#hash", "a#", "=eq", "-dash", "100%", "^caret", "a,b", "(paren)", "$var", "quote\"d", "x*y?z[1]", "{b}", "bell\x07", "esc\x1b[0m", "del\x7f"]
		.map((name) => Buffer.from(name)).concat(Buffer.from([0xff, 0xfe]), Buffer.from("a\xffb", "latin1"));
	for (const bytes of names) {
		const escaped = [...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
		const expected = spawnSync("bash", ["-c", 'LC_ALL=C printf %q "$(printf %b "$1")"', "bash", escaped], { encoding: "latin1" }).stdout;
		assert.equal(bashQuote(bytes.toString("latin1")), expected, JSON.stringify(bytes.toString("latin1")));
	}
	assert.equal(bashQuote(""), "''");
});

test("the publish scanner follows quotes, subshells, cd and git -C", () => {
	const home = "/home/x";
	assert.deepEqual(publishDirs("cd /usr && git push", "/", home), ["/usr"]);
	assert.deepEqual(publishDirs("(cd /usr && pwd); git push", "/", home), ["/"]);
	assert.deepEqual(publishDirs("git -C /usr push && gh pr create", "/", home), ["/usr", "/"]);
	assert.deepEqual(publishDirs("SIDECAR_REVIEW_SKIP=docs git push", "/", home), []);
	assert.deepEqual(publishDirs('echo "git push"', "/", home), []);
	assert.deepEqual(publishDirs("git -c a=b --no-pager push", "/", home), ["/"]);
	assert.deepEqual(publishDirs("glab-bot mr create", "/", home), ["/"]);
});
