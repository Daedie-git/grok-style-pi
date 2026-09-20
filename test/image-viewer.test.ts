import assert from "node:assert/strict";
import test from "node:test";
import { Image, visibleWidth } from "@earendil-works/pi-tui";
import { extractImages } from "../src/diamond.ts";
import { ImageViewer, installImageViewer, bindInlineImages } from "../src/image-viewer.ts";
import { wrapWithDiamondRenderer } from "../src/tools.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const theme = { fg: (_token: string, text: string) => text };
const click = (x: number, y: number) => ({ type: "click", button: "left", x, y } as any);

test("extractImages keeps only image blocks with data and mime type", () => {
	assert.deepEqual(extractImages({ content: [{ type: "text", text: "nope" }] }), []);
	assert.deepEqual(extractImages({
		content: [
			{ type: "image", data: PNG, mimeType: "image/png" },
			{ type: "image", data: "", mimeType: "image/png" },
			{ type: "text", text: "skip" },
		],
	}), [{ data: PNG, mimeType: "image/png" }]);
});

test("image diamond rows omit the View button", () => {
	let viewed = 0;
	const tool = wrapWithDiamondRenderer({
		name: "read", description: "read", parameters: {},
		execute: async () => ({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] }),
	}, () => { viewed++; });
	const themePaint = { fg: (_token: string, text: string) => text };
	const context = { state: {} as Record<string, unknown> };
	const call = tool.renderCall({ path: "shot.png" }, themePaint, context);
	assert.equal(call.render(80)[0], "◆ Read shot.png");
	tool.renderResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] }, { expanded: false }, themePaint, context);
	const row = call.render(80)[0];
	assert.match(row, /◆ Read shot\.png/);
	assert.doesNotMatch(row, /\[View\]/);
	call.handleMouse(click(0, 0));
	assert.equal(viewed, 0);
	const text = wrapWithDiamondRenderer({
		name: "read", description: "read", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "hi" }] }),
	}, () => { viewed++; });
	const textContext = { state: {} };
	text.renderResult({ content: [{ type: "text", text: "hi" }] }, { expanded: false }, themePaint, textContext);
	assert.equal(text.renderCall({ path: "a.ts" }, themePaint, textContext).render(80)[0], "◆ Read a.ts");
});

test("image viewer frames, closes, and cycles without overflowing", () => {
	let closed = 0;
	const viewer = new ImageViewer(
		[{ data: PNG, mimeType: "image/png" }, { data: PNG + "A", mimeType: "image/png" }],
		"shot.png", theme, () => 24, () => {}, () => closed++,
	);
	for (const width of [80, 20, 10, 6, 4]) {
		const lines = viewer.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines[0], /^╭─+╮$/);
		assert.match(lines.at(-1)!, /^╰─+╯$/);
	}
	const short = new ImageViewer([{ data: PNG, mimeType: "image/png" }], "shot.png", theme, () => 13, () => {}, () => {});
	assert.ok(short.render(40).length <= Math.floor(13 * 0.85));
	short.render(40);
	short.invalidate();
	const header = viewer.render(40)[1];
	const label = header.includes("[Close]") ? "[Close]" : header.includes("[x]") ? "[x]" : "×";
	assert.match(header, /1\/2/);
	viewer.handleMouse(click(header.indexOf(label), 1));
	assert.equal(closed, 1);
	viewer.handleInput("\x1b[C");
	assert.match(viewer.render(40)[1], /2\/2/);
	viewer.handleInput("\x1b[D");
	assert.match(viewer.render(40)[1], /1\/2/);
	viewer.handleInput("\x1b");
	assert.equal(closed, 2);
});

test("installImageViewer opens one viewer, converts non-PNG, and reports overlay failures", async () => {
	const handlers = new Map<string, Function[]>();
	let overlay = 0, attempts = 0;
	let done: (() => void) | undefined;
	let converted = 0;
	const notices: string[] = [];
	const pi = { on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); } };
	const viewer = installImageViewer(pi as any, async (_data, mime) => {
		converted++;
		assert.equal(mime, "image/jpeg");
		return { data: PNG, mimeType: "image/png" };
	});
	const ctx = {
		mode: "tui",
		ui: {
			setWidget() {},
			notify(message: string) { notices.push(message); },
			custom(factory: any) {
				overlay++;
				attempts++;
				return new Promise<void>((resolve, reject) => {
					done = () => { overlay--; resolve(); };
					if (attempts === 3) { reject(new Error("boom")); return; }
					factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, done);
				});
			},
		},
	};
	const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	void viewer.view([{ data: "jpeg-bytes", mimeType: "image/jpeg" }], "a.jpg");
	await tick();
	void viewer.view([{ data: PNG, mimeType: "image/png" }], "b.png");
	assert.equal(overlay, 1);
	assert.equal(converted, 1);
	done?.();
	await tick();
	void viewer.view([{ data: PNG, mimeType: "image/png" }], "c.png");
	await tick();
	assert.equal(overlay, 1);
	done?.();
	await tick();
	await viewer.view([{ data: PNG, mimeType: "image/png" }], "fail.png");
	assert.deepEqual(notices, ["boom"]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
});

test("native thumbnail click hides inline graphics and preserves native child identity", () => {
	let hidden = false;
	let viewed: unknown;
	const image = new Image(PNG, "image/png", { fallbackColor: text => text });
	const root = { children: [image], render: () => [], invalidate() {} };
	const originalRender = image.render;
	const binding = bindInlineImages(root, images => { viewed = images; hidden = true; }, () => hidden);
	try {
		assert.equal(binding.scan(), true);
		assert.equal(binding.scan(), false);
		assert.equal(root.children[0], image);
		const original = image.render(40);
		(image as any).handleMouse(click(1, 0));
		assert.deepEqual(viewed, [{ data: PNG, mimeType: "image/png" }]);
		assert.deepEqual(image.render(40), original.map(() => ""));
		hidden = false;
		assert.deepEqual(image.render(40), original);
		root.children.length = 0;
		binding.scan();
		assert.equal(image.render, originalRender);
	} finally { binding.dispose(); }
});
