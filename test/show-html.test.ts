import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createShowHtmlTool } from "../src/tools/show-html.ts";
import { captureHtmlPreview } from "../src/media/html-preview.ts";
import { isMediaPath } from "../src/navigation/open-media.ts";
import type { OpenTarget } from "../src/navigation/open-in-cursor.ts";
import { assertDiamondGestures } from "./fixtures/diamond-gestures.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=";
const theme = { fg: (_token: string, text: string) => text };

test("real Chromium captures a local page as PNG", { skip: process.env.GROK_HTML_INTEGRATION !== "1" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-html-browser-"));
	try {
		const path = join(dir, "page with spaces.html");
		writeFileSync(path, "<html><body><h1>HTML preview</h1></body></html>");
		const data = Buffer.from(await captureHtmlPreview(path), "base64");
		assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
		assert.ok(data.length > 100);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("show_html stores a static preview, keeps model output text-only, and opens the original page", async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-show-html-"));
	try {
		const path = join(dir, "page.html");
		writeFileSync(path, "<h1>Hello</h1>");
		const opened: OpenTarget[] = [];
		const controller = new AbortController();
		const tool = createShowHtmlTool(dir, { onModifierOpen: target => { opened.push(target); } }, async (file, signal) => {
			assert.equal(file, path);
			assert.equal(signal, controller.signal);
			return PNG;
		});
		const result = await tool.execute("call", { path: "page.html" }, controller.signal, undefined, { cwd: dir });
		assert.deepEqual(result.content, [{ type: "text", text: `Displayed HTML: ${path}` }]);
		assert.deepEqual(result.details, { path, data: PNG, mimeType: "image/png" });
		const context = { state: {} as { grokImage?: { open: boolean; expanded: boolean } }, invalidate() {}, showImages: false };
		const header = tool.renderCall({ path: "page.html" }, theme, context);
		const body = tool.renderResult(result, { expanded: false }, theme, context);
		assert.deepEqual(header.render(80), ["◆ Show HTML page.html"]);
		assert.ok(body.render(80).length);
		assertDiamondGestures("show_html", {
			header: event => header.handleMouse(event), body: event => body.handleMouse(event),
			isOpen: () => context.state.grokImage!.open, opened: () => opened,
		});
		assert.ok(opened.every(target => target.path === path));
		assert.deepEqual(body.render(80), []);
		tool.renderResult(result, { expanded: true }, theme, context);
		assert.equal(context.state.grokImage!.open, true);
		tool.renderResult(result, { expanded: false }, theme, context);
		assert.equal(context.state.grokImage!.open, false);
		for (const file of ["page.html", "PAGE.HTM"]) assert.equal(isMediaPath(file), true);
		await assert.rejects(tool.execute("call", { path: "page.txt" }, undefined, undefined, { cwd: dir }), /supports HTML/);
		await assert.rejects(tool.execute("call", { path: "missing.html" }, undefined, undefined, { cwd: dir }));
		mkdirSync(join(dir, "folder.html"));
		await assert.rejects(tool.execute("call", { path: "folder.html" }, undefined, undefined, { cwd: dir }), /must be a file/);
		writeFileSync(path, Buffer.alloc(10 * 1024 * 1024 + 1));
		await assert.rejects(tool.execute("call", { path }, undefined, undefined, { cwd: dir }), /at most 10 MB/);
		writeFileSync(path, "<h1>Hello</h1>");
		controller.abort();
		await assert.rejects(tool.execute("call", { path }, controller.signal, undefined, { cwd: dir }), /abort/i);
		const failing = createShowHtmlTool(dir, {}, async () => { throw new Error("browser failed"); });
		await assert.rejects(failing.execute("call", { path }, undefined, undefined, { cwd: dir }), /browser failed/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
