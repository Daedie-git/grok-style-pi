import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { classifyClick, handleDiamondClick } from "../src/tools/interaction.ts";
import { wrapWithDiamondRenderer } from "../src/tools/renderer.ts";
import { createShowImageTool } from "../src/tools/show-image.ts";
import { createHerdrNotificationRenderer } from "../src/subagents/notification-style.ts";
import { assertDiamondGestures } from "./fixtures/diamond-gestures.ts";
import { createShowVideoTool } from "../src/tools/show-video.ts";
import type { OpenTarget } from "../src/navigation/open-in-cursor.ts";

const theme = { fg: (_token: string, value: string) => value } as any;
const ev = (extra: Record<string, unknown> = {}) => ({ type: "click", button: "left", x: 4, y: 0, width: 40, ...extra }) as any;
const plain = (component: any) => stripTerminalSequences(component.render(40).join("\n"));
const original = (name: string) => ({ name, description: "", parameters: {}, execute: async () => ({ content: [] }) }) as any;

test("gesture table: headers toggle, bodies close only on Alt, Ctrl opens the target", () => {
	const open = { open: true };
	assert.equal(classifyClick(ev(), "header", open), "toggle");
	assert.equal(classifyClick(ev({ alt: true }), "header", open), "toggle");
	assert.equal(classifyClick(ev(), "header", { open: true, closeNeedsAlt: true }), "inert");
	assert.equal(classifyClick(ev(), "header", { open: false, closeNeedsAlt: true }), "toggle");
	assert.equal(classifyClick(ev({ alt: true }), "header", { open: true, closeNeedsAlt: true }), "toggle");
	assert.equal(classifyClick(ev(), "body", open), "inert");
	assert.equal(classifyClick(ev({ alt: true }), "body", open), "close");
	for (const surface of ["header", "body"] as const) {
		assert.equal(classifyClick(ev({ ctrl: true }), surface, open), "open-target");
		assert.equal(classifyClick(ev({ button: "right" }), surface, open), "none");
		assert.equal(classifyClick(ev({ type: "press" }), surface, open), "none");
	}
});

test("a close never reopens, and Ctrl-click without a target is consumed without opening", () => {
	const display = { open: false };
	assert.deepEqual(handleDiamondClick(ev({ alt: true }), "body", { display }), { handled: true });
	assert.equal(display.open, false);
	// Pi toggles anything left unhandled, so Ctrl-click must be consumed even with no target.
	assert.deepEqual(handleDiamondClick(ev({ ctrl: true }), "header", { display }), { handled: true });
	assert.equal(display.open, false);
	assert.equal(handleDiamondClick(ev({ type: "press" }), "header", { display }), undefined);
});

test("tool headers and bodies follow one gesture table", () => {
	for (const name of ["bash", "read", "grep", "edit", "write", "ls", "find"]) {
		const opened: OpenTarget[] = [];
		const tool = wrapWithDiamondRenderer(original(name), { onModifierOpen: (target) => opened.push(target) });
		const args = name === "bash" ? { command: "ls" } : { path: "src/a.ts" };
		const context = { args, state: {} as any, expanded: true, cwd: "/repo", invalidate() {} };
		const header = tool.renderCall(args, theme, context) as any;
		const result = { content: [{ type: "text", text: "one\ntwo" }] };
		const body = () => tool.renderResult(result, { expanded: true }, theme, context) as any;
		assertDiamondGestures(name, {
			header: (event) => header.handleMouse(event), body: (event) => body().handleMouse(event),
			isOpen: () => /one/.test(plain(body())),
			closeNeedsAlt: name === "edit",
			opened: name === "bash" ? undefined : () => opened,
		});
	}
});

test("Ctrl-click on a read body opens the clicked source line", () => {
	const opened: OpenTarget[] = [];
	const read = wrapWithDiamondRenderer(original("read"), { onModifierOpen: (target) => opened.push(target), onCodeLocation() {} });
	const context = { args: { path: "src/a.ts", offset: 10 }, state: {}, expanded: true, cwd: "/repo", invalidate() {} };
	const body = read.renderResult({ content: [{ type: "text", text: "first\nsecond" }] }, { expanded: true }, theme, context) as any;
	body.render(40);
	assert.deepEqual(body.handleMouse(ev({ y: 1, ctrl: true })), { handled: true });
	assert.deepEqual(opened, [{ path: "src/a.ts", line: 11, cwd: "/repo" }]);
	assert.equal(context.state && (context.state as any).grokTool.open, true);
});

test("Ctrl-click on a grep body opens its path argument", () => {
	const opened: OpenTarget[] = [];
	const grep = wrapWithDiamondRenderer(original("grep"), { onModifierOpen: (target) => opened.push(target) });
	const args = { pattern: "x", path: "src" };
	const context = { args, state: {}, expanded: true, cwd: "/repo", invalidate() {} };
	const body = grep.renderResult({ content: [{ type: "text", text: "src/a.ts:1:x" }] }, { expanded: true }, theme, context) as any;
	assert.deepEqual(body.handleMouse(ev({ y: 0, ctrl: true })), { handled: true });
	assert.deepEqual(opened, [{ path: "src", line: 1, cwd: "/repo" }]);
});

test("show_image, show_video and Herdr notices follow the same gesture table", () => {
	for (const make of [
		(hooks: any) => ({ tool: createShowImageTool("/repo", hooks), file: "/repo/a.png", details: { data: "", mimeType: "image/png", path: "/repo/a.png" } }),
		(hooks: any) => ({ tool: createShowVideoTool("/repo", hooks), file: "/repo/a.mp4", details: { path: "/repo/a.mp4" } }),
	]) {
		const opened: OpenTarget[] = [];
		const { tool, file, details } = make({ onModifierOpen: (target: OpenTarget) => opened.push(target) }) as any;
		const context = { state: {} as any, expanded: true, showImages: false, invalidate() {} };
		const header = tool.renderCall({ path: file }, theme, context);
		const body = tool.renderResult({ content: [{ type: "text", text: "shown" }], details }, { expanded: true }, theme, context);
		const state = () => context.state.grokImage ?? context.state.grokVideo;
		assertDiamondGestures(tool.name, {
			header: (event) => header.handleMouse(event), body: (event) => body.handleMouse(event),
			isOpen: () => state().open, opened: () => opened,
		});
		tool.dispose?.();
	}
	const renderer = createHerdrNotificationRenderer();
	const message = { customType: "n", content: "Done\nbody", display: true } as any;
	const notice = renderer(message, { expanded: true } as any, theme)!;
	assertDiamondGestures("notice", {
		header: (event) => notice.handleMouse?.(event), body: (event) => notice.handleMouse?.({ ...event, y: 1 }),
		isOpen: () => notice.render(40).length > 1,
	});
});

test("show_image headers toggle before the result arrives", () => {
	const tool = createShowImageTool("/repo");
	const context = { state: {} as any, expanded: true, invalidate() {} };
	const header = tool.renderCall({ path: "a.png" }, theme, context) as any;
	assert.deepEqual(header.handleMouse(ev()), { handled: true });
	assert.equal(context.state.grokImage.open, false);
});

test("every module that handles diamond clicks routes them through interaction.ts", () => {
	const root = new URL("../src/", import.meta.url);
	for (const dir of ["tools", "subagents"]) {
		for (const name of readdirSync(new URL(`${dir}/`, root))) {
			if (!name.endsWith(".ts") || name === "interaction.ts") continue;
			const source = readFileSync(new URL(`${dir}/${name}`, root), "utf8");
			if (/handleMouse/.test(source)) assert.match(source, /interaction\.ts/, `${dir}/${name} handles mouse input without the shared gesture table`);
		}
	}
});

test("Ctrl-click on a source row opens its line with only the open hook installed", () => {
	const opened: OpenTarget[] = [];
	const read = wrapWithDiamondRenderer(original("read"), { onModifierOpen: (target) => opened.push(target) });
	const context = { args: { path: "src/a.ts", offset: 10 }, state: {}, expanded: true, cwd: "/repo", invalidate() {} };
	const body = read.renderResult({ content: [{ type: "text", text: "a\nb\nc" }] }, { expanded: true }, theme, context) as any;
	body.render(40);
	body.handleMouse(ev({ y: 2, ctrl: true }));
	assert.equal(opened[0].line, 12);
});

test("a video header without state or invalidate falls back to Pi, but still consumes Ctrl-click", () => {
	const tool = createShowVideoTool("/repo", { onModifierOpen() {} });
	for (const context of [undefined, { state: {} as any }]) {
		const header = tool.renderCall({ path: "/repo/a.mp4" }, theme, context) as any;
		assert.equal(header.handleMouse(ev()), undefined);
		assert.deepEqual(header.handleMouse(ev({ ctrl: true })), { handled: true });
	}
	tool.dispose();
});

test("a click keeps the modifiers held at its press, because Pi builds it from the release", () => {
	const at = { screenX: 7, screenY: 3 };
	const tool = wrapWithDiamondRenderer(original("bash"), {});
	const args = { command: "ls" };
	const context = { args, state: {} as any, expanded: true, invalidate() {} };
	const header = tool.renderCall(args, theme, context) as any;
	const open = () => context.state.grokTool.open;
	assert.equal(open(), true);
	header.handleMouse(ev({ ...at, type: "press", ctrl: true }));
	// Ctrl was released before the button: the click arrives without it, but must not toggle.
	assert.deepEqual(header.handleMouse(ev({ ...at, ctrl: false })), { handled: true });
	assert.equal(open(), true);
	// A press elsewhere does not lend its modifiers to a click.
	header.handleMouse(ev({ ...at, type: "press", ctrl: true }));
	header.handleMouse(ev({ screenX: 9, screenY: 3, ctrl: false }));
	assert.equal(open(), false);
});

test("Ctrl released before the button still opens a read body's clicked line", () => {
	const opened: OpenTarget[] = [];
	const read = wrapWithDiamondRenderer(original("read"), { onModifierOpen: (target) => opened.push(target) });
	const context = { args: { path: "src/a.ts" }, state: {}, expanded: true, cwd: "/repo", invalidate() {} };
	const body = read.renderResult({ content: [{ type: "text", text: "a\nb\nc" }] }, { expanded: true }, theme, context) as any;
	body.render(40);
	const at = { y: 1, screenX: 4, screenY: 9 };
	body.handleMouse(ev({ ...at, type: "press", ctrl: true }));
	body.handleMouse(ev({ ...at, type: "release" }));
	assert.deepEqual(body.handleMouse(ev({ ...at })), { handled: true });
	assert.deepEqual(opened, [{ path: "src/a.ts", line: 2, cwd: "/repo" }]);
});
