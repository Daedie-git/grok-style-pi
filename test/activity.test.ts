import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityPanel, ActivityViewer, type Activity } from "../src/activity/ui.ts";
import { installActivityPanel } from "../src/activity/panel.ts";
import { subagentRuntimeLabel } from "../src/subagents/adapter.ts";
import { FakeEngine, agentSnapshot } from "./fixtures/engine-activity.ts";
import { wrapWithDiamondRenderer } from "../src/tools/renderer.ts";

const theme = { fg: (_token: string, text: string) => text };
const click = (x: number, y: number) => ({ type: "click", button: "left", x, y } as any);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(_unused?: undefined, mode = "tui") {
	const engine = new FakeEngine();
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
	const controller = installActivityPanel(pi as any);
	controller.attachEngine(engine);
	const emit = (name: string) => { for (const handler of handlers.get(name) ?? []) handler({}, ctx); };
	emit("session_start");
	return { engine, controller, ctx, events, emit, commands, notifications, panel: () => panel!, viewer: () => viewer, redraws: () => redraws,
		widget: () => widget, overlayCalls: () => overlayCalls,
		listenerCount: () => [...bus.values()].reduce((sum, set) => sum + set.size, 0) };
}

test("engine activity follows live events and Stop requests a user-source stop", async (t) => {
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	h.engine.spawn();
	assert.match(h.panel().render(100).join("\n"), /Explore: inspect build/);
	assert.match(h.panel().render(100).join("\n"), /grok-4.6 · high/);
	const viewing = h.commands.get("activity").handler();
	await flush();
	h.engine.text("Reading build files");
	assert.match(h.viewer()!.render(80).join("\n"), /Reading build files/);
	h.viewer()!.handleInput("x"); await flush();
	assert.deepEqual(h.engine.stops, ["one"]);
	assert.equal(h.controller.list()[0].status, "stopping");
	h.engine.settle("killed");
	assert.equal(h.controller.list()[0].status, "stopped");
	assert.equal(h.controller.list()[0].stop, undefined);
	assert.deepEqual(h.panel().render(80), []);
	h.viewer()!.handleInput("\x1b"); await viewing;
	assert.deepEqual(h.notifications, []);
});

test("shutdown closes viewers and unsubscribes engine; headless sessions remain inert", async () => {
	const h = harness(); h.engine.spawn();
	const viewing = h.commands.get("activity").handler(); await flush();
	assert.equal(h.engine.listeners.size, 1);
	h.emit("session_shutdown"); await viewing;
	assert.equal(h.engine.listeners.size, 0);
	assert.equal(h.controller.list().length, 0);
	const headless = harness(undefined, "print");
	assert.equal(headless.engine.listeners.size, 0);
	headless.emit("session_shutdown");
});

test("dismissed agents stay inspectable, resumes reappear, and replacement engines disconnect", async (t) => {
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	h.engine.spawn();
	const row = h.panel().render(100)[1];
	h.panel().handleMouse(click(row.indexOf("[Close]"), 1));
	assert.deepEqual(h.panel().render(100), []);
	assert.equal(h.controller.list().length, 1);
	h.engine.settle();
	h.engine.emit({ type: "run-event", agentId: "one", runId: "r2", event: { type: "started" } });
	assert.match(h.panel().render(100).join("\n"), /inspect build/);
	const replacement = new FakeEngine(); h.controller.attachEngine(replacement);
	assert.equal(h.engine.listeners.size, 0);
	assert.equal(replacement.listeners.size, 1);
	assert.equal(h.controller.list().length, 0);
});

test("engine attachment restores already-running agents from public snapshots", async (t) => {
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	const engine = new FakeEngine();
	h.controller.attachEngine({
		subscribe: (listener) => engine.subscribe(listener),
		userStop: (id) => engine.userStop(id),
		agentSnapshots: () => [agentSnapshot()],
	});
	assert.equal(h.controller.list().length, 1);
	assert.match(h.panel().render(100).join("\n"), /Explore: inspect build/);
	await h.controller.list()[0].stop!();
	assert.deepEqual(engine.stops, ["one"]);
	engine.settle("killed");
	assert.equal(h.controller.list()[0].status, "stopped");
});

test("snapshot hydration needs no registry and skips inactive or unidentified runs", async (t) => {
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	const engine = new FakeEngine();
	Object.defineProperty(engine, "control", { get() { throw new Error("Activity must not read the engine registry"); } });
	engine.snapshots = [
		{ ...agentSnapshot("pane", "pane-run"), backend: "herdr", model: "provider/pane-model", effort: "low", startedAt: 123 },
		{ ...agentSnapshot("finished"), running: false, status: "completed" },
		{ ...agentSnapshot("without-run"), runId: undefined },
	];
	h.controller.attachEngine(engine);
	assert.deepEqual(h.controller.list().map((entry) => entry.id), ["agent:pane"]);
	const entry = h.controller.list()[0];
	assert.equal(entry.startedAt, 123);
	assert.equal(entry.model, "provider/pane-model · low");
	await entry.stop!();
	assert.deepEqual(engine.stops, ["pane"]);
});

test("engine text events coalesce redraws and bounded terminal output keeps diagnostics", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness(); t.after(() => h.emit("session_shutdown")); h.engine.spawn();
	const before = h.redraws();
	for (let i = 0; i < 100; i++) h.engine.text(`token ${i}\n`);
	assert.equal(h.redraws(), before);
	t.mock.timers.tick(16); assert.equal(h.redraws(), before + 1);
	h.engine.text("x".repeat(100000));
	assert.equal(h.controller.list()[0].transcript!().length, 64000);
	h.engine.emit({ type: "diagnostics", agentId: "one", messages: ["diagnostic"] });
	h.engine.settle("failed");
	assert.equal(h.controller.list()[0].status, "failed");
	assert.match(h.controller.list()[0].output, /diagnostic/);
	assert.ok(h.controller.list()[0].output.length <= 64000);
	assert.equal(h.controller.list()[0].transcript, undefined);
});

test("runtime labels use engine effective model and effort and sanitize controls", () => {
	assert.equal(subagentRuntimeLabel({ model: "grok\x1b[31m", effort: "high" }), "grok · high");
	assert.equal(subagentRuntimeLabel({}), undefined);
});

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
	// Anywhere else on the row opens the viewer.
	panel.handleMouse(click(1, 1));
	assert.equal(viewed, 2);
	panel.handleMouse(click(40, 1));
	assert.equal(viewed, 3);
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


test("real failed shell output is retained once with its exit status", async (t) => {
	const { createBashTool } = await import("@earendil-works/pi-coding-agent");
	const h = harness(); t.after(() => h.emit("session_shutdown"));
	const tool = h.controller.wrapTool(wrapWithDiamondRenderer(createBashTool(process.cwd())));
	const result = await tool.execute("failed", { command: 'printf "UNIQUE_OUTPUT\\n"; exit 1' }, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(h.controller.list()[0].status, "error");
	const output = h.controller.list()[0].output;
	assert.equal(output.split("UNIQUE_OUTPUT").length - 1, 1);
	assert.match(output, /Command exited with code 1/);
});

test("diagnostic merging retains the size limit and distinct failures", async () => {
	const { mergeActivityOutput } = await import("../src/activity/panel.ts");
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
