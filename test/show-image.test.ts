import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createShowImageTool } from "../src/tools/show-image.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=";
const GIF = "R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==";
const theme = { fg: (_token: string, text: string) => text };
const click = { type: "click", button: "left", x: 0, y: 0 } as const;

test("show_image embeds a local screenshot in its open diamond and closes on click", async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-show-image-"));
	try {
		writeFileSync(join(dir, "screen.png"), Buffer.from(PNG, "base64"));
		const tool = createShowImageTool(dir);
		const result = await tool.execute("call", { path: "screen.png" }, undefined, undefined, { cwd: dir });
		assert.deepEqual(result.content, [{ type: "text", text: `Displayed image: ${join(dir, "screen.png")}` }]);
		assert.equal(result.details.mimeType, "image/png");
		assert.equal(result.details.data, PNG);
		let invalidations = 0;
		const context = { state: {} as { grokImage?: { open: boolean; expanded: boolean } }, invalidate: () => { invalidations++; }, showImages: false };
		const header = tool.renderCall({ path: "screen.png" }, theme, context);
		assert.deepEqual(header.render(80), ["◆ Show image screen.png"]);
		const render = () => tool.renderResult(result, { expanded: false }, theme, context).render(80);
		assert.ok(render().length > 0, "result is open even when Pi's global tools are collapsed");
		assert.deepEqual(header.handleMouse(click), { handled: true });
		assert.deepEqual(render(), []);
		assert.deepEqual(header.handleMouse(click), { handled: true });
		assert.ok(render().length > 0);
		assert.equal(invalidations, 2);
		tool.renderResult(result, { expanded: true }, theme, context);
		assert.equal(context.state.grokImage?.open, true);
		tool.renderResult(result, { expanded: false }, theme, context);
		assert.equal(context.state.grokImage?.open, false);
		writeFileSync(join(dir, "screen.gif"), Buffer.from(GIF, "base64"));
		const converted = await tool.execute("call", { path: "screen.gif" }, undefined, undefined, { cwd: dir });
		assert.equal(converted.details.mimeType, "image/png", "Kitty image data must be PNG");
		assert.ok(Buffer.from(converted.details.data, "base64").subarray(0, 8).equals(Buffer.from(PNG, "base64").subarray(0, 8)));
		await assert.rejects(tool.execute("call", { path: "missing.png" }, undefined, undefined, { cwd: dir }));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
