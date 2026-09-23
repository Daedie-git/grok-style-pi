import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { createShowVideoTool } from "../src/tools/show-video.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createPngStream, playVideoFrames } from "../src/tools/video-frames.ts";

const theme = { fg: (_token: string, text: string) => text };
const click = { type: "click", button: "left", x: 0, y: 0 } as const;

test("PNG frame parser handles split and joined ffmpeg chunks", () => {
	const frame = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
	const found: string[] = [];
	const accept = createPngStream(data => found.push(data));
	const both = Buffer.concat([frame, frame]);
	for (let offset = 0; offset < both.length; offset += 7) accept(both.subarray(offset, offset + 7));
	assert.deepEqual(found, [frame.toString("base64"), frame.toString("base64")]);
});

test("video diamond plays real frames, closes its process, and keeps media out of model content", { skip: spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-video-test-"));
	const file = join(dir, "clip.mp4");
	const video = createShowVideoTool(dir);
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, images: "kitty" });
	try {
		const generated = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=8", "-t", "1", "-pix_fmt", "yuv420p", "-y", file], { timeout: 10_000 });
		assert.equal(generated.status, 0, generated.stderr?.toString());
		const result = await video.execute("call", { path: file }, undefined, undefined, { cwd: dir });
		assert.deepEqual(result.details, { path: file });
		assert.equal(result.content[0].type, "text");
		let resolveFrames!: () => void;
		const frames = new Promise<void>(resolve => { resolveFrames = resolve; });
		const seen = new Set<string>();
		const state: { grokVideo?: { open: boolean; frame?: string; stop?: () => void } } = {};
		const context = { state, showImages: true, invalidate: () => {
			if (state.grokVideo?.frame) seen.add(state.grokVideo.frame);
			if (seen.size >= 2) resolveFrames();
		} };
		const header = video.renderCall({ path: file }, theme, context);
		const component = video.renderResult(result, { expanded: false }, theme, context);
		assert.match(component.render(80).join(""), /Loading video/);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([frames, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("ffmpeg did not deliver animated frames")), 5000); })]); }
		finally { if (timer) clearTimeout(timer); }
		assert.equal(seen.size, 2);
		assert.ok(state.grokVideo?.frame?.startsWith("iVBORw0"));
		assert.ok(component.render(80).length > 1, "video frames render as terminal images");
		setCapabilities({ ...capabilities, images: null });
		assert.match(component.render(80).join(""), /playback unavailable/);
		assert.equal(state.grokVideo?.stop, undefined, "losing graphics capability stops decoding");
		setCapabilities({ ...capabilities, images: "kitty" });
		video.renderResult(result, { expanded: false }, theme, context).render(80);
		const disabled = video.renderResult(result, { expanded: false }, theme, { ...context, showImages: false });
		assert.equal(state.grokVideo?.stop, undefined, "disabling images must stop the decoder");
		assert.match(disabled.render(80).join(""), /playback unavailable/);
		assert.ok(!disabled.render(80).join("").includes("\x1b_G"), "disabled images must hide the old frame");
		video.renderResult(result, { expanded: false }, theme, context).render(80);
		assert.deepEqual(header.handleMouse(click), { handled: true });
		assert.equal(state.grokVideo?.open, false);
		assert.equal(state.grokVideo?.stop, undefined);
		assert.deepEqual(component.render(80), []);
		assert.deepEqual(header.handleMouse(click), { handled: true });
		component.render(80);
		assert.equal(typeof state.grokVideo?.stop, "function");
		const next = { state: {} as typeof state, showImages: true, invalidate() {} };
		video.renderResult(result, { expanded: false }, theme, next).render(80);
		assert.equal(state.grokVideo?.stop, undefined, "a newer video stops the previous decoder");
		assert.equal(state.grokVideo?.open, false);
		assert.equal(typeof next.state.grokVideo?.stop, "function");
		video.dispose();
		assert.equal(next.state.grokVideo?.stop, undefined, "session shutdown stops playback");
		const times: number[] = [];
		const start = performance.now();
		const stop = playVideoFrames(file, () => times.push(performance.now() - start), error => assert.fail(error));
		try { await new Promise(resolve => setTimeout(resolve, 2600)); }
		finally { stop(); }
		assert.ok(times.length >= 25, `expected animated frames over multiple loops, got ${times.length}`);
		assert.ok(times.slice(1).every((time, index) => time - times[index] < 400), "looping playback must not stall on a frame");
	} finally { video.dispose(); setCapabilities(capabilities); rmSync(dir, { recursive: true, force: true }); }
});

test("restored transcript renderers stay owned through startup and cannot restart after shutdown", { skip: spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-video-lifetime-"));
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const previous = getCapabilities();
	let restored: ReturnType<typeof createShowVideoTool> | undefined;
	setCapabilities({ ...previous, images: "kitty" });
	try {
		const file = join(dir, "clip.mp4");
		assert.equal(spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=8", "-t", "1", "-pix_fmt", "yuv420p", "-y", file], { timeout: 10_000 }).status, 0);
		createGrokStyleExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool(tool) { tools.set(tool.name, tool); } }, {
			CustomEditor,
			tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map(name => [name, () => ({ name, description: name, parameters: {}, execute() {} })])) as any,
		});
		restored = tools.get("show_video");
		handlers.get("session_start")!({}, { cwd: dir, hasUI: false, mode: "print", ui: {} });
		assert.strictEqual(tools.get("show_video"), restored, "startup must not orphan restored rows");
		const state: { grokVideo?: { stop?: () => void } } = {};
		const result = restored.renderResult({ content: [{ type: "text", text: "Video preview" }], details: { path: file } }, { expanded: false }, theme,
			{ state, showImages: true, invalidate() {} });
		result.render(80);
		assert.equal(typeof state.grokVideo?.stop, "function");
		handlers.get("session_tree")!({ type: "session_tree", oldLeafId: "old", newLeafId: "new" });
		assert.equal(state.grokVideo?.stop, undefined, "navigating away stops the removed row");
		assert.deepEqual(result.render(80), [], "the removed row must not restart playback");
		const nextState: typeof state = {};
		const nextResult = restored.renderResult({ content: [{ type: "text", text: "Video preview" }], details: { path: file } }, { expanded: false }, theme,
			{ state: nextState, showImages: true, invalidate() {} });
		nextResult.render(80);
		assert.equal(typeof nextState.grokVideo?.stop, "function");
		handlers.get("session_compact")!({ type: "session_compact" });
		assert.equal(nextState.grokVideo?.stop, undefined, "compaction stops the removed row");
		assert.deepEqual(nextResult.render(80), [], "the compacted row must not restart playback");
		const finalState: typeof state = {};
		const finalResult = restored.renderResult({ content: [{ type: "text", text: "Video preview" }], details: { path: file } }, { expanded: false }, theme,
			{ state: finalState, showImages: true, invalidate() {} });
		finalResult.render(80);
		assert.equal(typeof finalState.grokVideo?.stop, "function");
		handlers.get("session_shutdown")!();
		assert.equal(finalState.grokVideo?.stop, undefined);
		finalResult.render(80);
		assert.equal(finalState.grokVideo?.stop, undefined, "stale rows cannot restart playback after shutdown");
	} finally { handlers.get("session_shutdown")?.(); restored?.dispose(); setCapabilities(previous); rmSync(dir, { recursive: true, force: true }); }
});

test("failed video result sanitizes filename control sequences", async () => {
	const video = createShowVideoTool(process.cwd());
	const path = "missing\x1b]52;c;attack\x07.mp4";
	let failure = "";
	try { await video.execute("call", { path }, undefined, undefined, { cwd: process.cwd() }); }
	catch (error) { failure = String(error); }
	assert.ok(failure.includes("\x1b"));
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, images: null });
	try {
		const rendered = video.renderResult({ content: [{ type: "text", text: failure }] }, { expanded: false }, theme, { isError: true }).render(80).join("");
		assert.match(rendered, /ENOENT/, "the filesystem error must remain visible without terminal graphics");
		assert.ok(!rendered.includes("\x1b]52") && !rendered.includes("attack"), "untrusted error controls must not survive rendering");
		const malformed = video.renderResult({ content: [{ type: "text", text: 42 }] } as any, { expanded: false }, theme, { isError: true }).render(80).join("");
		assert.match(malformed, /error/);
	} finally { setCapabilities(capabilities); }
});
