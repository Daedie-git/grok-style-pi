import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { suspendTerminalChrome, grokTerminalOscApply, grokTerminalOscReset } from "../src/chrome/terminal-chrome.ts";

test("suspension resets colors before stopping, resumes colors once, and cleans listeners", () => {
	const events = new EventEmitter();
	const writes: string[] = [];
	const chrome = suspendTerminalChrome((text) => writes.push(text), events as any);
	chrome.run(() => writes.push("suspend"));
	assert.deepEqual(writes, [grokTerminalOscReset(), "suspend"]);
	assert.equal(events.listenerCount("SIGTSTP"), 0);
	events.emit("SIGCONT");
	assert.equal(writes.at(-1), grokTerminalOscApply());
	assert.equal(events.listenerCount("SIGCONT"), 0);
	chrome.run(() => {});
	chrome.dispose();
	assert.equal(events.listenerCount("SIGCONT"), 0);
	const count = writes.length;
	events.emit("SIGCONT");
	assert.equal(writes.length, count);
});

test("failed suspension reapplies colors and releases the resume listener", () => {
	const events = new EventEmitter();
	const writes: string[] = [];
	const chrome = suspendTerminalChrome((text) => writes.push(text), events as any);
	assert.throws(() => chrome.run(() => { throw new Error("suspend failed"); }), /suspend failed/);
	assert.deepEqual(writes, [grokTerminalOscReset(), grokTerminalOscApply()]);
	assert.equal(events.listenerCount("SIGCONT"), 0);
});

test("a Node warning over unchanged composer rows forces a fullscreen repaint", async () => {
	const { createSessionChrome } = await import("../src/extension/session-chrome.ts");
	const warnings = new EventEmitter();
	const writes: string[] = [];
	const terminal = {
		columns: 60, rows: 10, kittyProtocolActive: false,
		start() {}, stop() {}, drainInput: async () => {},
		write(text: string) { writes.push(text); },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new TuiAltScreen(terminal);
	class Editor { render() { return ["─────", "draft", "─────"]; } }
	const chrome = createSessionChrome({ on() {}, registerTool() {} }, {
		CustomEditor: Editor,
		features: { footer: false, composer: true, terminalColors: false },
		warningEvents: warnings,
	} as any);
	try {
		chrome.startSession({ cwd: process.cwd(), hasUI: true, ui: {
			setEditorComponent(factory: Function) { tui.addChild(factory(tui, {}, {})); },
		} } as any);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.ok(writes.join("").includes("╰"));
		// This write bypasses Pi's cached screen, exactly as Node's default warning handler does.
		terminal.write("(Use `node --trace-warnings ...` to show where the warning was created)");
		writes.length = 0;
		tui.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.ok(!writes.join("").includes("╰"), "ordinary diff rendering leaves the overwritten border untouched");
		writes.length = 0;
		warnings.emit("warning", new Error("late host warning"));
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.ok(writes.join("").includes("╰"), "warning recovery must repaint the unchanged composer border");
	} finally { chrome.dispose(); tui.stop(); }
	assert.equal(warnings.listenerCount("warning"), 0);
});

test("warning repaint listeners survive session changes once and ignore non-fullscreen modes", async () => {
	const { createSessionChrome } = await import("../src/extension/session-chrome.ts");
	const warnings = new EventEmitter();
	const paints: unknown[] = [];
	const notices: string[] = [];
	class Editor { render() { return []; } }
	const chrome = createSessionChrome({ on() {}, registerTool() {} }, {
		CustomEditor: Editor,
		features: { footer: true, composer: true, terminalColors: false },
		warningEvents: warnings,
	} as any);
	const session = (mode: string, failNotice = false) => ({ cwd: process.cwd(), hasUI: true, ui: {
		notify(message: string) { notices.push(message); if (failNotice) throw new Error("notification failed"); },
		setFooter(factory: Function) { factory({ mode, requestRender(force?: boolean) { paints.push(force); } }, {}); },
		setEditorComponent(factory: Function) { factory({ mode, requestRender(force?: boolean) { paints.push(force); } }, {}, {}); },
	} });
	try {
		chrome.startSession(session("fullscreen") as any);
		chrome.startSession(session("fullscreen", true) as any);
		assert.equal(warnings.listenerCount("warning"), 1);
		assert.doesNotThrow(() => warnings.emit("warning", new Error("visible diagnostic")));
		assert.deepEqual(paints, [true]);
		assert.deepEqual(notices, ["Error: visible diagnostic"]);
		chrome.startSession(session("regular") as any);
		warnings.emit("warning", new Error("regular mode"));
		assert.deepEqual(paints, [true]);
		chrome.startSession({ ...session("fullscreen"), hasUI: false, mode: "json" } as any);
		warnings.emit("warning", new Error("json mode"));
		assert.deepEqual(paints, [true]);
	} finally { chrome.dispose(); }
	assert.equal(warnings.listenerCount("warning"), 0);
	warnings.emit("warning", new Error("after shutdown"));
	assert.deepEqual(paints, [true]);
});

for (const footer of [true, false]) {
	test(`applying startup colors requests a full repaint (${footer ? "footer" : "editor"})`, async () => {
		const { createSessionChrome } = await import("../src/extension/session-chrome.ts");
		const events: unknown[] = [];
		const tui = {
			terminal: { write(text: string) { events.push(text); } },
			requestRender(force?: boolean) { events.push(force); },
		};
		class Editor { render() { return []; } }
		const chrome = createSessionChrome({ on() {}, registerTool() {} }, {
			CustomEditor: Editor,
			features: { footer, composer: true, terminalColors: true },
		});
		try {
			chrome.startSession({ cwd: process.cwd(), hasUI: true, ui: {
				setFooter(factory: Function) { factory(tui, {}); },
				setEditorComponent(factory: Function) { factory(tui, {}, {}); },
			} } as any);
			assert.deepEqual(events, [grokTerminalOscApply(), true]);
		} finally { chrome.dispose(); }
	});
}
