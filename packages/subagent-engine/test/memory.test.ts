import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { memoryDir, memoryIndex, memoryPathGuard, memoryRootContained } from "../src/memory.ts";

function fixture(t: TestContext) {
	const captures = resolve(import.meta.dirname, "../../../captures");
	mkdirSync(captures, { recursive: true });
	const root = mkdtempSync(join(captures, "memory-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
	const dir = join(root, "memory");
	mkdirSync(dir);
	return { root, dir };
}

test("memory directories map each scope without changing project instruction files", t => {
	const { root } = fixture(t);
	const input = { agentDir: join(root, "user"), cwd: join(root, "project"), agentType: "Explore" };
	assert.equal(memoryDir("user", input), join(input.agentDir, "agent-memory", "Explore"));
	assert.equal(memoryDir("project", input), join(input.cwd, ".pi", "agent-memory", "Explore"));
	assert.equal(memoryDir("local", input), join(input.cwd, ".pi", "agent-memory-local", "Explore"));
});

test("agent types cannot traverse directories or collide after escaping", t => {
	const { root } = fixture(t);
	const input = { agentDir: root, cwd: root, agentType: "" };
	const names = ["../outside", "..", ".", "a/b", "a\\b", "pkg:review", "pkg%3Areview", "CON", "%43ON", "trailing.", "name with spaces"];
	const paths = names.map(agentType => memoryDir("user", { ...input, agentType }));
	assert.equal(new Set(paths).size, names.length);
	for (const path of paths) assert.equal(resolve(path, ".."), join(root, "agent-memory"));
	assert.throws(() => memoryDir("user", input), /nonempty/);
});

test("memory index is optional and bounded to 200 lines and 25k units by default", t => {
	const { dir } = fixture(t);
	assert.equal(memoryIndex(dir), undefined);
	writeFileSync(join(dir, "MEMORY.md"), "x".repeat(30_000));
	assert.equal(memoryIndex(dir)?.length, 25_000);
	assert.equal(memoryIndex(dir, 3), "xxx");
	assert.equal(memoryIndex(dir, 0), "");
	assert.throws(() => memoryIndex(dir, -1), RangeError);
	assert.throws(() => memoryIndex(dir, NaN), RangeError);
	writeFileSync(join(dir, "MEMORY.md"), "a😀z");
	assert.equal(memoryIndex(dir, 2), "a");
	writeFileSync(join(dir, "MEMORY.md"), Array.from({ length: 210 }, () => "line").join("\n"));
	assert.equal(memoryIndex(dir)?.split("\n").length, 200);
	writeFileSync(join(dir, "MEMORY.md"), "x".repeat(100_001));
	assert.equal(memoryIndex(dir), undefined);
});

test("memory-only tools allow absolute internal paths, including new nested files", t => {
	const { dir } = fixture(t);
	const guard = memoryPathGuard(dir);
	for (const tool of ["read", "write", "edit", "Read", "Write", "Edit"]) {
		assert.equal(guard(tool, { path: join(dir, "new", "nested.md") }), undefined);
	}
	assert.equal(guard("write", { file_path: join(dir, "legacy.md") }), undefined);
	assert.equal(guard("write", { path: join(dir, "nested", "..", "notes.md") }), undefined);
	assert.equal(guard("bash", { command: "ignored by this file-tool guard" }), undefined);
});

test("guards fail closed for outside, traversal, prefix-sibling and invalid paths", t => {
	const { root, dir } = fixture(t);
	const guard = memoryPathGuard(dir);
	for (const path of [join(root, "outside.md"), join(`${dir}-sibling`, "file.md"), resolve(dir, "..", "outside.md"), "notes.md", "../notes.md", "", null, 42, `${dir}\0bad`]) {
		assert.equal(typeof guard("write", { path }), "string", String(path));
	}
	assert.equal(typeof guard("read", {}), "string");
	assert.equal(typeof guard("write", { path: join(dir, "safe.md"), file_path: join(root, "outside.md") }), "string");
});

test("a not-yet-created memory directory still has a confined boundary", t => {
	const { root } = fixture(t);
	const dir = join(root, "missing", "memory");
	const guard = memoryPathGuard(dir);
	assert.equal(guard("write", { path: join(dir, "new.md") }), undefined);
	assert.equal(typeof guard("write", { path: join(root, "new.md") }), "string");
});

test("directory symlinks cannot redirect new memory files outside the boundary", t => {
	const { root, dir } = fixture(t);
	const outside = join(root, "outside");
	mkdirSync(outside);
	symlinkSync(outside, join(dir, "escape"), process.platform === "win32" ? "junction" : "dir");
	const guard = memoryPathGuard(dir);
	assert.equal(typeof guard("write", { path: join(dir, "escape", "new", "file.md") }), "string");
	assert.equal(typeof guard("read", { path: join(dir, "escape") }), "string");
});

for (const scope of ["project", "local"] as const) {
	for (const linkedAncestor of ["root", "scope-parent", "pi-parent"] as const) {
		test(`${scope} memory rejects an escaping ${linkedAncestor} before loading an index or allowing tools`, t => {
			const { root } = fixture(t);
			const cwd = join(root, "project");
			const outside = join(root, "outside");
			mkdirSync(cwd);
			mkdirSync(outside);
			const dir = memoryDir(scope, { agentDir: root, cwd, agentType: "worker" });
			const link = linkedAncestor === "root" ? dir : linkedAncestor === "scope-parent" ? resolve(dir, "..") : join(cwd, ".pi");
			mkdirSync(resolve(link, ".."), { recursive: true });
			symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "MEMORY.md"), "must not be loaded");
			assert.equal(memoryRootContained(dir, cwd), false);
			assert.equal(memoryIndex(dir, 25_000, cwd), undefined);
			for (const tool of ["read", "write", "edit"]) assert.equal(typeof memoryPathGuard(dir, cwd)(tool, { path: join(dir, "MEMORY.md") }), "string");
			// User memory retains its existing ability to use a symlinked root.
			assert.equal(memoryIndex(dir), "must not be loaded");
			assert.equal(memoryPathGuard(dir)("write", { path: join(dir, "new.md") }), undefined);
		});
	}

	test(`${scope} memory permits missing safe directories but rejects later ancestor redirection`, t => {
		const { root } = fixture(t);
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const dir = memoryDir(scope, { agentDir: root, cwd, agentType: "worker" });
		assert.equal(memoryRootContained(dir, cwd), true);
		assert.equal(memoryIndex(dir, 25_000, cwd), undefined);
		const guard = memoryPathGuard(dir, cwd);
		assert.equal(guard("write", { path: join(dir, "new", "topic.md") }), undefined);
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(cwd, ".pi"), process.platform === "win32" ? "junction" : "dir");
		assert.equal(typeof guard("write", { path: join(dir, "new", "topic.md") }), "string");
	});
}

test("project memory rejects dangling ancestors and unresolved working copies", t => {
	const { root } = fixture(t);
	const cwd = join(root, "project");
	mkdirSync(cwd);
	const dir = memoryDir("project", { agentDir: root, cwd, agentType: "worker" });
	symlinkSync(join(root, "missing"), join(cwd, ".pi"), process.platform === "win32" ? "junction" : "dir");
	assert.equal(memoryRootContained(dir, cwd), false);
	assert.equal(memoryIndex(dir, 25_000, cwd), undefined);
	assert.equal(memoryRootContained(join(root, "missing", "memory"), join(root, "missing")), false);
});

test("memory index does not follow a file symlink outside memory", t => {
	const { root, dir } = fixture(t);
	const outside = join(root, "secret.md");
	writeFileSync(outside, "outside memory");
	try { symlinkSync(outside, join(dir, "MEMORY.md"), "file"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("File symlinks require privileges on this Windows host"); return; }
		throw error;
	}
	assert.equal(memoryIndex(dir), undefined);
	assert.equal(typeof memoryPathGuard(dir)("read", { path: join(dir, "MEMORY.md") }), "string");
	assert.equal(readFileSync(outside, "utf8"), "outside memory");
});
