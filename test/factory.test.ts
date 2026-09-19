import assert from "node:assert/strict";
import test from "node:test";
import { FOCUS_BORDER_TOKEN, IDLE_BORDER_TOKEN } from "../src/composer.ts";
import { formatToolCall } from "../src/diamond.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { BUILTIN_TOOL_NAMES, wrapWithDiamondRenderer, type OriginalTool, type ToolFactoryMap } from "../src/tools.ts";

class MockEditor {
	focused = false;
	borderColor = (text: string) => text;
	render(width: number): string[] {
		const bar = this.borderColor("─".repeat(Math.max(2, width)));
		return [bar, "draft", bar];
	}
}

function fakeTool(name: string, payload: string): OriginalTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object" },
		promptSnippet: `${name} snippet`,
		execute: async () => ({ content: [{ type: "text", text: payload }] }),
	};
}

function factories(): ToolFactoryMap {
	return Object.fromEntries(
		BUILTIN_TOOL_NAMES.map((name) => [name, (_cwd: string) => fakeTool(name, `exec-${name}`)]),
	) as ToolFactoryMap;
}

test("wrapWithDiamondRenderer forwards execute to the original tool", async () => {
	const payload = { content: [{ type: "text", text: "FROM-ORIGINAL-READ" }] };
	const original: OriginalTool = {
		name: "read",
		description: "read",
		parameters: {},
		execute: async () => payload,
	};
	const wrapped = wrapWithDiamondRenderer(original);
	assert.equal(wrapped.renderShell, "self");
	assert.equal(typeof wrapped.renderCall, "function");
	assert.equal(typeof wrapped.renderResult, "function");
	const result = await wrapped.execute("id", { path: "x" }, undefined, undefined, {});
	assert.equal(result, payload);

	const call = wrapped.renderCall({ path: "src/a.ts" }, { fg: (_t, text) => text });
	assert.ok(call.render(80)[0]?.startsWith("◆"));
	assert.ok(call.render(80)[0]?.includes("read"));

	const full = Array.from({ length: 12 }, (_, i) => `body-line-${i}-UNIQUE`).join("\n");
	const collapsed = wrapped.renderResult(
		{ content: [{ type: "text", text: full }] },
		{ expanded: false },
		{ fg: (_t, text) => text },
	);
	const expanded = wrapped.renderResult(
		{ content: [{ type: "text", text: full }] },
		{ expanded: true },
		{ fg: (_t, text) => text },
	);
	assert.ok(collapsed.render(80).join("\n").length < expanded.render(80).join("\n").length);
	assert.ok(!collapsed.render(80).join("\n").includes("body-line-11-UNIQUE"));
	assert.ok(expanded.render(80).join("\n").includes("body-line-11-UNIQUE"));
	assert.equal(formatToolCall("read", { path: "src/a.ts" }), "◆ read(src/a.ts)");
});

test("createGrokStyleExtension registers diamond built-ins, footer, and composer", async () => {
	const registered: Array<Record<string, unknown>> = [];
	const handlers: Record<string, (event: unknown, ctx: any) => unknown> = {};
	let footerFactory: ((tui: any, theme: any, footerData?: any) => any) | undefined;
	let editorFactory: ((tui: unknown, theme: unknown, kb: unknown) => MockEditor) | undefined;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers[event] = handler;
		},
		registerTool(tool: Record<string, unknown>) {
			registered.push(tool);
		},
	};

	createGrokStyleExtension(pi, { CustomEditor: MockEditor, tools: factories() });

	const ctx = {
		cwd: "/tmp/demo-project",
		hasUI: true,
		mode: "tui",
		model: { name: "Grok 4.6", id: "grok-4.6" },
		getContextUsage: () => ({ percent: 18 }),
		ui: {
			theme: { fg: (token: string, text: string) => `<${token}>${text}` },
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
			setEditorComponent(factory: typeof editorFactory) {
				editorFactory = factory;
			},
		},
	};

	await handlers.session_start?.({}, ctx);

	assert.deepEqual(
		registered.map((tool) => tool.name),
		[...BUILTIN_TOOL_NAMES],
	);
	for (const tool of registered) {
		assert.equal(tool.renderShell, "self", `${String(tool.name)} should own its shell`);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		const executed = await (tool.execute as Function)("id", {}, undefined, undefined, ctx);
		assert.equal(executed.content[0].text, `exec-${tool.name}`);
	}

	assert.ok(footerFactory);
	const footer = footerFactory!({ requestRender() {} }, ctx.ui.theme, { onBranchChange: () => () => {} });
	const footerLine = footer.render(80).join("");
	assert.ok(footerLine.includes("demo-project"));
	assert.ok(footerLine.includes("Grok 4.6"));
	assert.ok(footerLine.includes("%"));
	assert.ok(footerLine.includes("│"));

	assert.ok(editorFactory);
	const editor = editorFactory!({}, {}, {});
	editor.focused = false;
	const idle = editor.render(10);
	editor.focused = true;
	const focused = editor.render(10);
	assert.ok(idle[0]?.includes(`<${IDLE_BORDER_TOKEN}>`));
	assert.ok(focused[0]?.includes(`<${FOCUS_BORDER_TOKEN}>`));
	assert.notEqual(idle.join("\n"), focused.join("\n"));
});
