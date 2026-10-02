import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { VisualPreparation, type VisualRequest, type VisualResult } from "../src/rendering/visual-preparation.ts";
import { withDiamondSection, type DiamondSection } from "../src/tools/section.ts";
import { wrapWithDiamondRenderer } from "../src/tools/renderer.ts";
import { textSection } from "../src/tools/sections/index.ts";

const theme = { fg: (_token: string, value: string) => value };
const click = { type: "click", button: "left", x: 0, y: 0 } as any;
const original = {
	name: "fixture", description: "Upstream", parameters: {}, execute: async () => ({ content: [] }),
	outputSchema: { type: "object" }, exposure: "model-only", defaultActive: false, prepareLoadout: () => ({}),
};
const output = (text: string, details?: unknown) => ({ content: [{ type: "text", text }], details });
const plain = (component: any, width = 100) => stripTerminalSequences(component.render(width).join("\n"));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function codePreparation() {
	const jobs: Array<{ request: VisualRequest; resolve(result: VisualResult): void }> = [];
	const preparation = new VisualPreparation({
		run: (request) => new Promise((resolve) => jobs.push({ request, resolve })), dispose() {},
	});
	return { preparation, jobs };
}

test("custom sections need only an adapter and a table entry, preserving upstream identity", () => {
	const section = textSection("Inspected");
	const tool = wrapWithDiamondRenderer(original as any, undefined, { fixture: section });
	const direct = withDiamondSection(original as any, section);
	for (const decorated of [tool, direct]) {
		for (const key of Object.keys(original)) assert.equal((decorated as any)[key], original[key as keyof typeof original]);
		assert.equal(decorated.renderShell, "self");
		assert.deepEqual(decorated.renderCall({ path: "somewhere" }, theme).render(100), ["◆ Inspected somewhere"]);
	}
	const unknown = wrapWithDiamondRenderer({ ...original, name: "toString" } as any);
	assert.match(plain(unknown.renderCall({}, theme)), /◆ toString/);
});

test("collapsed bodies are lazy; local/global expansion and concurrent calls stay independent", () => {
	let bodies = 0;
	const adapter: DiamondSection = { summary: () => ({ title: "Inspect" }), body: () => { bodies++; return [{ kind: "text", text: "body" }]; } };
	const tool = withDiamondSection(original as any, adapter);
	const args = {};
	let invalidations = 0;
	const one = { args, state: {}, invalidate() { invalidations++; } };
	const two = { args, state: {}, invalidate() { invalidations++; } };
	const row = tool.renderCall(args, theme, one) as any;
	const result = output("ignored");
	assert.equal(plain(tool.renderResult(result, { expanded: false }, theme, one)), "");
	assert.equal(bodies, 0);
	assert.equal(row.handleMouse({ ...click, ctrl: true }), undefined);
	row.handleMouse(click);
	const body = tool.renderResult(result, { expanded: false }, theme, one) as any;
	assert.match(plain(body), /body/);
	assert.equal(plain(tool.renderResult(result, { expanded: false }, theme, two)), "");
	assert.equal(bodies, 1);
	body.handleMouse(click);
	assert.equal(plain(tool.renderResult(result, { expanded: false }, theme, one)), "");
	assert.match(plain(tool.renderResult(result, { expanded: true }, theme, one)), /body/);
	assert.equal(plain(tool.renderResult(result, { expanded: false }, theme, one)), "");
	assert.equal(invalidations, 2);
	assert.match(plain(tool.renderResult(result, { expanded: true }, theme)), /body/);
});

test("argument-only headers refresh when Pi mutates arguments in place", () => {
	for (const name of ["Agent", "grep"]) {
		const tool = wrapWithDiamondRenderer({ ...original, name } as any);
		const args: Record<string, unknown> = {};
		const ctx = { args, state: {} };
		const header = tool.renderCall(args, theme, ctx);
		Object.assign(args, { subagent_type: "Explore", description: "Check changed files", pattern: "updated target" });
		tool.renderCall(args, theme, ctx);
		assert.equal(plain(header), name === "Agent" ? "◆ Explore: Check changed files" : "◆ Searched updated target");
	}
});

test("headers update from collapsed results without retaining results or evaluating bodies", () => {
	const adapter: DiamondSection = {
		summary: (view) => ({ title: view.result ? "Finished" : "Inspect", detail: view.isPartial ? "running" : "" }),
		body() { assert.fail("closed body must stay lazy"); },
	};
	const tool = withDiamondSection(original as any, adapter);
	const args = {};
	const ctx = { args, state: {}, invalidate() {} };
	const header = tool.renderCall(args, theme, ctx);
	assert.equal(plain(header), "◆ Inspect");
	tool.renderResult(output("result"), { expanded: false, isPartial: true }, theme, ctx);
	assert.equal(plain(header), "◆ Finished running");
	tool.renderCall(args, theme, ctx);
	assert.equal(plain(header), "◆ Finished running", "a subsequent call renderer retains completion summary");
	tool.renderResult(output("failure"), { expanded: false }, theme, { ...ctx, isError: true });
	assert.equal(plain(header), "◆ Failed: Finished");
});

test("ordinary adapters hide partial bodies and retain completed empty-error fallback", () => {
	const tool = wrapWithDiamondRenderer({ ...original, name: "grep" } as any);
	assert.equal(plain(tool.renderResult(output("partial"), { expanded: true, isPartial: true }, theme)), "");
	assert.match(plain(tool.renderResult(output(""), { expanded: true }, theme, { isError: true })), /error/);
	assert.match(plain(tool.renderResult(output("complete"), { expanded: true }, theme)), /complete/);
});

test("one section shell preserves colored diffs through same-call text/diff/text transitions", () => {
	const tool = wrapWithDiamondRenderer({ ...original, name: "codemode" } as any);
	const args = { code: 'text("script");' };
	const context = { args, state: {}, invalidate() {} };
	const header = tool.renderCall(args, theme, context) as any;
	tool.renderResult(output("first"), { expanded: false }, theme, context);
	header.handleMouse(click);
	assert.match(plain(tool.renderResult(output("first"), { expanded: false }, theme, context)), /first/);
	const withDiff = output("output", { diff: "-1 before\n+1 after", calls: [{ name: "read", status: "ok", args: "{}", durationMs: 1 }] });
	const rendered = tool.renderResult(withDiff, { expanded: false }, theme, context);
	for (const part of [/script/, /✓ read/, /output/, /before/, /after/]) assert.match(plain(rendered), part);
	assert.match(rendered.render(100).join("\n"), /\u001b\[48;/, "diff backgrounds remain colored");
	const after = plain(tool.renderResult(output("last"), { expanded: false }, theme, context));
	assert.match(after, /last/);
	assert.doesNotMatch(after, /before|after/);
	header.handleMouse(click);
	assert.equal(plain(tool.renderResult(withDiff, { expanded: false }, theme, context)), "");
});

test("in-place partial details are recomputed; malformed codemode history is safe", () => {
	const tool = wrapWithDiamondRenderer({ ...original, name: "codemode" } as any);
	const calls = [{ name: "read", status: "running", args: "{}" }];
	const result = output("not final", { calls });
	const ctx = { state: {}, args: { code: "await tools.read({});" } };
	assert.match(plain(tool.renderResult(result, { expanded: true, isPartial: true }, theme, ctx)), /… read/);
	calls[0].status = "ok";
	const next = plain(tool.renderResult(result, { expanded: true, isPartial: true }, theme, ctx));
	assert.match(next, /✓ read/);
	assert.doesNotMatch(next, /not final/);
	for (const details of [null, 0, "invalid", { calls: [null, 1, {}, { name: "safe", status: {} }] }]) {
		assert.doesNotThrow(() => tool.renderResult(output("historical", details), { expanded: true }, theme).render(100));
	}
});

test("sections sanitize projections and results, fit narrow widths, and refresh themed layouts", () => {
	const section: DiamondSection = {
		summary: () => ({ title: "Inspect\u001b[2J", target: "danger\u001b]52;c;bad\u0007", detail: "detail\nmore" }),
		body: () => [{ kind: "text", text: "output\u001b[2J\u0000" }],
	};
	const tool = withDiamondSection(original as any, section);
	const ctx = { state: {}, args: {} };
	assert.equal(plain(tool.renderCall({}, theme, ctx)), "◆ Inspect danger detail more");
	const result = output("irrelevant");
	const component = tool.renderResult(result, { expanded: true }, theme, ctx);
	assert.doesNotMatch(component.render(100).join("\n"), /\u001b|\u0000/);
	const first = component.render(100);
	assert.strictEqual(component.render(100), first);
	assert.strictEqual(tool.renderResult(result, { expanded: true }, theme, ctx), component);
	for (const width of [0, 1, 2, 5, 20]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
	const red = { fg: (_token: string, value: string) => `\u001b[31m${value}\u001b[0m` };
	assert.notStrictEqual(tool.renderResult(result, { expanded: true }, red, ctx), component);
	assert.notStrictEqual(tool.renderResult(output("new identity"), { expanded: true }, theme, ctx), component);
	component.invalidate();
	assert.notStrictEqual(component.render(100), first);
});

test("shared section preparation ignores replaced and session-reset completions", async () => {
	const { preparation, jobs } = codePreparation();
	let redraws = 0;
	const ctx = { state: {}, args: { code: "const old = 1;" }, invalidate() { redraws++; } };
	const tool = wrapWithDiamondRenderer({ ...original, name: "codemode" } as any, { preparation });
	tool.renderResult(output(""), { expanded: true }, theme, ctx).render(100);
	await flush();
	ctx.args = { code: "const current = 2;" };
	const result = output("");
	tool.renderResult(result, { expanded: true }, theme, ctx).render(100);
	jobs[0].resolve({ lines: ["stale"] });
	await flush();
	assert.equal(redraws, 0);
	jobs[1].resolve({ lines: ["current colored"] });
	await flush();
	assert.equal(redraws, 1);
	assert.match(plain(tool.renderResult(result, { expanded: true }, theme, ctx)), /current colored/);
	ctx.args = { code: "const reset = 3;" };
	tool.renderResult(output(""), { expanded: true }, theme, ctx).render(100);
	await flush();
	preparation.reset();
	jobs[2].resolve({ lines: ["reset stale"] });
	await flush();
	assert.equal(redraws, 1);
});

test("closing a section expires pending preparation before it can redraw", async () => {
	const { preparation, jobs } = codePreparation();
	let redraws = 0;
	const ctx = { args: { code: "const value = 1;" }, state: {}, invalidate() { redraws++; } };
	const tool = wrapWithDiamondRenderer({ ...original, name: "codemode" } as any, { preparation });
	const result = output("");
	const header = tool.renderCall(ctx.args, theme, { ...ctx, expanded: true }) as any;
	tool.renderResult(result, { expanded: true }, theme, ctx).render(100);
	await flush();
	header.handleMouse(click);
	tool.renderResult(result, { expanded: true }, theme, ctx);
	jobs[0].resolve({ lines: ["ready"] });
	await flush();
	assert.equal(redraws, 1, "only the close action redraws");
	preparation.reset();
});
