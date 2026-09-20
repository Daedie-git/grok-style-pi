import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityPanel, ActivityViewer, type Activity } from "../src/activity-ui.ts";
import { installActivityPanel } from "../src/activity.ts";
import { wrapWithDiamondRenderer } from "../src/tools.ts";

const theme = { fg: (_token: string, text: string) => text };
const click = (x: number, y: number) => ({ type: "click", button: "left", x, y } as any);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(getRecord = (_id: string): any => undefined, mode = "tui") {
	const handlers = new Map<string, Function[]>();
	const bus = new Map<string, Set<Function>>();
	const commands = new Map<string, any>();
	let panel: ActivityPanel | undefined;
	let widget: any;
	let overlayCalls = 0;
	let viewer: ActivityViewer | undefined;
	let redraws = 0;
	const notifications: string[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() { redraws++; },
		showOverlay(component: ActivityPanel, options: any) {
			overlayCalls++;
			return { hide() { panel = undefined; } };
		},
	};
	const events = {
		on(name: string, fn: Function) { const set = bus.get(name) ?? new Set(); set.add(fn); bus.set(name, set); return () => { set.delete(fn); }; },
		emit(name: string, data: unknown) { for (const fn of bus.get(name) ?? []) fn(data); },
	};
	const pi = {
		on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		events,
		registerCommand(name: string, command: any) { commands.set(name, command); },
	};
	const ctx = { mode, ui: {
		setWidget(_key: string, factory: any, options?: any) {
			if (factory) assert.equal(options.placement, "aboveEditor");
			widget?.dispose?.();
			widget = factory?.(tui, theme);
			panel = widget;
		},
		notify(message: string) { notifications.push(message); },
		select: async (_title: string, options: string[]) => options[0],
		custom(factory: any) {
			return new Promise<void>((resolve) => { viewer = factory(tui, theme, {}, () => { viewer = undefined; resolve(); }); });
		},
	} };
	const controller = installActivityPanel(pi as any, getRecord);
	const emit = (name: string) => { for (const handler of handlers.get(name) ?? []) handler({}, ctx); };
	emit("session_start");
	return { controller, ctx, events, emit, commands, notifications, panel: () => panel!, viewer: () => viewer, redraws: () => redraws,
		widget: () => widget, overlayCalls: () => overlayCalls,
		listenerCount: () => [...bus.values()].reduce((sum, set) => sum + set.size, 0) };
}

test("panel buttons retain correct hit targets at narrow and wide widths", () => {
	const entry: Activity = { id: "a", kind: "command", title: "echo 中文", status: "running", stop: () => {}, startedAt: Date.now(), output: "" };
	let viewed = 0, stopped = 0;
	let dismissed = 0;
	const panel = new ActivityPanel(() => [entry], theme, () => viewed++, () => stopped++, () => {}, () => dismissed++);
	for (const width of [1, 8, 20, 80]) {
		assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
	}
	const row = panel.render(80)[1];
	panel.handleMouse(click(visibleWidth(row.slice(0, row.indexOf("[View]"))), 1));
	panel.handleMouse(click(visibleWidth(row.slice(0, row.indexOf("[Stop]"))), 1));
	assert.equal(viewed, 1); assert.equal(stopped, 1);
	panel.handleMouse(click(visibleWidth(row.slice(0, row.indexOf("[Close]"))), 1));
	assert.equal(dismissed, 1);
	assert.equal(stopped, 1);
	panel.handleMouse(click(1, 1));
	assert.equal(viewed, 1);
	entry.status = "completed";
	assert.deepEqual(panel.render(80), []);
});

test("stopping one command preserves its peer and parent signal, output stays inspectable", async (t) => {
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	const parent = new AbortController();
	const signals = new Map<string, AbortSignal>();
	const finishes = new Map<string, (value: any) => void>();
	const tool = h.controller.wrapTool(wrapWithDiamondRenderer({
		name: "bash", description: "test", parameters: {},
		execute(id, _args, signal, update) {
			signals.set(id, signal);
			update({ content: [{ type: "text", text: `live output ${id}` }] });
			return new Promise((resolve, reject) => { finishes.set(id, resolve); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
		},
	}));
	const first = (tool.execute("one", { command: "first" }, parent.signal) as Promise<any>).catch((error) => error.message);
	const second = tool.execute("two", { command: "second" }, parent.signal) as Promise<any>;
	const lines = h.panel().render(100);
	const row = lines.findIndex((line) => line.includes("first"));
	h.panel().handleMouse(click(lines[row].indexOf("[View]"), row));
	await flush();
	assert.match(h.viewer()!.render(80).join("\n"), /live output one/);
	h.viewer()!.handleInput("x");
	await flush();
	assert.equal(await first, "aborted");
	assert.equal(signals.get("two")!.aborted, false);
	assert.equal(parent.signal.aborted, false);
	assert.match(h.viewer()!.render(80).join("\n"), /stopped/);
	h.viewer()!.handleInput("\x1b");
	await flush();
	assert.equal(h.viewer(), undefined);
	finishes.get("two")!({ content: [{ type: "text", text: "finished second" }] });
	await second;
	assert.deepEqual(h.panel().render(100), []);
	assert.equal(h.controller.list().length, 2);
	assert.equal(h.controller.list().find((entry) => entry.id === "command:two")!.output, "finished second");
});

test("subagent viewer follows its session and Stop uses RPC without consuming its result", async (t) => {
	const listeners = new Set<Function>();
	const record = { status: "running", session: {
		state: { messages: [{ role: "user", content: "inspect the build" }] },
		subscribe(fn: Function) { listeners.add(fn); return () => listeners.delete(fn); },
	} };
	const h = harness((id) => id === "agent-1" ? record : undefined);
	t.after(() => h.emit("session_shutdown"));
	h.events.emit("subagents:started", { id: "agent-1", type: "Explore", description: "inspect build" });
	h.events.emit("subagents:created", { id: "agent-1", type: "Explore", description: "inspect build" });
	assert.equal(h.controller.list()[0].status, "running");
	const selecting = h.commands.get("activity").handler();
	await flush();
	for (const listener of listeners) listener({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Reading build files" }] } });
	assert.match(h.viewer()!.render(80).join("\n"), /Reading build files/);
	let stopped = "", consumed = false;
	h.events.on("subagents:rpc:consume", () => { consumed = true; });
	h.events.on("subagents:rpc:stop", (request: any) => {
		stopped = request.agentId;
		record.status = "stopped";
		h.events.emit("subagents:failed", { id: "agent-1", status: "stopped", error: "Stopped" });
		h.events.emit(`subagents:rpc:stop:reply:${request.requestId}`, { success: true });
	});
	h.viewer()!.handleInput("x");
	await flush();
	assert.equal(stopped, "agent-1");
	assert.equal(consumed, false);
	assert.equal(h.controller.list()[0].status, "stopped");
	assert.equal(listeners.size, 0);
	h.viewer()!.handleInput("\x1b");
	await selecting;
	assert.deepEqual(h.notifications, []);
});

test("session shutdown closes viewers and releases all activity listeners", async () => {
	let unsubscribed = false;
	const h = harness(() => ({ status: "running", session: { state: { messages: [] }, subscribe: () => () => { unsubscribed = true; } } }));
	h.events.emit("subagents:started", { id: "one" });
	const viewing = h.commands.get("activity").handler();
	await flush();
	assert.ok(h.viewer());
	h.emit("session_shutdown");
	await viewing;
	assert.equal(unsubscribed, true);
	assert.equal(h.listenerCount(), 0);
	assert.equal(h.controller.list().length, 0);
	assert.equal(h.viewer(), undefined);
});

test("headless sessions do not subscribe or render an activity panel", () => {
	const h = harness(undefined, "print");
	assert.equal(h.listenerCount(), 0);
	assert.equal(h.panel(), undefined);
	h.emit("session_shutdown");
});

test("viewer follows live output, pauses on scroll, and strips terminal control sequences", () => {
	const entry: Activity = { id: "a", kind: "command", title: "test", status: "running", startedAt: 0,
		output: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\x1b]52;c;evil\x07" };
	const viewer = new ActivityViewer(entry, theme, () => 20, () => {}, () => {}, () => {});
	assert.match(viewer.render(40).join("\n"), /line 49/);
	viewer.handleInput("\x1b[H");
	assert.match(viewer.render(40).join("\n"), /line 0\s*[┃│]/);
	assert.doesNotMatch(viewer.render(40).join("\n"), /line 49/);
	viewer.handleInput("\x1b[F");
	const rendered = viewer.render(40);
	assert.match(rendered.join("\n"), /line 49/);
	assert.doesNotMatch(rendered.join("\n"), /evil/);
	assert.ok(rendered.every((line) => visibleWidth(line) <= 40));
});

test("viewer frame and header Close survive resizing without stopping the agent", () => {
	const entry: Activity = { id: "a", kind: "agent", title: "Explore: 中文 very long task title", status: "running", startedAt: 0, output: "Live output" };
	let closed = 0, stopped = 0, rows = 24;
	const viewer = new ActivityViewer(entry, theme, () => rows, () => {}, () => closed++, () => stopped++);
	for (const width of [80, 20, 10, 6, 4]) {
		const lines = viewer.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
		assert.match(lines[0], /^╭─+╮$/);
		assert.match(lines.at(-1)!, /^╰─+╯$/);
		assert.ok(lines.slice(1, -1).every((line) => /^[│├].*[│┤]$/.test(line)));
		const label = lines[1].includes("[Close]") ? "[Close]" : lines[1].includes("[x]") ? "[x]" : "×";
		viewer.handleMouse(click(visibleWidth(lines[1].slice(0, lines[1].indexOf(label))), 1));
	}
	assert.equal(closed, 5);
	assert.equal(stopped, 0);
	rows = 5;
	const short = viewer.render(40);
	assert.equal(short.length, 3);
	viewer.handleMouse(click(short[1].indexOf("[Close]"), 1));
	assert.equal(closed, 6);
});

test("activity reserves widget rows without overlays and dismissed agents remain inspectable", async (t) => {
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	assert.equal(h.overlayCalls(), 0);
	assert.deepEqual(h.widget().render(80), []);
	assert.deepEqual(h.panel().render(80), []);
	let stopped = false;
	h.events.on("subagents:rpc:stop", () => { stopped = true; });
	h.events.emit("subagents:started", { id: "one", type: "Explore", description: "inspect build" });
	assert.equal(h.widget().render(80).length, 2);
	assert.equal(h.overlayCalls(), 0);
	const row = h.panel().render(80)[1];
	h.panel().handleMouse(click(row.indexOf("[Close]"), 1));
	assert.deepEqual(h.panel().render(80), []);
	assert.equal(h.controller.list()[0].status, "running");
	const viewing = h.commands.get("activity").handler();
	await flush();
	const header = h.viewer()!.render(80)[1];
	h.viewer()!.handleMouse(click(header.indexOf("[Close]"), 1));
	await viewing;
	assert.equal(h.viewer(), undefined);
	assert.equal(stopped, false);
	h.emit("session_shutdown");
	assert.equal(h.panel(), undefined);
});


test("activity viewer retains its output limit and refreshes cached output", () => {
	const entry: Activity = { id: "a", kind: "command", title: "test", status: "running", startedAt: 0,
		output: "BEGIN_SENTINEL\n" + "middle\n".repeat(12000) + "END_SENTINEL" };
	const viewer = new ActivityViewer(entry, theme, () => 24, () => {}, () => {}, () => {});
	viewer.handleInput("\x1b[H");
	assert.match(viewer.render(80).join("\n"), /Earlier activity omitted/);
	assert.doesNotMatch(viewer.render(80).join("\n"), /BEGIN_SENTINEL/);
	entry.output = "Updated live output";
	assert.match(viewer.render(80).join("\n"), /Updated live output/);
});

test("failed subagents preserve terminal diagnostics alongside their transcript", (t) => {
	const record = { status: "running", session: { state: { messages: [{ role: "user", content: "inspect files" }] }, subscribe: () => () => {} } };
	const h = harness(() => record); t.after(() => h.emit("session_shutdown"));
	h.events.emit("subagents:started", { id: "failed" });
	record.status = "error";
	h.events.emit("subagents:failed", { id: "failed", error: "429 Too Many Requests" });
	assert.match(h.controller.list()[0].output, /inspect files/);
	assert.match(h.controller.list()[0].output, /429 Too Many Requests/);
});

test("real failed shell output is retained once with its exit status", async (t) => {
	const { createBashTool } = await import("@earendil-works/pi-coding-agent");
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	const tool = h.controller.wrapTool(wrapWithDiamondRenderer(createBashTool(process.cwd())));
	await assert.rejects(tool.execute("failed", { command: 'printf "UNIQUE_OUTPUT\\n"; exit 1' }, new AbortController().signal) as Promise<unknown>, /Command exited with code 1/);
	const output = h.controller.list()[0].output;
	assert.equal(output.split("UNIQUE_OUTPUT").length - 1, 1);
	assert.match(output, /Command exited with code 1/);
});

test("diagnostic merging retains the size limit and distinct failures", async () => {
	const { mergeActivityOutput } = await import("../src/activity.ts");
	assert.equal(mergeActivityOutput("output", "output\nfailed"), "output\nfailed");
	assert.equal(mergeActivityOutput("output\nfailed", "failed"), "output\nfailed");
	const output = mergeActivityOutput("x".repeat(64000), "independent failure");
	assert.equal(output.length, 64000);
	assert.ok(output.endsWith("independent failure"));
});

test("panel separates active subagents and tasks and removes empty sections", () => {
	const make = (id: string, kind: Activity["kind"], status: string): Activity => ({ id, kind, status, title: id, startedAt: 0, output: "" });
	const entries = [make("shell", "command", "running"), make("explorer", "agent", "queued"),
		make("old-shell", "command", "completed"), make("failed-agent", "agent", "error"), make("stopped-shell", "command", "stopped")];
	const viewed: string[] = [];
	const panel = new ActivityPanel(() => entries, theme, (entry) => viewed.push(entry.id), () => {}, () => {}, () => {});
	for (const width of [1, 20, 80]) assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
	const rows = panel.render(80);
	assert.equal(rows.length, 4);
	assert.match(rows[0], /Active subagents/);
	assert.match(rows[1], /explorer/);
	assert.doesNotMatch(rows[1], /[◆◈]/);
	assert.match(rows[2], /Active tasks/);
	assert.match(rows[3], /shell/);
	assert.doesNotMatch(rows[3], /◆/);
	assert.match(rows[3], /\[View\]/);
	assert.doesNotMatch(rows.join("\n"), /old-shell|failed-agent|stopped-shell/);
	for (const y of [1, 3]) panel.handleMouse(click(rows[y].indexOf("[View]"), y));
	assert.deepEqual(viewed, ["explorer", "shell"]);
	entries[1].status = "completed";
	assert.match(panel.render(80)[0], /Active tasks/);
	assert.equal(panel.render(80).length, 2);
	entries[0].status = "error";
	assert.deepEqual(panel.render(80), []);
});

test("activity selector strips terminal controls from titles and statuses", async (t) => {
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	h.events.emit("subagents:failed", { id: "unsafe", description: "task\x1b]52;c;VEVTVA==\x07\nnext", status: "error\x1b[31m" });
	let labels: string[] = [];
	h.ctx.ui.select = async (_title, options) => { labels = options; return undefined as any; };
	await h.commands.get("activity").handler();
	assert.equal(labels.length, 1);
	assert.doesNotMatch(labels[0], /[\x00-\x1f\x7f]|VEVTVA/);
	assert.match(labels[0], /task next · error/);
});

test("registry polling revives foreground resumes without lifecycle events", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const listeners = new Set<Function>();
	const record = { status: "running", startedAt: 10, completedAt: undefined as number | undefined, session: {
		state: { messages: [{ role: "user", content: "initial" }] }, abort: async () => {},
		subscribe(fn: Function) { listeners.add(fn); return () => listeners.delete(fn); },
	} };
	const h = harness(() => record); t.after(() => h.emit("session_shutdown"));
	h.events.emit("subagents:started", { id: "one" });
	record.status = "completed"; record.completedAt = 20;
	h.events.emit("subagents:completed", { id: "one" });
	assert.equal(listeners.size, 0);
	assert.deepEqual(h.panel().render(100), []);
	const idleRedraws = h.redraws();
	t.mock.timers.tick(1000);
	assert.equal(h.redraws(), idleRedraws);
	record.status = "running"; record.startedAt = 30; record.completedAt = undefined;
	record.session.state.messages.push({ role: "user", content: "resumed request" });
	t.mock.timers.tick(500);
	const entry = h.controller.list()[0];
	assert.equal(entry.status, "running");
	assert.equal(entry.startedAt, 30);
	assert.equal(entry.endedAt, undefined);
	assert.equal(listeners.size, 1);
	assert.match(entry.transcript!(), /resumed request/);
	assert.match(h.panel().render(100).join("\n"), /\[Stop\]/);
	record.status = "completed"; record.completedAt = 40;
	t.mock.timers.tick(500);
	assert.equal(entry.status, "completed");
	assert.equal(listeners.size, 0);
	assert.deepEqual(h.panel().render(100), []);
});

test("subagent partial tool output tracks concurrent calls and retires completed partials", (t) => {
	const listeners = new Set<Function>();
	const record = { status: "running", session: {
		state: { messages: [] as any[] }, subscribe(fn: Function) { listeners.add(fn); return () => listeners.delete(fn); },
	} };
	const h = harness(() => record); t.after(() => h.emit("session_shutdown"));
	h.events.emit("subagents:started", { id: "one" });
	const emit = (event: any) => { for (const fn of listeners) fn(event); };
	for (const id of ["a", "b"]) {
		emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id } });
		emit({ type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: { content: [{ type: "text", text: `partial ${id}` }] } });
	}
	const entry = h.controller.list()[0];
	assert.match(entry.transcript!(), /partial a/);
	assert.match(entry.transcript!(), /partial b/);
	emit({ type: "tool_execution_update", toolCallId: "b", toolName: "bash", partialResult: { content: [{ type: "text", text: "updated b" }] } });
	assert.doesNotMatch(entry.transcript!(), /partial b/);
	emit({ type: "tool_execution_end", toolCallId: "a" });
	record.session.state.messages.push({ role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "final a" }] });
	assert.doesNotMatch(entry.transcript!(), /partial a/);
	assert.match(entry.transcript!(), /final a/);
	assert.match(entry.transcript!(), /updated b/);
	assert.equal(entry.detail, "bash b");
});

test("a foreground resume that fails between polls replaces the previous success", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const record = { status: "running", startedAt: 10, completedAt: undefined as number | undefined,
		result: "", error: "", session: { state: { messages: [] as any[] }, subscribe: () => () => {} } };
	const h = harness(() => record); t.after(() => h.emit("session_shutdown"));
	h.events.emit("subagents:started", { id: "fast" });
	record.status = "completed"; record.completedAt = 20; record.result = "old success";
	h.events.emit("subagents:completed", { id: "fast", result: "old success" });
	const redraws = h.redraws();
	// No running state or lifecycle event is observable at the next poll.
	record.startedAt = 30; record.completedAt = 31; record.status = "error";
	record.result = ""; record.error = "429 Too Many Requests";
	t.mock.timers.tick(500);
	const entry = h.controller.list()[0];
	assert.equal(entry.status, "error");
	assert.equal(entry.startedAt, 30);
	assert.equal(entry.endedAt, 31);
	assert.match(entry.output, /429 Too Many Requests/);
	assert.doesNotMatch(entry.output, /old success/);
	assert.ok(h.redraws() > redraws);
	const after = h.redraws();
	t.mock.timers.tick(500);
	assert.equal(h.redraws(), after);
});

test("foreground-resume Stop aborts its live session instead of the stale RPC controller", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let executing = false, aborted = 0, rpc = 0;
	const record = { status: "running", startedAt: 10, completedAt: undefined as number | undefined, session: {
		state: { messages: [] }, subscribe: () => () => {},
		async abort() { aborted++; executing = false; record.status = "error"; record.completedAt = 40; },
	} };
	const h = harness(() => record); t.after(() => h.emit("session_shutdown"));
	h.events.on("subagents:rpc:stop", () => { rpc++; });
	h.events.emit("subagents:started", { id: "resume" });
	record.status = "completed"; record.completedAt = 20;
	h.events.emit("subagents:completed", { id: "resume" });
	record.status = "running"; record.startedAt = 30; record.completedAt = undefined; executing = true;
	t.mock.timers.tick(500);
	const rows = h.panel().render(100);
	h.panel().handleMouse(click(rows[1].indexOf("[Stop]"), 1));
	await flush();
	assert.equal(aborted, 1);
	assert.equal(executing, false);
	assert.equal(rpc, 0);
	assert.deepEqual(h.panel().render(100), []);
});

test("resumes without session cancellation do not offer Stop", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const record = { status: "running", startedAt: 10, session: { state: { messages: [] }, subscribe: () => () => {} } };
	const h = harness(() => record); t.after(() => h.emit("session_shutdown"));
	h.events.emit("subagents:started", { id: "resume" });
	record.status = "completed";
	h.events.emit("subagents:completed", { id: "resume" });
	record.status = "running"; record.startedAt = 20;
	t.mock.timers.tick(500);
	assert.equal(h.controller.list()[0].stop, undefined);
	assert.doesNotMatch(h.panel().render(100).join("\n"), /\[Stop\]/);
	let stopped = false;
	const viewer = new ActivityViewer(h.controller.list()[0], theme, () => 24, () => {}, () => {}, () => { stopped = true; });
	assert.doesNotMatch(viewer.render(100).join("\n"), /\[Stop/);
	viewer.handleInput("x");
	assert.equal(stopped, false);
});

test("agent and task viewer scrollbars track position, jump on click, and follow new output", () => {
	for (const kind of ["agent", "command"] as const) {
		const entry: Activity = { id: "scroll", kind, title: "Live output", status: "running", startedAt: 0,
			output: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") };
		const viewer = new ActivityViewer(entry, theme, () => 20, () => {}, () => {}, () => {});
		let lines = viewer.render(40);
		assert.equal(lines[10][38], "┃", "following output places thumb at bottom");
		viewer.handleMouse(click(38, 3));
		lines = viewer.render(40);
		assert.equal(lines[3][38], "┃");
		assert.match(lines[3], /line 0/);
		entry.output += "\nnew output";
		assert.match(viewer.render(40)[3], /line 0/, "scrolling away pauses follow");
		viewer.handleMouse(click(38, 10));
		assert.match(viewer.render(40).join("\n"), /new output/);
		entry.output += "\nlatest output";
		assert.match(viewer.render(40).join("\n"), /latest output/, "bottom click resumes follow");
		for (const width of [4, 5, 6, 20, 80]) assert.ok(viewer.render(width).every(line => visibleWidth(line) === width));
		entry.output = "short output";
		assert.doesNotMatch(viewer.render(40).join("\n"), /┃/, "no scrollbar when output fits");
	}
});

test("viewer scrollbar handles real fullscreen press/drag/release dispatch in an overlay", async () => {
	const { TuiAltScreen } = await import("@earendil-works/pi-tui");
	const terminal = { columns: 80, rows: 24, write() {} } as any;
	const tui = new TuiAltScreen(terminal, false) as any;
	tui.requestRender = () => {};
	const entry: Activity = { id: "drag", kind: "agent", title: "Output", status: "running", startedAt: 0,
		output: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") };
	const viewer = new ActivityViewer(entry, theme, () => 20, () => {}, () => {}, () => {});
	const height = viewer.render(40).length;
	// Same positioned overlay layout used by Pi's dispatchMouseToOverlay.
	tui.renderedOverlayLayouts = [{ entry: { component: viewer }, col: 10, row: 4, width: 40, height }];
	const send = (button: number, x: number, y: number, release = false) => tui.handleMouseEvent({ button, x, y, release });
	send(0, 48, 7); // Press at top of scrollbar, in screen coordinates.
	assert.match(viewer.render(40)[3], /line 0/);
	send(32, 55, 10); // Drag outside overlay horizontally; capture retains the gesture.
	assert.doesNotMatch(viewer.render(40)[3], /line 0\s/);
	send(0, 55, 14, true);
	assert.match(viewer.render(40).join("\n"), /line 99/);
	entry.output += "\nlatest";
	assert.match(viewer.render(40).join("\n"), /latest/);
	send(0, 49, 7); // Adjacent border is part of the generous scrollbar hit target.
	send(0, 49, 7, true);
	assert.match(viewer.render(40)[3], /line 0/);
});
