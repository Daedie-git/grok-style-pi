import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { INSERT_BG } from "../src/rendering/diff-render.ts";
import { withWriteSummary, writeSummary, countLines } from "../src/tools/write-summary.ts";
import { wrapWithDiamondRenderer } from "../src/tools/renderer.ts";

const theme = { fg: (token: string, text: string) => `\x1b[${token === "toolDiffAdded" ? 32 : token === "toolDiffRemoved" ? 31 : 90}m${text}\x1b[0m` };

test("writes distinguish new files from replacements and render contents or colored diffs", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "grok-write-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const tool = wrapWithDiamondRenderer(withWriteSummary(createWriteToolDefinition, cwd));
	for (const [content, verb] of [["old\nline\n", "Creating"], ["new\nline\n", "Replaced"]]) {
		const args = { path: "helpers.ts", content, description: "Fury control helpers\x1b]52;c;attack\x07" };
		const context = { args, state: {} };
		const header = tool.renderCall(args, theme, context);
		const result = await tool.execute("write", args, undefined, undefined, { cwd } as any);
		assert.equal(await readFile(join(cwd, args.path), "utf8"), content);
		const initial = tool.renderResult(result, { expanded: false }, theme, context).render(100);
		if (verb === "Creating") {
			assert.match(initial.join("\n"), /\x1b\[32m\+1 /);
			assert.match(stripTerminalSequences(initial.join("\n")), /\+1 old/);
		}
		else assert.deepEqual(initial, []);
		const headerText = stripTerminalSequences(header.render(100)[0]);
		if (verb === "Creating") assert.equal(headerText, "◆ Creating helpers.ts");
		else assert.equal(headerText, `◆ ${verb} helpers.ts · 2 lines · Fury control helpers`);
		assert.ok(visibleWidth(header.render(20)[0]) <= 20);
		const output = tool.renderResult(result, { expanded: true }, theme, context).render(100).join("\n");
		assert.doesNotMatch(output, /Successfully wrote|attack|\x1b\]/);
		if (verb === "Creating") {
			assert.match(output, new RegExp(`\\x1b\\[48;2;${INSERT_BG}m`));
			assert.match(stripTerminalSequences(output), /\+1 old\s+\n\s+\+2 line/);
		}
		else {
			assert.match(output, /\x1b\[31m-/);
			assert.match(output, /\x1b\[32m\+/);
			assert.match(stripTerminalSequences(output), /old/);
			assert.match(stripTerminalSequences(output), /new/);
		}
	}
});

test("concurrent writes to one path snapshot the preceding queued write", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "grok-write-queue-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const tool = withWriteSummary(createWriteToolDefinition, cwd);
	const [a, b] = await Promise.all([tool.execute("a", { path: "file", content: "first\n" }), tool.execute("b", { path: "file", content: "second\n" })]);
	assert.equal(writeSummary(a.details)?.kind, "created");
	assert.equal(writeSummary(b.details)?.kind, "replaced");
	assert.match((b.details as any).diff, /-.*first/);
	assert.match((b.details as any).diff, /\+.*second/);
});

test("custom write operations are preserved without inspecting the local namesake", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "grok-write-remote-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "file"), "local private contents");
	let remote = "";
	const tool = withWriteSummary(createWriteToolDefinition, cwd, { operations: { mkdir: async () => {}, writeFile: async (_path, content) => { remote = content; } } });
	const result = await tool.execute("remote", { path: "file", content: "remote contents" });
	assert.equal(remote, "remote contents");
	assert.equal(writeSummary(result.details)?.kind, "unknown");
	assert.doesNotMatch(JSON.stringify(result), /local private/);
	assert.equal(await readFile(join(cwd, "file"), "utf8"), "local private contents");
});

test("large-file previews are bounded and failed writes still fail", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "grok-write-limits-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "large"), "x".repeat(100_000));
	const tool = withWriteSummary(createWriteToolDefinition, cwd);
	const result = await tool.execute("large", { path: "large", content: "y".repeat(100_000) });
	assert.equal(writeSummary(result.details)?.kind, "replaced");
	assert.equal(writeSummary(result.details)?.preview.length, 16_000);
	assert.match(writeSummary(result.details)?.note ?? "", /truncated/);
	await mkdir(join(cwd, "directory"));
	await assert.rejects(tool.execute("fail", { path: "directory", content: "cannot write" }));
	assert.deepEqual(["", "one", "one\n", "one\ntwo\n"].map(countLines), [0, 1, 1, 2]);
});

test("legacy writes expand recorded contents without guessing their previous state", () => {
	const tool = wrapWithDiamondRenderer(createWriteToolDefinition(process.cwd()));
	const context = { args: { path: "old.ts", content: "export const value = 1;" }, state: {} };
	const result = { content: [{ type: "text", text: "Successfully wrote to old.ts" }] };
	const output = tool.renderResult(result, { expanded: true }, theme, context).render(100).join("\n");
	assert.match(output, /Previous contents were not recorded/);
	assert.match(stripTerminalSequences(output), /export const value = 1;/);
	assert.doesNotMatch(output, /Successfully wrote/);
});

test("created file diamonds start open, toggle locally and follow global expansion", () => {
	const tool = wrapWithDiamondRenderer(createWriteToolDefinition(process.cwd()));
	let invalidations = 0;
	const context = { args: { path: "new.ts", content: "hello\n" }, state: {}, expanded: false, invalidate: () => invalidations++ };
	const result = { content: [{ type: "text", text: "Successfully wrote" }], details: { grokWrite: { kind: "created", lines: 1, preview: "hello\n" } } };
	const render = () => tool.renderResult(result, { expanded: context.expanded }, theme, context).render(80);
	assert.match(render().join("\n"), /\x1b\[32m\+1 /);
	assert.match(render().join("\n"), new RegExp(`\\x1b\\[48;2;${INSERT_BG}m`));
	assert.match(stripTerminalSequences(render().join("\n")), /\+1 hello/);
	assert.equal(stripTerminalSequences(tool.renderCall(context.args, theme, context).render(80)[0]), "◆ Creating new.ts");
	const header = tool.renderCall(context.args, theme, context) as any;
	header.handleMouse({ type: "click", button: "left" });
	assert.ok(render().length);
	header.handleMouse({ type: "click", button: "left", alt: true });
	assert.deepEqual(render(), []);
	assert.equal(stripTerminalSequences(header.render(80)[0]), "◆ Creating new.ts +1/-0");
	header.handleMouse({ type: "click", button: "left" });
	assert.ok(render().length);
	assert.equal(invalidations, 2);
	context.expanded = true;
	assert.ok(render().length);
	context.expanded = false;
	assert.deepEqual(render(), []);
});
