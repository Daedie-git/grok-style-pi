import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createEditToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { VisualPreparation, type VisualRequest, type VisualResult } from "../src/rendering/visual-preparation.ts";
import { defaultStyleColors } from "../src/chrome/style-colors.ts";
import { wrapWithDiamondRenderer, type OriginalTool } from "../src/tools/renderer.ts";
import { buildDiffRows, defaultDiffPalette } from "../src/rendering/diff-render.ts";
import { textTail } from "../src/utils/text-tail.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const request: VisualRequest = { kind: "highlight", text: "const value = 1;", lang: "typescript", filePath: "app.ts", colors: defaultStyleColors };
const theme = { fg: (_token: string, text: string) => text };
function executor() {
	const jobs: Array<{ request: VisualRequest; resolve(value: VisualResult): void; reject(error: Error): void }> = [];
	return { jobs, run: (request: VisualRequest) => new Promise<VisualResult>((resolve, reject) => jobs.push({ request, resolve, reject })), dispose() {} };
}
function original(name: string): OriginalTool {
	return { name, description: "fixture", parameters: {} as any, execute: async () => ({ content: [] }) };
}

test("unchanged tool layouts and result rebuilds reuse their completed lines", () => {
	let backgrounds = 0;
	const panel = { ...theme, bg: (_token: "customMessageBg", text: string) => { backgrounds++; return text; } };
	const tool = wrapWithDiamondRenderer(original("read"));
	const context = { args: { path: "fixture.txt" }, state: {} };
	const result = { content: [{ type: "text", text: "hello\nworld" }] };
	const component = tool.renderResult(result, { expanded: true }, panel, context);
	const first = component.render(80);
	const paints = backgrounds;
	assert.strictEqual(component.render(80), first);
	assert.equal(backgrounds, paints);
	assert.strictEqual(tool.renderResult(result, { expanded: true }, panel, context), component);
	const narrow = component.render(8);
	assert.notStrictEqual(narrow, first);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 8));
	component.invalidate();
	assert.notStrictEqual(component.render(8), narrow);
	const recolored = tool.renderResult(result, { expanded: true }, { ...panel, fg: (_token, text) => `\x1b[31m${text}\x1b[0m` }, context);
	assert.notStrictEqual(recolored, component);
});

test("Pi tool rows reuse completed result components across fresh result wrappers", async () => {
	initTheme("dark");
	const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const tool = wrapWithDiamondRenderer(createEditToolDefinition(process.cwd()));
	const components: ReturnType<typeof tool.renderResult>[] = [];
	const results: Parameters<typeof tool.renderResult>[0][] = [];
	const row = new ToolExecutionComponent("edit", "cached-edit", { path: "fixture.ts" }, {}, {
		...tool,
		renderResult(...args: Parameters<typeof tool.renderResult>) {
			const component = tool.renderResult(...args);
			results.push(args[0]); components.push(component);
			return component;
		},
	}, { requestRender() {} }, process.cwd());
	const result = { content: [{ type: "text", text: "Edited fixture.ts" }], details: { diff: "+const value = 1;" }, isError: false };
	row.updateResult(result);
	const first = components.at(-1)!;
	assert.match(stripTerminalSequences(row.render(80).join("\n")), /const value = 1;/);
	for (let index = 0; index < 10; index++) {
		const previousResult = results.at(-1);
		row.invalidate();
		row.render(80);
		assert.notStrictEqual(results.at(-1), previousResult, "Pi supplies a fresh result wrapper");
		assert.strictEqual(components.at(-1), first, "unchanged result data must reuse its component");
	}

	const changedDetails = { ...result, details: { diff: "+const value = 2;" } };
	row.updateResult(changedDetails);
	const updated = components.at(-1)!;
	assert.notStrictEqual(updated, first);
	assert.match(stripTerminalSequences(row.render(80).join("\n")), /const value = 2;/);
	row.updateResult({ ...changedDetails, content: [{ type: "text", text: "Updated result text" }] });
	assert.notStrictEqual(components.at(-1), updated);
	assert.match(stripTerminalSequences(row.render(80).join("\n")), /Updated result text/);
});

test("rendering returns readable text before background syntax completes, then invalidates once", async () => {
	const fake = executor();
	const preparation = new VisualPreparation(fake);
	let redraws = 0;
	const context = { args: { path: "fixture.ts" }, state: {}, invalidate: () => { redraws++; } };
	const tool = wrapWithDiamondRenderer(original("read"), { preparation });
	const result = { content: [{ type: "text", text: request.text }] };
	const first = tool.renderResult(result, { expanded: true }, theme, context);
	assert.equal(stripTerminalSequences(first.render(80).join("\n")).trim(), request.text);
	assert.equal(redraws, 0);
	await flush();
	assert.equal(fake.jobs.length, 1);
	fake.jobs[0].resolve({ lines: [`\x1b[32m${request.text}\x1b[0m`] });
	await flush();
	assert.equal(redraws, 1);
	const ready = tool.renderResult(result, { expanded: true }, theme, context);
	assert.match(ready.render(80).join("\n"), /\x1b\[32m/);
	preparation.reset();
});

test("preparation deduplicates requests and reset discards stale completions", async () => {
	const fake = executor();
	const preparation = new VisualPreparation(fake);
	const owner = {};
	let redraws = 0;
	for (let i = 0; i < 100; i++) preparation.request(request, owner, () => { redraws++; });
	await flush();
	assert.equal(fake.jobs.length, 1);
	fake.jobs[0].resolve({ lines: ["ready"] });
	await flush();
	assert.equal(redraws, 1);
	assert.deepEqual(preparation.request(request, owner, () => {}), { lines: ["ready"] });
	preparation.request({ ...request, text: "next" }, owner, () => { redraws++; });
	await flush();
	preparation.reset();
	fake.jobs[1].resolve({ lines: ["stale"] });
	await flush();
	assert.equal(redraws, 1);
	assert.equal(preparation.request(request, owner, () => {}), undefined);
	await flush();
	assert.equal(fake.jobs.length, 3);
	preparation.reset();
});

test("a replaced result ignores old syntax completion", async () => {
	const fake = executor();
	const preparation = new VisualPreparation(fake);
	let redraws = 0;
	const context = { args: { path: "fixture.ts" }, state: {}, invalidate: () => { redraws++; } };
	const tool = wrapWithDiamondRenderer(original("read"), { preparation });
	tool.renderResult({ content: [{ text: "old" }] }, { expanded: true }, theme, context);
	await flush();
	tool.renderResult({ content: [{ text: "new" }] }, { expanded: true }, theme, context);
	fake.jobs[0].resolve({ lines: ["old"] });
	await flush();
	assert.equal(redraws, 0);
	fake.jobs[1].resolve({ lines: ["new"] });
	await flush();
	assert.equal(redraws, 1);
	preparation.reset();
});

test("queue and cache remain bounded and failed preparation backs off", async () => {
	const fake = executor();
	const preparation = new VisualPreparation(fake, 80);
	const owner = {};
	for (let i = 0; i < 100; i++) preparation.request({ ...request, text: String(i) }, owner, () => {});
	await flush();
	for (let i = 0; i < 32; i++) { fake.jobs[i].resolve({ lines: [fake.jobs[i].request.text.padEnd(20, " ")] }); await flush(); }
	assert.equal(fake.jobs.length, 32);
	assert.equal(preparation.request({ ...request, text: "0" }, owner, () => {}), undefined, "old cached output is evicted by byte budget");
	await flush();
	fake.jobs.at(-1)!.reject(new Error("worker unavailable"));
	await flush();
	preparation.request(request, owner, () => assert.fail("failure cannot trigger a render loop"));
	await flush();
	assert.equal(fake.jobs.length, 33);
	preparation.reset();
});

test("large replacement pairing falls back without losing source lines", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `const item${i} = calculate(beforeValue, options.enabled, options.timeout);`);
	const diff = [...lines.map((line) => "-" + line), ...lines.map((line) => "+" + line.replace("beforeValue", "afterValue"))].join("\n");
	const rows = buildDiffRows(diff, { paint: (_token, text) => text }, () => undefined);
	assert.equal(rows.length, 200);
	assert.equal(rows.map((row) => row.text).join("\n"), diff);
});

test("tail projections stop before reading omitted history", () => {
	let olderRead = false;
	const parts = (function* () { yield "newest"; yield "older"; olderRead = true; yield "omitted"; })();
	assert.equal(textTail(parts, 10, "\n\n"), "er\n\nnewest");
	assert.equal(olderRead, false);
	for (const size of [1, 3, 10, 100]) {
		assert.equal(textTail(["new", "", "middle", "old"], size, "\n\n"), "old\n\nmiddle\n\nnew".slice(-size));
	}
});

test("visual worker loads from an installed package and leaves the event loop responsive", { timeout: 20_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "grok-visual-package-"));
	const pkg = join(root, "node_modules", "grok-style-pi");
	mkdirSync(join(pkg, "src"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
	cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(pkg, "src"), { recursive: true });
	cpSync(fileURLToPath(new URL("../themes", import.meta.url)), join(pkg, "themes"), { recursive: true });
	symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(pkg, "node_modules"), "dir");
	let preparation: VisualPreparation | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	try {
		const loaded = await createJiti(import.meta.url).import<{ VisualPreparation: typeof VisualPreparation }>(join(pkg, "src", "rendering", "visual-preparation.ts"));
		preparation = new loaded.VisualPreparation();
		let ticks = 0;
		heartbeat = setInterval(() => { ticks++; }, 5);
		const input: VisualRequest = { ...request, kind: "diff", text: "-1 const value = 1;\n+1 const value = 2;", palette: defaultDiffPalette };
		await new Promise<void>((resolve) => { assert.equal(preparation!.request(input, {}, resolve), undefined); });
		const ready = preparation.request(input, {}, () => {});
		assert.equal(ready?.rows?.length, 2);
		assert.match(stripTerminalSequences(ready!.rows![1].text), /const value = 2;/);
		assert.ok(ticks > 0);
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		preparation?.reset();
		rmSync(root, { recursive: true, force: true });
	}
});

test("large layouts prepare in the background and resizing cannot reuse the wrong width", async () => {
	const fake = executor();
	const preparation = new VisualPreparation(fake);
	let redraws = 0;
	const context = { args: { path: "fixture.ts" }, state: {}, invalidate: () => { redraws++; } };
	const tool = wrapWithDiamondRenderer(original("edit"), { preparation });
	const result = { content: [], details: { diff: Array.from({ length: 250 }, (_, i) => `+const value${i} = 1;`).join("\n") } };
	const component = tool.renderResult(result, { expanded: true }, theme, context);
	assert.equal(component.render(80).length, 250);
	assert.ok(component.render(20).every((line) => visibleWidth(line) <= 20));
	await flush();
	assert.equal(fake.jobs[0].request.kind, "diff");
	fake.jobs[0].resolve({ rows: Array.from({ length: 250 }, (_, i) => ({ kind: "add", text: `+const value${i} = 1;` })) });
	await flush();
	assert.equal(fake.jobs[1].request.kind, "layout");
	assert.equal(fake.jobs[1].request.width, 20, "newest resize is prioritized");
	assert.equal(redraws, 1);
	preparation.reset();
});

test("temporary syntax fallbacks expire and notifications stop if a callback resets the session", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const fake = executor();
	const preparation = new VisualPreparation(fake);
	preparation.request(request, {}, () => {});
	await flush();
	fake.jobs[0].resolve({ lines: ["fallback"], retry: true });
	await flush();
	assert.equal(preparation.request(request, {}, () => {})?.lines?.[0], "fallback");
	t.mock.timers.tick(30_001);
	assert.equal(preparation.request(request, {}, () => preparation.reset()), undefined);
	preparation.request(request, {}, () => assert.fail("disposed session must not receive a callback"));
	await flush();
	fake.jobs[1].resolve({ lines: ["recovered"] });
	await flush();
	preparation.reset();
});
