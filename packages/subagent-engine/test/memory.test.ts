import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { memoryDir, memoryIndex, memoryPathGuard } from "../src/memory.ts";

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

test("memory index is optional and bounded to 8k by default", t => {
	const { dir } = fixture(t);
	assert.equal(memoryIndex(dir), undefined);
	writeFileSync(join(dir, "MEMORY.md"), "x".repeat(9_000));
	assert.equal(memoryIndex(dir)?.length, 8_000);
	assert.equal(memoryIndex(dir, 3), "xxx");
	assert.equal(memoryIndex(dir, 0), "");
	assert.throws(() => memoryIndex(dir, -1), RangeError);
	assert.throws(() => memoryIndex(dir, NaN), RangeError);
	writeFileSync(join(dir, "MEMORY.md"), "a😀z");
	assert.equal(memoryIndex(dir, 2), "a");
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
