import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { wrapWithDiamondRenderer, BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { textComponent } from "../src/tools/diamond.ts";
import { createSessionChrome } from "../src/extension/session-chrome.ts";

const theme = { fg: (_token: string, value: string) => value } as any;
const click = (y: number, x = 4, alt = false) => ({ type: "click", button: "left", x, y, alt, width: 32 } as const);
const tool = (name: string, onCodeLocation: (path: string, line: number, endLine?: number) => void) => wrapWithDiamondRenderer({
	name, description: "", parameters: {}, execute: async () => ({ content: [] }),
} as any, { onCodeLocation });

test("read code clicks use the requested offset on wrapped rows, but not the continuation notice", () => {
	const locations: string[] = [];
	const read = tool("read", (path, line) => locations.push(`${path}:${line}`));
	const context = { args: { path: "src/file.ts", offset: 40 }, state: {}, expanded: true, invalidate() {} };
	const result = read.renderResult({ content: [{ type: "text", text: "const longName = 12345678901234567890;\nnext();\n\n[Showing lines 40-41 of 80. Use offset=42 to continue.]" }] }, { expanded: true }, theme, context);
	const lines = result.render(32).map(stripTerminalSequences);
	const second = lines.findIndex((line) => line.includes("next();"));
	assert.ok(second > 1, "first source line wraps");
	for (let y = 0; y < second; y++) assert.deepEqual(result.handleMouse?.(click(y)), { handled: true });
	assert.deepEqual(result.handleMouse?.(click(second)), { handled: true });
	assert.deepEqual(locations, [...Array(second).fill("src/file.ts:40"), "src/file.ts:41"]);
	result.handleMouse?.(click(lines.findIndex((line) => line.includes("Showing lines"))));
	assert.equal(locations.length, second + 1);
});

test("the extension appends clicked references to the current draft and releases the session", () => {
	const handlers: Record<string, Function> = {};
	const tools: Record<string, any> = {};
	const pi = {
		on(name: string, handler: Function) { handlers[name] = handler; },
		registerTool(definition: any) { tools[definition.name] = definition; },
	};
	const factories = Object.fromEntries(BUILTIN_TOOL_NAMES.map((name) => [name, () => ({
		name, description: "", parameters: {}, execute: async () => ({ content: [] }),
	})]));
	createGrokStyleExtension(pi as any, { tools: factories as any, CustomEditor: class {} as any,
		features: { footer: false, composer: false, activity: false, terminalColors: false, communication: false } });
	let draft = "Please inspect [paste:1]";
	const ctx = { cwd: "/repo", mode: "tui", ui: {
		getEditorText: () => draft.replace("[paste:1]", "pasted contents"),
		setEditorText: (_text: string) => { throw Error("replacing the draft loses paste markers"); },
		pasteToEditor: (text: string) => { draft += text; },
	} };
	handlers.session_start({}, ctx);
	const context = { args: { path: "src/a.ts", offset: 7 }, state: {}, expanded: true, invalidate() {} };
	const read = tools.read.renderResult({ content: [{ type: "text", text: "first\nsecond" }] }, { expanded: true }, theme, context);
	read.render(40);
	read.handleMouse(click(1));
	read.handleMouse(click(0));
	assert.equal(draft, "Please inspect [paste:1] src/a.ts:8  src/a.ts:7 ");
	read.handleMouse({ type: "press", button: "left", x: 4, y: 0, width: 40 });
	read.handleMouse({ type: "drag", button: "left", x: 4, y: 1, width: 40 });
	read.handleMouse({ type: "release", button: "left", x: 4, y: 1, width: 40 });
	read.handleMouse(click(0));
	assert.equal(draft, "Please inspect [paste:1] src/a.ts:8  src/a.ts:7  src/a.ts:7-8 ");
	const cursor = "Please".length;
	ctx.ui.pasteToEditor = (text: string) => { draft = draft.slice(0, cursor) + text + draft.slice(cursor); };
	read.handleMouse(click(0));
	assert.equal(draft, "Please src/a.ts:7  inspect [paste:1] src/a.ts:8  src/a.ts:7  src/a.ts:7-8 ");
	handlers.session_shutdown();
	read.handleMouse(click(0));
	assert.equal(draft, "Please src/a.ts:7  inspect [paste:1] src/a.ts:8  src/a.ts:7  src/a.ts:7-8 ");
});

test("drag-selected code clicks insert a line range, with single clicks unchanged", () => {
	const locations: string[] = [];
	const read = tool("read", (path, line, endLine) => locations.push(`${path}:${line}${endLine ? `-${endLine}` : ""}`));
	const context = { args: { path: "src/a.ts", offset: 40 }, state: {}, expanded: true, invalidate() {} };
	const result = read.renderResult({ content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }] }, { expanded: true }, theme, context);
	result.render(60);
	const mouse = (type: "press" | "drag" | "release", y: number) => ({ type, button: "left", x: 4, y, width: 60 } as const);
	assert.equal(result.handleMouse?.(mouse("press", 2)), undefined);
	assert.equal(result.handleMouse?.(mouse("drag", 0)), undefined);
	assert.equal(result.handleMouse?.(mouse("release", 0)), undefined);
	assert.deepEqual(result.handleMouse?.(click(1)), { handled: true });
	assert.deepEqual(locations, ["src/a.ts:40-42"]);
	result.handleMouse?.(click(3));
	assert.deepEqual(locations, ["src/a.ts:40-42", "src/a.ts:43"]);
});

test("selection ending on a notice keeps only the selected source lines", () => {
	const locations: string[] = [];
	const read = tool("read", (path, line, end) => locations.push(`${path}:${line}${end ? `-${end}` : ""}`));
	const context = { args: { path: "a.ts" }, state: {}, expanded: true, invalidate() {} };
	const result = read.renderResult({ content: [{ type: "text", text: "one\ntwo\nthree\n\n[Showing lines 1-3 of 9. Use offset=4 to continue.]" }] }, { expanded: true }, theme, context);
	const lines = result.render(80).map(stripTerminalSequences);
	const noticeY = lines.findIndex((row) => row.includes("Showing lines"));
	const mouse = (type: "press" | "drag" | "release", y: number) => ({ type, button: "left", x: 8, y, width: 80 } as const);
	result.handleMouse?.(mouse("press", 0));
	result.handleMouse?.(mouse("drag", noticeY));
	result.handleMouse?.(mouse("release", noticeY));
	result.handleMouse?.(click(1));
	assert.deepEqual(locations, ["a.ts:1-3"]);
});

test("resizing during a drag discards the old visual selection coordinates", () => {
	const locations: string[] = [];
	const read = tool("read", (path, line, end) => locations.push(`${path}:${line}${end ? `-${end}` : ""}`));
	const context = { args: { path: "a.ts" }, state: {}, expanded: true, invalidate() {} };
	const result = read.renderResult({ content: [{ type: "text", text: "long first line here\nsecond\nthird" }] }, { expanded: true }, theme, context);
	result.render(14);
	result.handleMouse?.({ type: "press", button: "left", x: 4, y: 1, width: 14 });
	const widened = result.render(60).map(stripTerminalSequences);
	const last = widened.findIndex((row) => row.includes("third"));
	result.handleMouse?.({ type: "drag", button: "left", x: 4, y: last, width: 60 });
	result.handleMouse?.({ type: "release", button: "left", x: 4, y: last, width: 60 });
	result.handleMouse?.(click(1));
	assert.deepEqual(locations, ["a.ts:2"]);
});

test("selection only applies within selected cells and clears when another diamond is used", () => {
	const locations: string[] = [];
	const hooks = { onCodeLocation: (path: string, line: number, end?: number) => locations.push(`${path}:${line}${end ? `-${end}` : ""}`) };
	const make = (path: string) => {
		const read = wrapWithDiamondRenderer({ name: "read", description: "", parameters: {}, execute: async () => ({ content: [] }) } as any, hooks);
		const context = { args: { path }, state: {}, expanded: true, invalidate() {} };
		const result = read.renderResult({ content: [{ type: "text", text: "first\nsecond\nthird" }] }, { expanded: true }, theme, context);
		result.render(60);
		return result;
	};
	const a = make("a.ts");
	const b = make("b.ts");
	const mouse = (type: "press" | "drag" | "release", x: number, y: number) => ({ type, button: "left", x, y, width: 60 } as const);
	a.handleMouse?.(mouse("press", 10, 0));
	a.handleMouse?.(mouse("drag", 8, 2));
	a.handleMouse?.(mouse("release", 8, 2));
	a.handleMouse?.(click(0, 4)); // Outside the selected columns on the first line.
	assert.deepEqual(locations, ["a.ts:1"]);
	a.handleMouse?.(mouse("press", 10, 0));
	a.handleMouse?.(mouse("drag", 5, 2));
	a.handleMouse?.(mouse("release", 5, 2));
	a.handleMouse?.(click(2, 5)); // The selected release cell is included by Pi.
	assert.deepEqual(locations, ["a.ts:1", "a.ts:1-3"]);
	a.handleMouse?.(mouse("press", 10, 0));
	a.handleMouse?.(mouse("drag", 8, 2));
	a.handleMouse?.(mouse("release", 8, 2));
	b.handleMouse?.(click(1));
	a.handleMouse?.(click(1));
	assert.deepEqual(locations, ["a.ts:1", "a.ts:1-3", "b.ts:2", "a.ts:2"]);
});

test("fullscreen drag selection reaches the diamond without stealing native selection", async () => {
	const { TuiAltScreen, VStack } = await import("@earendil-works/pi-tui");
	const locations: string[] = [];
	let tui: InstanceType<typeof TuiAltScreen>;
	const hooks = { onCodeLocation: (path: string, line: number, end?: number) => locations.push(`${path}:${line}${end ? `-${end}` : ""}`),
		hasActiveSelection: () => tui.hasActiveSelection() };
	const render = (path: string) => wrapWithDiamondRenderer({ name: "read", description: "", parameters: {}, execute: async () => ({ content: [] }) } as any, hooks)
		.renderResult({ content: [{ type: "text", text: "one\ntwo\nthree" }] }, { expanded: true }, theme,
			{ args: { path }, state: {}, expanded: true, invalidate() {} });
	tui = new TuiAltScreen({ columns: 60, rows: 24, write() {} } as any, false, undefined, { copyOnSelect: false });
	const screen = tui as any;
	screen.requestRender = () => {};
	tui.setLayoutRoot(new VStack([render("a.ts"), textComponent("outside"), render("b.ts")]));
	screen.altScreenActive = true;
	screen.doRender();
	const send = (button: number, y: number, release = false) => screen.handleMouseEvent({ button, x: 5, y, release });
	send(0, 0);
	send(32, 2);
	send(0, 2, true);
	assert.equal(tui.hasActiveSelection(), true);
	send(0, 1);
	send(0, 1, true);
	assert.deepEqual(locations, ["a.ts:1-3"]);
	send(0, 0);
	send(32, 2);
	send(0, 2, true);
	send(0, 5); // Click the second diamond, dismissing the first selection.
	send(0, 5, true);
	send(0, 1);
	send(0, 1, true);
	assert.deepEqual(locations, ["a.ts:1-3", "b.ts:2", "a.ts:2"]);
	send(0, 0);
	send(32, 2);
	send(0, 2, true);
	send(0, 3); // Click outside any diamond; Pi clears the selection.
	send(0, 3, true);
	assert.equal(tui.hasActiveSelection(), false);
	send(0, 1);
	send(0, 1, true);
	assert.deepEqual(locations, ["a.ts:1-3", "b.ts:2", "a.ts:2", "a.ts:2"]);
});

test("styled tools observe fullscreen selection with all visual chrome disabled", () => {
	let installed = false;
	let active = true;
	const chrome = createSessionChrome({ on() {} } as any, { CustomEditor: class { render() { return ["native editor"]; } } as any,
		features: { composer: false, footer: false, terminalColors: false, toolStyling: true } });
	chrome.startSession({ cwd: "/repo", hasUI: true, ui: {
		setEditorComponent(factory: Function) {
			installed = true;
			const editor = factory({ hasActiveSelection: () => active }, {}, {});
			assert.deepEqual(editor.render(80), ["native editor"]);
		},
	} } as any);
	assert.equal(installed, true);
	assert.equal(chrome.hasActiveSelection(), true);
	active = false;
	assert.equal(chrome.hasActiveSelection(), false);
	chrome.dispose();
	assert.equal(chrome.hasActiveSelection(), undefined);
});

test("edit and created-write selections use their displayed source ranges", () => {
	const locations: string[] = [];
	const callback = (path: string, line: number, end?: number) => locations.push(`${path}:${line}${end ? `-${end}` : ""}`);
	const cases = [
		{ name: "edit", args: { path: "edited.ts" }, result: { content: [], details: { diff: "+10 changed\n 10 next" } }, expected: "edited.ts:10-11" },
		{ name: "write", args: { path: "created.ts" }, result: { content: [], details: { grokWrite: { kind: "created", lines: 2, preview: "first\nsecond" } } }, expected: "created.ts:1-2" },
	] as const;
	for (const entry of cases) {
		const context = { args: entry.args, state: {}, expanded: true, invalidate() {} };
		const result = tool(entry.name, callback).renderResult(entry.result, { expanded: true }, theme, context);
		const lines = result.render(80).map(stripTerminalSequences);
		const start = lines.findIndex((row) => row.includes(entry.name === "edit" ? "changed" : "first"));
		const end = lines.findIndex((row) => row.includes(entry.name === "edit" ? "next" : "second"));
		result.handleMouse?.({ type: "press", button: "left", x: 4, y: start, width: 80 });
		result.handleMouse?.({ type: "drag", button: "left", x: 8, y: end, width: 80 });
		result.handleMouse?.({ type: "release", button: "left", x: 8, y: end, width: 80 });
		result.handleMouse?.(click(start));
		assert.equal(locations.at(-1), entry.expected);
	}
});

test("fractional read offsets use the actual displayed source line", () => {
	const locations: number[] = [];
	const read = tool("read", (_path, line) => locations.push(line));
	const context = { args: { path: "demo.ts", offset: 2.5 }, state: {}, expanded: true, invalidate() {} };
	const result = read.renderResult({ content: [{ type: "text", text: "two\nthree" }] }, { expanded: true }, theme, context);
	result.render(40);
	result.handleMouse?.(click(0));
	result.handleMouse?.(click(1));
	assert.deepEqual(locations, [2, 3]);
});

test("image descriptions and warning-only reads do not pretend to be source lines", () => {
	const locations: string[] = [];
	const read = tool("read", (path, line) => locations.push(`${path}:${line}`));
	for (const [path, text] of [["photo.png", "Read image file [image/png]\n[Image omitted: could not be resized.]"],
		["source.ts", "[Line 7 is too long. Use offset=8 to continue.]"]] as const) {
		const context = { args: { path }, state: {}, expanded: true, invalidate() {} };
		const component = read.renderResult({ content: [{ type: "text", text }] }, { expanded: true }, theme, context);
		const lines = component.render(80);
		for (let y = 0; y < lines.length; y++) component.handleMouse?.(click(y));
	}
	assert.deepEqual(locations, []);
});

test("unchanged diff rows use their new-file line after insertions and deletions", () => {
	const locations: string[] = [];
	const edit = tool("edit", (path, line) => locations.push(`${path}:${line}`));
	for (const [diff, content] of [["+1 inserted\n 1 one\n 2 two", "one"],
		["- 1 removed\n 2 one", "one"]] as const) {
		const context = { args: { path: "a.ts" }, state: {}, expanded: false, invalidate() {} };
		const result = edit.renderResult({ content: [], details: { diff } }, { expanded: false }, theme, context);
		const lines = result.render(80).map(stripTerminalSequences);
		result.handleMouse?.(click(lines.findIndex((row) => row.includes(content))));
	}
	assert.deepEqual(locations, ["a.ts:2", "a.ts:1"]);
});

test("numbered edit diff and new-file rows copy their actual lines without collapsing", () => {
	const locations: string[] = [];
	const callback = (path: string, line: number) => locations.push(`${path}:${line}`);
	const edit = tool("edit", callback);
	const context = { args: { path: "a.ts" }, state: {}, expanded: false, invalidate() {} };
	const result = edit.renderResult({ content: [], details: { firstChangedLine: 80, diff: "@@ -80,2 +80,2 @@\n- 80 old\n+ 80 new\n  81 next" } }, { expanded: false }, theme, context);
	const lines = result.render(32).map(stripTerminalSequences);
	assert.deepEqual(result.handleMouse?.(click(lines.findIndex((row) => row.includes("@@")))), undefined);
	result.handleMouse?.(click(lines.findIndex((row) => row.includes("old"))));
	result.handleMouse?.(click(lines.findIndex((row) => row.includes("new"))));
	result.handleMouse?.(click(lines.findIndex((row) => row.includes("next"))));
	assert.deepEqual(locations, ["a.ts:80", "a.ts:80", "a.ts:81"]);
	assert.equal((context.state as any).grokEdit.open, true);

	const write = tool("write", callback);
	const createdContext = { args: { path: "new.ts", content: "one\ntwo" }, state: { grokWrite: { kind: "created", lines: 2, preview: "one\ntwo" } }, expanded: false, invalidate() {} } as any;
	const created = write.renderResult({ content: [], details: { grokWrite: { kind: "created", lines: 2, preview: "one\ntwo" } } }, { expanded: false }, theme, createdContext);
	const createdLines = created.render(32).map(stripTerminalSequences);
	created.handleMouse?.(click(createdLines.findIndex((row) => row.includes("two"))));
	assert.deepEqual(locations.at(-1), "new.ts:2");

	const fallbackContext = { args: { path: "remote.ts" }, state: {}, expanded: true, invalidate() {} };
	const fallback = write.renderResult({ content: [], details: { grokWrite: { kind: "unknown", lines: 2, preview: "alpha\nbeta", note: "Previous contents unavailable." } } },
		{ expanded: true }, theme, fallbackContext);
	const fallbackLines = fallback.render(32).map(stripTerminalSequences);
	fallback.handleMouse?.(click(fallbackLines.findIndex((row) => row.includes("beta"))));
	assert.deepEqual(locations.at(-1), "remote.ts:2");
});
