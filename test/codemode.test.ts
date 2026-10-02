import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerStyledCodemode } from "../src/tools/codemode.ts";
import { wrapWithDiamondRenderer } from "../src/tools/renderer.ts";

const theme = { fg: (_token: string, value: string) => value };
const original = {
	name: "codemode", label: "codemode", description: "Upstream script guidance", parameters: {},
	exposure: "model-only", defaultActive: false,
	prepareLoadout: () => ({ hiddenDeclarations: ["read"] }),
	constrainedSampling: { type: "grammar" },
	execute: async (...args: unknown[]) => ({ content: [{ type: "text", text: "Original output" }], details: args }),
};

test("codemode registration changes only rendering and remains inactive", async () => {
	let registered: any;
	const pi = { registerTool(tool: unknown) { registered = tool; } } as ExtensionAPI;
	const factory = ((api: ExtensionAPI) => api.registerTool(original as any)) as ExtensionFactory;
	await registerStyledCodemode(pi, factory, true);
	assert.equal(registered.renderShell, "self");
	for (const key of Object.keys(original)) assert.equal(registered[key], original[key as keyof typeof original]);
	assert.deepEqual(await registered.execute("id", { code: "return 1" }), await original.execute("id", { code: "return 1" }));
	registered = undefined;
	await registerStyledCodemode(pi, factory, false);
	assert.equal(registered, undefined);
	await registerStyledCodemode(pi, undefined, true);
	assert.equal(registered, undefined);
});

test("codemode diamond hides script, calls and output until expanded", () => {
	const tool = wrapWithDiamondRenderer(original as any);
	const state = {};
	let invalidations = 0;
	const context = { args: { code: "text(await tools.read({path: 'README.md'}));" }, state, invalidate() { invalidations++; } };
	const result = { content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nhello" }], details: {
		calls: [{ name: "read", args: '{"path":"README.md"}', status: "ok", durationMs: 4 }],
	} };
	const row = tool.renderCall(context.args, theme, context);
	assert.deepEqual(row.render(100), ["◆ codemode"]);
	assert.deepEqual(tool.renderResult(result, { expanded: false }, theme, context).render(100), []);
	assert.deepEqual(row.render(100), ["◆ codemode · Read README.md"]);
	row.handleMouse!({ type: "click", button: "left", x: 0, y: 0 } as any);
	assert.equal(invalidations, 1);
	const expanded = tool.renderResult(result, { expanded: false }, theme, context).render(120).join("\n");
	assert.match(expanded, /tools\.read/);
	assert.match(expanded, /✓ read .*README\.md.*4ms/);
	assert.match(expanded, /hello/);
	row.handleMouse!({ type: "click", button: "left", x: 0, y: 0 } as any);
	assert.deepEqual(tool.renderResult(result, { expanded: false }, theme, context).render(100), []);
	assert.match(tool.renderResult(result, { expanded: true }, theme, context).render(120).join("\n"), /hello/);
});

test("expanded codemode streams nested progress and preserves error output", () => {
	const tool = wrapWithDiamondRenderer(original as any);
	const context = { args: { code: "await tools.bash({command: 'false'});" }, isError: true };
	const result = { content: [{ type: "text", text: "Script error: failed\u001b[2J" }], details: {
		calls: [{ name: "bash", args: "{}", status: "error", error: "blocked\u001b[2J", cost: 0.01 }],
	} };
	const partial = tool.renderResult(result, { expanded: true, isPartial: true }, theme, context).render(100).join("\n");
	assert.match(partial, /✗ bash/);
	assert.match(partial, /blocked/);
	assert.doesNotMatch(partial, /Script error/);
	assert.doesNotMatch(partial, /\u001b/);
	const complete = tool.renderResult(result, { expanded: true }, theme, context).render(100).join("\n");
	assert.match(complete, /Script error: failed/);
	assert.deepEqual(tool.renderCall(context.args, theme, context).render(100), ["◆ Failed: codemode"]);
});

function summaryFor(calls: unknown, partial = false, isError = false): string {
	const tool = wrapWithDiamondRenderer(original as any);
	const context = { args: { code: "unshown script" }, state: {}, isError };
	const row = tool.renderCall(context.args, theme, context);
	assert.deepEqual(tool.renderResult({ content: [], details: { calls } }, { expanded: false, isPartial: partial }, theme, context).render(100), []);
	return row.render(200).join("\n");
}

test("single-call codemode summaries use descriptions, file targets, and shell fallbacks", () => {
	const cases = [
		{ name: "bash", args: { command: "git diff --stat", description: "Inspect timing changes" }, expected: "Inspect timing changes" },
		{ name: "read", args: { path: "src/app.ts" }, expected: "Read src/app.ts" },
		{ name: "write", args: { path: "new.ts", description: "Module helpers" }, expected: "Module helpers" },
		{ name: "powershell", args: { command: "Get-ChildItem" }, expected: "List files" },
		{ name: "Agent", args: { subagent_type: "Explore", description: "Find entrypoint" }, expected: "Explore: Find entrypoint" },
	];
	for (const item of cases) assert.equal(summaryFor([{ name: item.name, args: JSON.stringify(item.args), status: "ok" }]), `◆ codemode · ${item.expected}`);
});

test("multiple-call codemode summaries group work and combine shell types", () => {
	const calls = [
		...Array.from({ length: 3 }, () => ({ name: "read", args: "{}", status: "ok" })),
		{ name: "bash", args: "{}", status: "ok" },
	];
	assert.equal(summaryFor(calls), "◆ codemode · Read 3 files · Run 1 command");
	calls.push({ name: "powershell", args: "{}", status: "ok" });
	assert.equal(summaryFor(calls), "◆ codemode · Read 3 files · Run 2 commands");
	assert.equal(summaryFor([{ name: "edit", status: "ok" }, { name: "write", status: "ok" }]), "◆ codemode · Edit 1 file · Write 1 file");
	assert.equal(summaryFor(["read", "bash", "edit", "write", "custom", "custom"].map(name => ({ name, status: "ok" }))), "◆ codemode · Read 1 file · Run 1 command · Edit 1 file · 3 other calls");
});

test("closed codemode headers track progress, failed calls, and cancellations in place", () => {
	const tool = wrapWithDiamondRenderer(original as any);
	const context = { args: { code: "unshown script" }, state: {} };
	const row = tool.renderCall(context.args, theme, context);
	const calls = [{ name: "read", status: "ok" }, { name: "bash", status: "running" }];
	const result = { content: [], details: { calls } };
	const update = (partial: boolean) => {
		assert.deepEqual(tool.renderResult(result, { expanded: false, isPartial: partial }, theme, context).render(100), []);
		return row.render(200).join("\n");
	};
	assert.equal(update(true), "◆ codemode · Read 1 file · Run 1 command · 1/2 finished");
	calls[1].status = "error";
	assert.equal(update(true), "◆ codemode · Read 1 file · Run 1 command · 2/2 finished · 1 failed");
	assert.equal(update(false), "◆ codemode · Read 1 file · Run 1 command · 1 failed");
	calls[1].status = "cancelled";
	assert.equal(update(false), "◆ codemode · Read 1 file · Run 1 command · 1 cancelled");
	assert.equal(summaryFor([{ name: "bash", status: "error" }], false, true), "◆ Failed: codemode · Run shell command · 1 failed");
});

test("codemode summary safely falls back for truncated arguments and malformed history", () => {
	for (const args of [undefined, '{"path":"truncated...', "[]", "null", "0", "x".repeat(8_193)]) {
		assert.equal(summaryFor([{ name: "read", args }]), "◆ codemode · Read");
	}
	for (const calls of [undefined, null, "bad", [null, 0, {}, { name: "" }, { name: 3 }]]) assert.equal(summaryFor(calls), "◆ codemode");
	assert.equal(summaryFor([{ name: "custom", args: '{"path":"item"}', status: "ok" }]), "◆ codemode · custom item");
	assert.equal(summaryFor([{ name: "custom", status: {} }]), "◆ codemode · custom");
});

test("codemode descriptions remain sanitized and headers fit narrow widths", () => {
	const tool = wrapWithDiamondRenderer(original as any);
	const context = { args: {}, state: {} };
	const row = tool.renderCall(context.args, theme, context);
	tool.renderResult({ content: [], details: { calls: [{ name: "bash", status: "running", args: JSON.stringify({ description: "Inspect\nchanges\u001b[2J\u001b]52;c;bad\u0007" }) }] } }, { expanded: false, isPartial: true }, theme, context);
	assert.deepEqual(row.render(100), ["◆ codemode · Inspect changes · 0/1 finished"]);
	assert.equal(stripTerminalSequences(row.render(100)[0]), row.render(100)[0]);
	for (const width of [0, 1, 2, 8, 20]) assert.ok(row.render(width).every(line => visibleWidth(line) <= width));
});

test("diamond wrappers preserve new upstream structured output and loadout metadata", () => {
	const outputSchema = { type: "object" };
	const upstream = { ...original, name: "bash", outputSchema };
	const tool = wrapWithDiamondRenderer(upstream as any) as any;
	assert.equal(tool.outputSchema, outputSchema);
	assert.equal(tool.prepareLoadout, upstream.prepareLoadout);
	assert.equal(tool.exposure, upstream.exposure);
});
