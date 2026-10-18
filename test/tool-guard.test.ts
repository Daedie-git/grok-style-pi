import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installToolGuard, needsTestTimeout, scratchTmpdir, tmpWriteReason } from "../src/extension/tool-guard.ts";

test("commands that store files in /tmp are refused; reads and cleanup are not", () => {
	for (const command of [
		"echo hi > /tmp/x.txt",
		"git diff main >/tmp/review.diff",
		"cp build.log /tmp/",
		"mkdir -p /tmp/cloth-forces-review && cd /tmp/cloth-forces-review",
		"TMPDIR=/tmp make",
		"curl -o /tmp/file https://example.com",
		"cmake --build build 2>&1 | tee /tmp/build.log",
		"find . -type f -fprint /tmp/results",
		"find . -exec cp '{}' /tmp/ ';'",
		"cd /tmp && git clone x",
		"git worktree add /tmp/review main",
		"python3 -c 'open(\"/tmp/x\", \"w\")'",
	]) assert.ok(tmpWriteReason(command), command);
	for (const command of [
		"ls -la /tmp",
		"du -sh /tmp/* | sort -h",
		"rm -rf /tmp/old-review",
		"cat /tmp/claude-1000/notes.md",
		"echo done > captures/out.txt",
		"grep -r tmp src/",
		"ls ./tmp/cache",
		"grep 'one|/tmp/claude-1000' README.md",
		"cat <<'EOF'\n/tmp/example is a path\nEOF",
		"echo 'see /tmp/x' && ls",
		"find /tmp/old -delete",
	]) assert.equal(tmpWriteReason(command), undefined, command);
});

test("test runners need a timeout unless one is given", () => {
	for (const command of ["ctest -j2 -LE gpu", "cd build && ./renderer_tests", "npm test", "just test-gpu", "pytest -x", "timeout 60 npm test && pytest", "echo --timeout; ctest"])
		assert.ok(needsTestTimeout(command), command);
	for (const command of ["timeout 600 ctest -j2", "ctest --timeout 300", "cmake --build build", "git log -- tests/"])
		assert.ok(!needsTestTimeout(command), command);
});

test("bash commands get a TMPDIR on disk; Pi's own TMPDIR is untouched", () => {
	const dir = mkdtempSync(join(process.cwd(), ".guard-test-"));
	const saved = { tmp: process.env.TMPDIR, cache: process.env.XDG_CACHE_HOME };
	try {
		process.env.TMPDIR = "/tmp";
		process.env.XDG_CACHE_HOME = dir;
		const pi = { on() {} } as unknown as ExtensionAPI;
		installToolGuard(pi, { platform: "linux" });
		assert.equal(process.env.TMPDIR, "/tmp");
		assert.equal(scratchTmpdir({ command: "x", cwd: "/", env: { TMPDIR: "/tmp" } }).env.TMPDIR, join(dir, "pi-tmp"));
		assert.equal(scratchTmpdir({ command: "x", cwd: "/", env: {} }).env.TMPDIR, join(dir, "pi-tmp"));
		assert.equal(scratchTmpdir({ command: "x", cwd: "/", env: { TMPDIR: "/data/t" } }).env.TMPDIR, "/data/t");
	} finally {
		for (const [key, value] of [["TMPDIR", saved.tmp], ["XDG_CACHE_HOME", saved.cache]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the guard blocks /tmp writes and adds test timeouts", () => {
	let handler: ((event: any, ctx: any) => any) | undefined;
	const pi = { on(name: string, h: typeof handler) { assert.equal(name, "tool_call"); handler = h; } } as unknown as ExtensionAPI;
	installToolGuard(pi, { testTimeoutS: 60, platform: "linux" });
	const ctx = { cwd: "/tmp" };
	assert.equal(handler!({ toolName: "write", input: { path: "notes.md" } }, ctx).block, true, "relative path resolved against a /tmp cwd");
	assert.equal(handler!({ toolName: "edit", input: { path: "/home/u/x" } }, ctx), undefined);
	assert.match(handler!({ toolName: "bash", input: { command: "echo > /tmp/a" } }, ctx).reason, /captures\//);
	const run = { toolName: "bash", input: { command: "ctest -j2" } as { command: string; timeout?: number } };
	assert.equal(handler!(run, ctx), undefined);
	assert.equal(run.input.timeout, 60);
	const explicit = { toolName: "bash", input: { command: "ctest -j2", timeout: 5 } };
	handler!(explicit, ctx);
	assert.equal(explicit.input.timeout, 5);
});

test("the guard is inactive on Windows", () => {
	const pi = { on() { assert.fail("no handler on Windows"); } } as unknown as ExtensionAPI;
	installToolGuard(pi, { platform: "win32" });
});
