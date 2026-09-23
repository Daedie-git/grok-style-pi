import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { FOCUS_BORDER_TOKEN, IDLE_BORDER_TOKEN } from "../src/chrome/composer.ts";
import { formatToolCall } from "../src/tools/diamond.ts";
import { frameEditorLines } from "../src/chrome/composer.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { BUILTIN_TOOL_NAMES, wrapWithDiamondRenderer, type OriginalTool, type ToolFactoryMap } from "../src/tools/renderer.ts";

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

test("real composer has a rounded frame and preserves editing and mouse coordinates", () => {
	let start: Function | undefined;
	let editorFactory: Function | undefined;
	createGrokStyleExtension({
		on(event, handler) { if (event === "session_start") start = handler; },
		registerTool() {},
	}, { CustomEditor, tools: factories() });
	start!({}, { cwd: process.cwd(), hasUI: true, ui: {
		theme: { fg: (_token: string, text: string) => text },
		setEditorComponent(factory: Function) { editorFactory = factory; },
	} });
	const editor = editorFactory!(
		{ terminal: { rows: 30 }, requestRender() {} },
		{ borderColor: (text: string) => text, selectList: {} },
		{ matches: () => false },
	);
	editor.focused = true;
	editor.setText("abcdefghij");
	for (const width of [8, 20, 60]) {
		const lines: string[] = editor.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines[0].startsWith("╭"));
		assert.ok(lines.at(-1)!.startsWith("╰"));
		assert.ok(lines[1].startsWith("│ ❯ "));
		assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
	}
	editor.render(30);
	editor.handleMouse({ type: "click", button: "left", x: 6, y: 1, width: 30, height: 3 });
	editor.handleInput("X");
	assert.equal(editor.getText(), "abXcdefghij");
	editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
	const scrolled: string[] = editor.render(30);
	assert.ok(scrolled[0].includes("more"));
	assert.ok(scrolled.every((line) => visibleWidth(line) <= 30));
});

test("composer keeps autocomplete rows outside the border", () => {
	const lines = frameEditorLines(["─────", "input", "─────", "choice"], 2, 10, (_token, text) => text, true);
	assert.equal(stripTerminalSequences(lines[2]), "╰────────╯");
	assert.ok(!lines[3].includes("│"));
	assert.ok(lines.every((line) => visibleWidth(line) <= 10));
});

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
	assert.ok(call.render(80)[0]?.includes("Read"));
	assert.equal(call.render(80).length, 1);

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
	assert.equal(collapsed.render(80).length, 0);
	assert.ok(collapsed.render(80).join("\n").length < expanded.render(80).join("\n").length);
	assert.ok(!collapsed.render(80).join("\n").includes("body-line-11-UNIQUE"));
	assert.ok(expanded.render(80).join("\n").includes("body-line-11-UNIQUE"));
	assert.equal(formatToolCall("read", { path: "src/a.ts" }), "◆ Read src/a.ts");
});

test("createGrokStyleExtension registers diamond built-ins, footer, and composer", async () => {
	const registered: Array<Record<string, unknown>> = [];
	const handlers: Record<string, (event: unknown, ctx: any) => unknown> = {};
	let footerFactory: ((tui: any, theme: any, footerData?: any) => any) | undefined;
	let editorFactory: ((tui: unknown, theme: unknown, kb: unknown) => MockEditor) | undefined;
	let thinkingLevel = "high";

	const pi = {
		getThinkingLevel() { return thinkingLevel; },
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers[event] = handler;
		},
		registerTool(tool: Record<string, unknown>) {
			const index = registered.findIndex((entry) => entry.name === tool.name); if (index >= 0) registered[index] = tool; else registered.push(tool);
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
		[...BUILTIN_TOOL_NAMES, "show_image"],
	);
	for (const tool of registered) {
		assert.equal(tool.renderShell, "self", `${String(tool.name)} should own its shell`);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		if (tool.name !== "show_image") {
			const executed = await (tool.execute as Function)("id", {}, undefined, undefined, ctx);
			assert.equal(executed.content[0].text, `exec-${tool.name}`);
		}
	}

	assert.ok(footerFactory);
	const footer = footerFactory!({ requestRender() {} }, ctx.ui.theme, { onBranchChange: () => () => {} });
	const footerLine = footer.render(160).join("");
	assert.ok(footerLine.includes("demo-project"));
	assert.ok(footerLine.includes("Grok 4.6"));
	assert.ok(footerLine.includes("%"));
	assert.ok(footerLine.includes("│"));
	assert.ok(footerLine.includes("Grok 4.6 high"));
	thinkingLevel = "low";
	assert.ok(footer.render(160).join("").includes("Grok 4.6 low"));
	assert.ok(footer.render(12).every((line: string) => visibleWidth(line) <= 12));
	assert.deepEqual(footer.render(0), [""]);

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

test("real composer wraps Pi's suspend action once and honors shortcut interception", async (t) => {
	const { grokTerminalOscApply, grokTerminalOscReset } = await import("../src/chrome/terminal-chrome.ts");
	const handlers = new Map<string, Function>();
	let editorFactory: Function;
	const writes: string[] = [];
	const initialListeners = process.listenerCount("SIGCONT");
	createGrokStyleExtension({ on(event, handler) { handlers.set(event, handler); }, registerTool() {} },
		{ CustomEditor, tools: factories() });
	t.after(() => handlers.get("session_shutdown")!());
	handlers.get("session_start")!({}, { cwd: process.cwd(), hasUI: true, ui: {
		setEditorComponent(factory: Function) { editorFactory = factory; },
	} });
	const editor = editorFactory!(
		{ terminal: { rows: 30, write(text: string) { writes.push(text); } }, requestRender() {} },
		{ borderColor: (text: string) => text, selectList: {} },
		{ matches: (data: string, action: string) => data === "\x1a" && action === "app.suspend" },
	);
	// Pi copies its handlers after constructing the custom editor.
	editor.actionHandlers.set("app.suspend", () => writes.push("suspend"));
	editor.onExtensionShortcut = () => true;
	editor.handleInput("\x1a");
	assert.deepEqual(writes, [grokTerminalOscApply()]);
	editor.onExtensionShortcut = () => false;
	editor.handleInput("\x1a");
	assert.deepEqual(writes.slice(-2), [grokTerminalOscReset(), "suspend"]);
	assert.equal(process.listenerCount("SIGCONT"), initialListeners + 1);
	const wrapper = editor.actionHandlers.get("app.suspend");
	editor.handleInput("a");
	assert.strictEqual(editor.actionHandlers.get("app.suspend"), wrapper);
	handlers.get("session_shutdown")!();
	assert.equal(process.listenerCount("SIGCONT"), initialListeners);
});

test("shell schema accepts optional summaries and renderer shows them", async () => {
	const { createBashTool } = await import("@earendil-works/pi-coding-agent");
	const tool = wrapWithDiamondRenderer(createBashTool(process.cwd()));
	const schema = tool.parameters as any;
	assert.equal(schema.properties.description.type, "string");
	assert.ok(!schema.required.includes("description"));
	const args = { command: 'printf "summary-test"', description: "Verify shell rendering" };
	assert.equal(tool.renderCall(args, {}).render(80)[0], "◆ Verify shell rendering");
	const result = await tool.execute("summary", args, new AbortController().signal);
	assert.equal(result.content[0].text, "summary-test");
});

test("startup applies terminal background before loading tool settings", () => {
	const handlers = new Map<string, Function>();
	const writes: string[] = [];
	createGrokStyleExtension({
		on(event, handler) { handlers.set(event, handler); },
		registerTool() {},
	}, {
		CustomEditor: MockEditor,
		tools: factories(),
		features: { communication: false },
		getToolOptions() {
			assert.ok(writes.some(text => text.includes("\x1b]11;")), "background is still unchanged when startup reaches tool settings");
			return {};
		},
	});
	try {
		handlers.get("session_start")!({}, { cwd: process.cwd(), hasUI: true, ui: {
			setFooter(factory: Function) {
				factory({ terminal: { write(text: string) { writes.push(text); } }, requestRender() {} }, {});
			},
		} });
	} finally { handlers.get("session_shutdown")!(); }
});
