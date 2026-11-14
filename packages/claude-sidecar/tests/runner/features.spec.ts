import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../../src/cli.ts";
import { globMatch } from "../../src/checks.ts";
import { fixture } from "./fixture.ts";

function repoIn(root: string) {
	const repo = join(root, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => { const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-qm", "Initial");
	writeFileSync(join(repo, "a.txt"), "two\n");
	return repo;
}

const reportPath = (stdout: string) => /^# Sidecar report \((.+)\)$/m.exec(stdout)![1];

test("an implementer ask carries the completion contract, and the launcher runs its checks after the report", async (t) => {
	let repo = "";
	const f = fixture(t, () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "in.txt"), "x\n");
		writeFileSync(join(repo, "outside.txt"), "x\n");
		return { type: "completed", result: "## Verdict\nship" };
	});
	repo = repoIn(f.root);
	const result = await f.runWith({ cwd: repo }, "--role", "implementer", "ask", "--accept", "echo accepted-output; exit 3", "--accept", "true", "--scope", "src/*", "Implement it");
	assert.equal(result.code, EXIT.report, result.stderr);
	assert.match(result.stderr, /running launcher checks/);
	assert.match(f.prompts[0], /## Completion contract/);
	assert.match(f.prompts[0], /the launcher runs `echo accepted-output; exit 3` itself in `.*repo`/);
	assert.match(f.prompts[0], /Scope: change only files matching `src\/\*`/);
	const [checks, verdict] = result.stdout.split("## Verdict");
	assert.match(checks, /\*\*Outside the stated scope:\*\* outside\.txt\n/);
	assert.ok(!checks.includes("a.txt"), "files dirty before the task are not flagged");
	assert.ok(!checks.includes("in.txt"));
	assert.match(checks, /- Acceptance `echo accepted-output; exit 3`: \*\*FAIL, exit 3\*\* \(log: .*\.accept-1\.log\)\n\n```\naccepted-output\n```/);
	assert.match(checks, /- Acceptance `true`: \*\*PASS\*\*/);
	assert.match(verdict, /ship/);
	const saved = readFileSync(reportPath(result.stdout), "utf8");
	assert.ok(saved.startsWith("## Launcher checks"));
	assert.ok(saved.includes("## Verdict"));
	// Checks persist for follow-ups, answers and idle steers until cleared.
	const again = await f.runWith({ cwd: repo }, "ask", "Fix the failure");
	assert.match(again.stdout, /Launcher checks/);
	assert.match(f.prompts[1], /launcher runs `true` itself/);
	const steered = await f.runWith({ cwd: repo }, "steer", "Tidy up");
	assert.match(steered.stdout, /Launcher checks/);
	const cleared = await f.runWith({ cwd: repo }, "ask", "--no-checks", "Something else");
	assert.doesNotMatch(cleared.stdout, /Launcher checks/);
	assert.doesNotMatch(f.prompts[3], /the launcher runs/);
	assert.match(f.prompts[3], /## Completion contract/);
});

test("scope sees a dirty file the task reverted, real names, and a multi-line acceptance command", async (t) => {
	let repo = "";
	const f = fixture(t, () => {
		writeFileSync(join(repo, "a.txt"), "rewritten\n");
		mkdirSync(join(repo, "my dir"), { recursive: true });
		writeFileSync(join(repo, "my dir", "new.txt"), "x\n");
		return { type: "completed", result: "## Verdict\nship" };
	});
	repo = repoIn(f.root);
	mkdirSync(join(repo, "sub"));
	writeFileSync(join(repo, "sub", "expected"), "x");
	const result = await f.runWith({ cwd: repo }, "--role", "implementer", "ask", "--scope", "my dir/*", "--accept", "cd sub\ntest -f expected", "Task");
	assert.match(result.stdout, /\*\*Outside the stated scope:\*\* a\.txt\n/);
	assert.doesNotMatch(result.stdout.split("## Verdict")[0], /new\.txt/);
	assert.equal(result.stdout.split("Acceptance `").length - 1, 1);
	assert.match(result.stdout, /\*\*PASS\*\*/);
});

test("a reviewer ask has no contract, checks need a checkout, and acceptance children neither hold the slot nor outlive their timeout", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "ok" }));
	const repo = repoIn(f.root);
	const pid = join(f.root, "child.pid");
	const result = await f.runWith({ cwd: repo, env: { SIDECAR_ACCEPT_TIMEOUT_S: "1" } }, "ask", "--accept", `sleep 30 >/dev/null 2>&1 & echo $! >"${pid}"`, "--accept", "sleep 20", "Look");
	try { process.kill(Number(readFileSync(pid, "utf8")), "SIGTERM"); } catch {}
	assert.equal(result.code, EXIT.report, result.stderr);
	assert.doesNotMatch(f.prompts[0], /Completion contract/);
	assert.match(result.stdout, /`sleep 20`: \*\*FAIL, exit 124\*\*/);
	assert.match((await f.run("ask", "--accept")).stderr, /--accept requires a command/);
	assert.match((await f.run("ask", "--scope", "")).stderr, /--scope requires a path glob/);
	const outside = mkdtempSync(join(tmpdir(), "sidecar-nogit-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	assert.match((await f.runWith({ cwd: outside }, "ask", "--accept", "true", "Look")).stderr, /need a git checkout/);
});

test("scope globs follow Bash: * crosses directories", () => {
	assert.ok(globMatch("src/a/b.ts", "src/*"));
	assert.ok(globMatch("my dir/new.txt", "my dir/*"));
	assert.ok(!globMatch("other/a.ts", "src/*"));
	assert.ok(globMatch("a.c", "?.[ch]"));
	assert.ok(!globMatch("a.x", "?.[ch]"));
	assert.ok(globMatch("a.x", "?.[!ch]"));
	assert.ok(globMatch("a+b", "a+b"));
});

test("keep and unkeep pin the runner agent; ask --keep pins an existing slot", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "ok" }));
	assert.match((await f.run("keep")).stderr, /no sidecar in slot 1/);
	assert.equal((await f.run("ask", "first")).code, EXIT.report);
	const kept = async () => (await f.store()!.listAgents())[0].keep;
	assert.notEqual(await kept(), true);
	assert.match((await f.run("keep")).stdout, /^pinned: sidecar-1-adversarial-reviewer/);
	assert.equal(await kept(), true);
	assert.match((await f.run("unkeep")).stdout, /^unpinned/);
	assert.equal(await kept(), false);
	assert.equal((await f.run("ask", "--keep", "second")).code, EXIT.report);
	assert.equal(await kept(), true);
	assert.match((await f.run("keep", "extra")).stderr, /usage: sidecar \[--slot N\] keep\|unkeep/);
});

test("session-start moves the pane's sidecars to the cleared conversation", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "ok" }));
	const owner = async () => (await f.store()!.listAgents())[0].parentSessionFile;
	assert.equal((await f.run("session-start")).code, EXIT.report);
	assert.equal((await f.run("ask", "first")).code, EXIT.report);
	const first = await owner();
	assert.match(first!, /0b0c0d0e-0000-4000-8000-00000000000a\.jsonl$/);
	// The hook needs the host CLI and an agent CLI on PATH.
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	for (const name of ["herdr", "pi"]) writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
	const hook = (input: object, env?: Record<string, string | undefined>) => f.runWith({ stdin: JSON.stringify(input), env: { PATH: bin, ...env } }, "session-start");
	// Resuming the same conversation changes nothing.
	assert.match((await hook({ session_id: "s1", transcript_path: first, source: "resume" })).stdout, /"hookEventName":"SessionStart".*Persistent pi and Claude Code sidecars/);
	assert.equal(await owner(), first);
	const cleared = await hook({ session_id: "s2", transcript_path: "/claude/projects/p/s2.jsonl", source: "clear" });
	assert.deepEqual([cleared.code, cleared.stderr], [0, ""]);
	assert.equal(await owner(), "/claude/projects/p/s2.jsonl");
	// Without transcript_path the session ID names the transcript; a session that changed for the pane counts too.
	await hook({ session_id: "s3", source: "startup" });
	assert.match((await owner())!, /projects\/s3\.jsonl$/);
	// Outside a pane the hook does nothing.
	const outside = await hook({ session_id: "s4", transcript_path: "/x/s4.jsonl", source: "clear" }, { HERDR_ENV: undefined, HERDR_PANE_ID: undefined });
	assert.deepEqual([outside.code, outside.stdout], [EXIT.report, ""]);
	assert.match((await hook({ session_id: "s5" }, { PATH: join(f.root, "none") })).stderr, /missing dependency herdr/);
	assert.match((await owner())!, /projects\/s3\.jsonl$/);
});

test("local Pi sidecars load the repository's .claude/skills", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "ok" }));
	const repo = repoIn(f.root);
	mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
	assert.equal((await f.runWith({ cwd: join(repo) }, "ask", "x")).code, EXIT.report);
	const skills = join(repo, ".claude", "skills");
	assert.deepEqual((await f.store()!.listAgents())[0].skills, [skills]);
	assert.ok(f.starts[0].join(" ").includes(`--skill ${skills}`));
});

test("a Fleet profile maps its prompt, tools and skills onto the sidecar, and binds the slot", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "ok" }));
	const skill = join(f.root, "skills", "x");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "# x\n");
	const write = (name: string, overrides: object = {}) => {
		const path = join(f.root, name);
		writeFileSync(path, JSON.stringify({ version: 1, role: "implementer", prompt: "Implement only the assigned change.", allow: ["grep", "bash"], deny: ["bash"], skills: ["~/skills/x"], mcp: false, ...overrides }));
		return path;
	};
	const ask = (profile: string | undefined, ...rest: string[]) => f.runWith({ env: { HOME: f.root } }, ...(profile ? ["--profile-file", profile] : []), ...rest);
	const profile = write("profile.json");
	assert.equal((await ask(profile, "ask", "Build it")).code, EXIT.report);
	const agent = (await f.store()!.listAgents())[0];
	assert.equal(agent.type, "implementer");
	assert.deepEqual(agent.allowedTools, ["grep", "read"], "denied tools drop out; read is always allowed");
	assert.deepEqual(agent.skills, [skill]);
	assert.match(agent.instructions!, /Sidecar protocol[\s\S]*Implement only the assigned change\.$/);
	assert.doesNotMatch(agent.instructions!, /Be adversarial/);
	// The slot keeps its conversation: follow-ups may omit the profile, never change it.
	assert.equal((await ask(undefined, "ask", "More")).code, EXIT.report);
	assert.equal((await ask(profile, "ask", "Again")).code, EXIT.report);
	assert.match((await ask(write("other.json", { prompt: "Different." }), "ask", "x")).stderr, /slot profile differs; use stop --fresh/);
	assert.match((await ask(profile, "--role", "reviewer", "ask", "x")).stderr, /--role conflicts with profile role implementer/);
	assert.equal((await ask(undefined, "stop", "--fresh")).code, EXIT.report);
	assert.match((await ask(undefined, "status")).stdout, /no runner sidecars/, "a fresh reset frees the slot for another profile");
});

test("a profile cannot attach to an unprofiled conversation, and anything the runner cannot enforce is refused", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "ok" }));
	const write = (overrides: object) => {
		const path = join(f.root, "p.json");
		writeFileSync(path, JSON.stringify({ version: 1, role: "reviewer", prompt: "p", allow: null, deny: [], skills: [], mcp: false, ...overrides }));
		return path;
	};
	const refuse = async (overrides: object, pattern: RegExp, ...rest: string[]) => {
		const result = await f.run("--profile-file", write(overrides), ...rest, "ask", "x");
		assert.equal(result.code, EXIT.failed);
		assert.match(result.stderr, pattern);
	};
	await refuse({ mcp: true }, /mcp: true cannot be honored/);
	await refuse({ allow: ["mcp__*"] }, /allow pattern mcp__\* cannot be honored/);
	await refuse({ deny: ["re*"] }, /cannot deny mandatory tool read/);
	await refuse({ deny: ["submit_review"] }, /cannot deny mandatory tool submit_review/);
	await refuse({ extra: 1 }, /invalid version 1 role profile/);
	await refuse({ skills: ["relative/skill"] }, /invalid version 1 role profile/);
	await refuse({ allow: ["a b"] }, /invalid version 1 role profile/);
	await refuse({ skills: ["/nonexistent/skill"] }, /profile skill must be a Markdown file or a directory with regular SKILL\.md: \/nonexistent\/skill/);
	await refuse({ role: "implementer" }, /--role conflicts with profile role implementer/, "--role", "reviewer");
	await refuse({}, /role profiles support --agent pi only/, "--agent", "claude");
	assert.match((await f.run("--profile-file", join(f.root, "none.json"), "ask", "x")).stderr, /profile file does not exist/);
	assert.equal(f.starts.length, 0, "nothing was started");
	// An allow-less profile starts from Pi's default tools.
	assert.equal((await f.run("--profile-file", write({ deny: ["edit", "wr*"] }), "ask", "x")).code, EXIT.report);
	assert.deepEqual((await f.store()!.listAgents())[0].allowedTools, ["read", "bash"]);
	assert.match((await f.run("--profile-file", write({ prompt: "q" }), "ask", "x")).stderr, /slot profile differs/);
});

test("an unprofiled conversation cannot adopt a profile", async (t) => {
	const f = fixture(t, () => ({ type: "completed", result: "ok" }));
	assert.equal((await f.run("ask", "x")).code, EXIT.report);
	const path = join(f.root, "p.json");
	writeFileSync(path, JSON.stringify({ version: 1, role: "reviewer", prompt: "p", allow: [], deny: [], skills: [], mcp: false }));
	assert.match((await f.run("--profile-file", path, "ask", "y")).stderr, /cannot attach a profile to an unprofiled conversation; use stop --fresh first/);
	assert.equal(f.prompts.length, 1);
});

test("only an interactive Claude ancestor owns sidecars", async () => {
	const { claudeAncestry } = await import("../../src/hook.ts");
	const proc = mkdtempSync(join(tmpdir(), "sidecar-proc-"));
	try {
		const process = (pid: number, parent: number, ...argv: string[]) => {
			mkdirSync(join(proc, String(pid)));
			writeFileSync(join(proc, String(pid), "cmdline"), argv.join("\0") + "\0");
			writeFileSync(join(proc, String(pid), "stat"), `${pid} (x y) S ${parent} 0`);
		};
		process(10, 1, "/usr/bin/claude", "--dangerously-skip-permissions");
		process(11, 10, "bash", "-c", "hook");
		process(20, 1, "node", "/opt/claude-code/cli.js", "-p", "hi");
		process(21, 20, "bash");
		process(30, 1, "claude", "--name", "claude-sidecar");
		process(40, 1, "bash");
		assert.equal(claudeAncestry(11, proc), 0);
		assert.equal(claudeAncestry(21, proc), 1);
		assert.equal(claudeAncestry(30, proc), 1);
		assert.equal(claudeAncestry(40, proc), 2);
		assert.equal(claudeAncestry(99, proc), 2);
	} finally { rmSync(proc, { recursive: true, force: true }); }
});
