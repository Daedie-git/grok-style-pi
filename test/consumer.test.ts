import assert from "node:assert/strict";
import test from "node:test";
import grokStylePi, { BUILTIN_TOOL_NAMES, createGrokStyleExtension } from "../extensions/index.ts";
import { wrapWithDiamondRenderer } from "../src/tools/renderer.ts";

test("consumer loads the shipped factory and wires public APIs", async () => {
	assert.equal(typeof grokStylePi, "function");
	assert.equal(typeof createGrokStyleExtension, "function");

	const registered: Array<Record<string, unknown>> = [];
	const handlers: Record<string, Function> = {};
	let footerSet = false;
	let editorSet = false;

	class ConsumerEditor {
		focused = true;
		borderColor = (text: string) => text;
		render() {
			return [this.borderColor("─"), "in", this.borderColor("─")];
		}
	}

	createGrokStyleExtension(
		{
			on(event, handler) {
				handlers[event] = handler;
			},
			registerTool(tool) {
				const index = registered.findIndex((entry) => entry.name === tool.name);
				if (index >= 0) registered[index] = tool as Record<string, unknown>; else registered.push(tool as Record<string, unknown>);
			},
		},
		{
			CustomEditor: ConsumerEditor,
			tools: Object.fromEntries(
				BUILTIN_TOOL_NAMES.map((name) => [
					name,
					() => ({
						name,
						description: name,
						parameters: {},
						execute: async () => ({ content: [{ type: "text", text: `orig-${name}` }] }),
					}),
				]),
			) as any,
		},
	);

	await handlers.session_start?.(
		{},
		{
			cwd: "/tmp/consumer-cwd",
			hasUI: true,
			model: { name: "Grok 4.6" },
			getContextUsage: () => ({ percent: 9 }),
			ui: {
				theme: { fg: (_t: string, text: string) => text },
				setFooter() {
					footerSet = true;
				},
				setEditorComponent() {
					editorSet = true;
				},
			},
		},
	);

	assert.equal(registered.length, BUILTIN_TOOL_NAMES.length);
	assert.ok(footerSet);
	assert.ok(editorSet);
	for (const name of BUILTIN_TOOL_NAMES) {
		const tool = registered.find((item) => item.name === name);
		assert.ok(tool, `missing ${name}`);
		assert.equal(tool.renderShell, "self");
		assert.ok(tool.renderCall);
		assert.ok(tool.renderResult);
	}
});

test("default export factory registers real create*Tool diamond overrides", async () => {
	const registered: Array<Record<string, unknown>> = [];
	let start: Function | undefined;
	await grokStylePi({
		on(event: string, handler: Function) {
			if (event === "session_start") start = handler;
		},
		registerTool(tool: Record<string, unknown>) {
			const index = registered.findIndex((entry) => entry.name === tool.name); if (index >= 0) registered[index] = tool; else registered.push(tool);
		},
	} as any);

	assert.ok(start, "session_start handler should be registered");
	// Pi rebuilds history before session_start during /reload. Capture the
	// definition at that point, as the transcript component does.
	const restoredBash = registered.find((tool) => tool.name === "bash")!;
	assert.ok(restoredBash, "shell rendering must already be registered during extension load");
	const paint = { fg: (_token: string, text: string) => text };
	assert.deepEqual((restoredBash.renderCall as Function)({ command: "curl -fsSL https://example.test/docs", timeout: 20 }, paint, {}).render(100), ["◆ Fetch remote content"]);
	assert.deepEqual((restoredBash.renderResult as Function)({ content: [{ type: "text", text: "raw response" }] }, { expanded: false }, paint, {}).render(100), []);
	await start!(
		{},
		{
			cwd: process.cwd(),
			hasUI: true,
			mode: "tui",
			model: { name: "Grok 4.6" },
			getContextUsage: () => ({ percent: 3 }),
			ui: {
				theme: { fg: (_t: string, text: string) => text },
				setFooter() {},
				setEditorComponent() {},
			},
		},
	);

	const agent = await import("@earendil-works/pi-coding-agent");
	for (const [name, factory] of [["read", agent.createReadToolDefinition], ["edit", agent.createEditToolDefinition], ["write", agent.createWriteToolDefinition]] as const) {
		const native = factory(process.cwd());
		const tool = registered.find((item) => item.name === name)!;
		assert.equal(tool.promptSnippet, native.promptSnippet);
		assert.deepEqual((tool.promptGuidelines as string[]).slice(0, native.promptGuidelines?.length), native.promptGuidelines);
	}
	assert.equal(registered.length, BUILTIN_TOOL_NAMES.length);
	for (const name of BUILTIN_TOOL_NAMES) {
		const tool = registered.find((item) => item.name === name);
		assert.ok(tool, `missing ${name}`);
		assert.equal(tool.renderShell, "self");
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		assert.equal(typeof tool.execute, "function");
	}

	const read = registered.find((item) => item.name === "read");
	const result = await (read?.execute as Function)("id", { path: "package.json" }, undefined, undefined, {
		cwd: process.cwd(),
	});
	assert.ok(Array.isArray(result.content));
	assert.ok(String(result.content[0]?.text ?? "").includes("grok-style-pi"));
});

test("consumer can load real createReadTool and diamond execute matches the original", async () => {
	const agent = await import("@earendil-works/pi-coding-agent");
	const cwd = process.cwd();
	const original = agent.createReadTool(cwd);
	const wrapped = wrapWithDiamondRenderer(original);
	const args = { path: "package.json" };
	const ctx = { cwd };
	const fromOriginal = await original.execute("t-orig", args, undefined, undefined, ctx);
	const fromWrapped = await wrapped.execute("t-wrap", args, undefined, undefined, ctx);
	assert.deepEqual(fromWrapped.content, fromOriginal.content);
	assert.equal(wrapped.renderShell, "self");
	assert.ok(wrapped.name === "read");
});
