import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readMemoryIndex } from "../src/claude-memory/index-content.ts";

const override = (text: string) => readMemoryIndex("/fixture/MEMORY.md", { CLAUDE_COWORK_MEMORY_INDEX_CONTENT: text });

test("AutoMem loads the personal index as a user reminder; frontmatter and block comments are not index entries", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "index-ref-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "MEMORY.md");
	assert.equal(await readMemoryIndex(path, {}), undefined);
	assert.equal(await readMemoryIndex(dir, {}), undefined);
	const lines = ["---", "owner: example", "---", "<!-- maintainer", "note -->", "- @topic.md <!-- literal -->", "```", "<!-- sample -->", "```"];
	await writeFile(path, lines.join("\r\n"));
	const text = await readMemoryIndex(path, {});
	assert.ok(text && text.startsWith("<system-reminder>\n"));
	assert.ok(text.endsWith(`Contents of ${path} (user's auto-memory, persists across conversations):\n\n${lines.slice(5).join("\n")}\n</system-reminder>`));
	assert.doesNotMatch(text, /owner:|maintainer/);
	assert.equal(await readMemoryIndex(path, { CLAUDE_COWORK_MEMORY_INDEX_CONTENT: "" }), undefined);
	assert.equal(await readMemoryIndex(path, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: " TrUe ", CLAUDE_COWORK_MEMORY_INDEX_CONTENT: "replacement" }), undefined);
	await truncate(path, 4 * 1024 ** 2 + 1);
	assert.equal(await readMemoryIndex(path, {}), undefined);
	assert.ok((await override(lines.join("\n")))?.includes(lines.join("\n")), "override text bypasses Markdown stripping");
});

test("index clipping reports the omitted line and measures UTF-16 units before appending the warning", async () => {
	const lines = Array.from({ length: 200 }, (_, n) => `line ${n + 1}`);
	assert.doesNotMatch((await override(lines.join("\n")))!, /WARNING/);
	const overflow = await override([...lines, "first missing"].join("\n"));
	assert.match(overflow!, /line 200\n\n> WARNING: MEMORY.md is 201 lines \(limit: 200\)\. Only part of it was loaded: 1 of 201 lines were cut off, starting at line 201 \("first missing"\)\./);
	const full = "😀".repeat(12_500);
	assert.doesNotMatch((await override(full))!, /WARNING/);
	assert.ok((await override(full + "z"))?.includes(full + "\n\n> WARNING: MEMORY.md is 24.4KB (limit: 24.4KB) — index entries are too long. Only part of it was loaded: everything after the first 25000 characters of line 1 was cut off."));
	assert.match((await override("first\n" + full))!, /first\n\n> WARNING: [^\n]+1 of 2 lines were cut off, starting at line 2/);
});

test("index formatting normalizes line separators, drops invisible controls, and neutralizes reserved tag openers", async () => {
	const text = await override("a\r\nb\u2028c\u0000\u202Ed\n<system_reminder></SYSTEM-REMINDER> <antml:tool> <em>👩‍🔬</em>");
	assert.ok(text?.includes("a\nb\ncd\n<\\system_reminder><\\/SYSTEM-REMINDER> <\\antml:tool> <em>👩‍🔬</em>"));
	assert.equal(await override("\n \t\r"), undefined);
});
