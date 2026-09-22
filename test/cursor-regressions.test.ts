import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import * as agent from "@earendil-works/pi-coding-agent";
import { absPath, createOpenHistory, openInCursor } from "../src/navigation/open-in-cursor.ts";
import { BUILTIN_TOOL_NAMES, wrapWithDiamondRenderer } from "../src/tools/renderer.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { dispatchFileLink } from "../src/navigation/file-link-bridge.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const click = { type: "click", button: "left", ctrl: true, x: 0, y: 0, width: 80, height: 1 } as any;
const theme = { fg: (_: string, text: string) => text };

function harness(launch = async (_target: any) => {}, refreshCompileCommands?: any) {
	const handlers: Record<string, Function> = {}, tools: Record<string, any> = {}, commands: Record<string, any> = {};
	const notifications: any[] = [];
	let transform: ((markdown: string, context: any) => string) | undefined;
	const ctx = { cwd: "/repo", hasUI: true, mode: "tui", ui: { notify: (...args: any[]) => notifications.push(args), select: async (_title: string, labels: string[]) => labels[0] } };
	createGrokStyleExtension({
		on: ((name: string, fn: Function) => { handlers[name] = fn; }) as any,
		registerTool(tool) { tools[tool.name] = tool; },
		registerCommand(name, command) { commands[name] = command; },
		registerMarkdownTransformer(handler) { transform = handler; },
	}, {
		CustomEditor: class {} as any,
		features: { footer: false, composer: false, terminalColors: false },
		tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map((name) => [name, () => ({ name, description: name, parameters: {}, execute: async () => ({ content: [] }) })])) as any,
		openCursor: launch,
		hyperlinks: () => true,
		refreshCompileCommands,
	});
	const edit = (path: string, line = 1, isError = false, toolName = "edit") => handlers.tool_result({ toolName, input: { path }, details: { firstChangedLine: line }, isError }, ctx);
	const markdown = (text: string) => transform?.(text, { messageType: "assistant", isStreaming: false, availableWidth: 80 });
	const urlFor = (reference: string) => {
		const text = markdown(`\`${reference}\``);
		const url = /\(<([^>]+)>\)/.exec(text ?? "")?.[1];
		assert.ok(url, text);
		assert.match(url, /^grok-pi-file:/);
		return url;
	};
	cleanups.push(() => handlers.session_shutdown({}, ctx));
	return { handlers, tools, commands, ctx, notifications, edit, markdown, urlFor, openLink: dispatchFileLink };
}

test("Cursor targets normalize built-in @ and home forms", () => {
	for (const path of ["~", "@~"]) assert.equal(absPath(path, "/repo"), homedir());
	for (const path of ["~/src/a.ts", "@~/src/a.ts"]) assert.equal(absPath(path, "/repo"), join(homedir(), "src/a.ts"));
	assert.equal(absPath("@src/a.ts", "/repo"), "/repo/src/a.ts");
	assert.equal(absPath("@/tmp/a.ts", "/repo"), "/tmp/a.ts");
	assert.equal(absPath("~someone/a.ts", "/repo"), "/repo/~someone/a.ts");
});

test("edited history snapshots are isolated, bounded and independently owned", () => {
	const history = createOpenHistory();
	history.rememberOpen({ path: "a", line: 3, cwd: "/repo" });
	const snapshot = history.recentOpens();
	history.rememberOpen({ path: "b", line: 5, cwd: "/repo" });
	assert.equal(snapshot[0].path, "/repo/a");
	snapshot[0].line = 999;
	assert.equal(history.recentOpens()[1].line, 3);
	assert.equal(createOpenHistory().lastOpen(), undefined);
	for (let i = 0; i < 40; i++) history.rememberOpen({ path: String(i), line: 1, cwd: "/repo" });
	assert.equal(history.recentOpens().length, 30);
	history.clear();
	assert.equal(history.lastOpen(), undefined);
});

test("Pi's actual call-before-result composition opens current edit line and read offset", async () => {
	agent.initTheme("dark");
	const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	for (const name of ["edit", "read"]) {
		const opened: any[] = [];
		const tool = wrapWithDiamondRenderer(name === "edit" ? agent.createEditToolDefinition("/repo") : agent.createReadToolDefinition("/repo"), { onModifierOpen: (target) => opened.push(target) });
		const row = new ToolExecutionComponent(name, "id", { path: "a.ts", offset: 23 }, {}, tool, { requestRender() {} }, "/repo");
		row.updateResult({ content: [{ type: "text", text: "contents" }], details: { firstChangedLine: 42 }, isError: false });
		if (name === "read") row.setExpanded(true);
		row.render(80);
		row.callRendererComponent.handleMouse(click);
		row.resultRendererComponent.handleMouse(click);
		assert.deepEqual(opened.map((target) => target.line), name === "edit" ? [42, 42] : [23, 23]);
	}
});

test("launcher rejects synchronous spawn failures and asynchronous error events", async () => {
	const target = { path: "a", line: 1, cwd: "/repo" };
	await assert.rejects(openInCursor(target, () => { throw new Error("sync failure"); }, "/no-mount"), /sync failure/);
	await assert.rejects(openInCursor(target, () => ({ once(event, fn) { if (event === "error") queueMicrotask(() => fn(new Error("ENOENT"))); }, unref() {} }), "/no-mount"), /ENOENT/);
});

test("standalone modifier-open contains launcher rejection", async () => {
	const tool = wrapWithDiamondRenderer(agent.createReadToolDefinition("/repo"));
	tool.renderCall({ path: "a" }, theme, { cwd: "/nonexistent-grok-cursor-test-directory" }).handleMouse?.(click);
	// node:test fails this test if the fire-and-forget rejection is unhandled.
	await new Promise((resolve) => setTimeout(resolve, 100));
});

test("picker retains selected target while newer edits arrive; reads do not replace last edit", async () => {
	const opened: any[] = [];
	let readOpened!: () => void;
	const readComplete = new Promise<void>(resolve => { readOpened = resolve; });
	const h = harness(async (target) => { opened.push(target); if (target.path === "read-only") readOpened(); });
	h.handlers.session_start({}, h.ctx);
	h.edit("a", 3);
	h.ctx.ui.select = async (_title, labels) => { h.edit("b", 7); return labels[0]; };
	await h.commands.open.handler("pick", h.ctx);
	assert.equal(opened[0].path, "/repo/a");
	h.tools.read.renderCall({ path: "read-only" }, theme, { cwd: "/repo" }).handleMouse(click);
	await readComplete;
	await h.commands.open.handler("", h.ctx);
	assert.equal(opened.at(-1).path, "/repo/b");
	h.edit("failed", 1, true);
	h.edit("read", 1, false, "read");
	await h.commands.open.handler("", h.ctx);
	assert.equal(opened.at(-1).path, "/repo/b");
});

test("cached factory instances reset on every session start and shutdown and isolate instances", async () => {
	const h = harness();
	for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
		h.edit("old");
		h.handlers.session_start({ reason }, h.ctx);
		await h.commands.open.handler("", h.ctx);
		assert.match(h.notifications.at(-1)[0], /No edited files/);
	}
	h.edit("old");
	const other = harness();
	await other.commands.open.handler("", other.ctx);
	assert.match(other.notifications.at(-1)[0], /No edited files/);
	h.handlers.session_shutdown({}, h.ctx);
	await h.commands.open.handler("", h.ctx);
	assert.match(h.notifications.at(-1)[0], /No edited files/);
});

test("session switch cancels an outstanding picker and modifier failures notify", async () => {
	const opened: any[] = [];
	const h = harness(async (target) => { opened.push(target); throw new Error("missing Cursor"); });
	h.handlers.session_start({}, h.ctx);
	h.edit("a");
	h.ctx.ui.select = async (_title, labels) => { h.handlers.session_shutdown({}, h.ctx); h.handlers.session_start({}, h.ctx); return labels[0]; };
	await h.commands.open.handler("pick", h.ctx);
	assert.equal(opened.length, 0);
	const notified = new Promise<void>(resolve => {
		const notify = h.ctx.ui.notify;
		h.ctx.ui.notify = (...args: any[]) => {
			notify(...args);
			if (args[1] === "error") resolve();
		};
	});
	h.tools.read.renderCall({ path: "a" }, theme, { cwd: "/repo" }).handleMouse(click);
	await notified;
	assert.deepEqual(h.notifications.at(-1), ["Failed to open Cursor: missing Cursor", "error"]);
});

test("registered file links, Ctrl-click and /open share one refresh per session workspace", async () => {
	const order: string[] = [];
	let opened!: () => void;
	const firstOpen = new Promise<void>(resolve => { opened = resolve; });
	const h = harness(async () => { order.push("open"); opened(); }, async (workspace: string) => {
		assert.equal(workspace, "/repo");
		order.push("refresh");
		return { status: "refreshed" };
	});
	Object.assign(h.ctx, { isProjectTrusted: () => true });
	h.handlers.session_start({}, h.ctx);
	h.tools.read.renderCall({ path: "main.cpp" }, theme, { cwd: "/repo" }).handleMouse(click);
	await firstOpen;
	assert.deepEqual(order, ["refresh", "open"]);
	const markdown = h.markdown("See `src/main.cpp:42:3`.");
	const url = /\(<([^>]+)>\)/.exec(markdown ?? "")?.[1];
	assert.ok(url, markdown);
	await h.openLink(url);
	assert.deepEqual(order, ["refresh", "open", "open"]);
	h.edit("main.cpp");
	await h.commands.open.handler("", h.ctx);
	assert.deepEqual(order, ["refresh", "open", "open", "open"]);
	h.handlers.session_shutdown({}, h.ctx);
	h.handlers.session_start({}, h.ctx);
	h.edit("main.cpp");
	await h.commands.open.handler("", h.ctx);
	assert.deepEqual(order, ["refresh", "open", "open", "open", "refresh", "open"]);
});

test("file links preserve line and column, leave web links alone and do not replace edited history", async () => {
	const opened: any[] = [];
	const h = harness(async target => { opened.push(target); });
	h.handlers.session_start({}, h.ctx);
	h.edit("edited.ts", 7);
	assert.equal(h.markdown("[web](https://example.com)"), "[web](https://example.com)");
	await h.openLink(h.urlFor("src/my-file.ts:42:3"));
	assert.deepEqual(opened, [{ path: "/repo/src/my-file.ts", line: 42, column: 3, cwd: "/repo" }]);
	await h.commands.open.handler("", h.ctx);
	assert.equal(opened.at(-1).path, "/repo/edited.ts");
});

test("session replacement cancels a pending file-link open without launching the old target", async () => {
	const opened: any[] = [];
	let started!: () => void, release!: () => void;
	const refreshing = new Promise<void>(resolve => { started = resolve; });
	const pending = new Promise<void>(resolve => { release = resolve; });
	const h = harness(async target => { opened.push(target); }, async () => {
		started();
		await pending;
		return { status: "refreshed" };
	});
	Object.assign(h.ctx, { isProjectTrusted: () => true });
	h.handlers.session_start({}, h.ctx);
	const opening = assert.rejects(h.openLink(h.urlFor("src/a.ts:1:1")), /expired|could not/);
	await refreshing;
	h.handlers.session_shutdown({}, h.ctx);
	h.handlers.session_start({}, h.ctx);
	release();
	await opening;
	assert.deepEqual(opened, []);
	assert.deepEqual(h.notifications, []);
});

test("file link launch failures notify and remain handled without a system fallback", async () => {
	const h = harness(async () => { throw new Error("missing Cursor"); });
	h.handlers.session_start({}, h.ctx);
	await assert.rejects(h.openLink(h.urlFor("src/a.ts:1:1")), /could not/);
	assert.deepEqual(h.notifications.at(-1), ["Failed to open Cursor: missing Cursor", "error"]);
});
