import assert from "node:assert/strict";
import test from "node:test";
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

test("diamond wrappers preserve new upstream structured output and loadout metadata", () => {
	const outputSchema = { type: "object" };
	const upstream = { ...original, name: "bash", outputSchema };
	const tool = wrapWithDiamondRenderer(upstream as any) as any;
	assert.equal(tool.outputSchema, outputSchema);
	assert.equal(tool.prepareLoadout, upstream.prepareLoadout);
	assert.equal(tool.exposure, upstream.exposure);
});
