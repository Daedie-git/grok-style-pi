import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import media, { createMediaExtension } from "../integrations/media.ts";
import { dispatchFileLink } from "../src/navigation/file-link-bridge.ts";
import type { OpenTarget } from "../src/navigation/open-in-cursor.ts";
import { assertDiamondGestures } from "./fixtures/diamond-gestures.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=";
const theme = { fg: (_token: string, text: string) => text };
const ctrl = { type: "click", button: "left", ctrl: true, x: 0, y: 0 } as const;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness() {
	const handlers = new Map<string, Function[]>();
	const tools = new Map<string, any>();
	let transformer: Function | undefined;
	const forbidden = () => { throw new Error("Media must not install unrelated UI or commands"); };
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerMarkdownTransformer(handler: Function) { transformer = handler; },
		registerCommand: forbidden, registerShortcut: forbidden,
	};
	const notifications: unknown[][] = [];
	const ctx = {
		cwd: "/repo", mode: "print", hasUI: false,
		ui: { notify: (...args: unknown[]) => notifications.push(args), setFooter: forbidden, setEditorComponent: forbidden, setWidget: forbidden },
	};
	return {
		pi, tools, handlers, ctx, notifications,
		emit(name: string, context = ctx) { for (const handler of handlers.get(name) ?? []) handler({}, context); },
		markdown(text: string, messageType = "assistant") {
			return transformer?.(text, { messageType, isStreaming: false, availableWidth: 80 });
		},
	};
}

test("Pi's real resource loader loads the media entrypoint without overriding built-ins", async () => {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const dir = mkdtempSync(join(tmpdir(), "pi-media-loader-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
		const loader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager,
			additionalExtensionPaths: [fileURLToPath(new URL("../integrations/media.ts", import.meta.url))],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const result = await createAgentSession({
			cwd: dir, agentDir: dir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir),
		});
		session = result.session;
		assert.deepEqual(result.extensionsResult.errors, []);
		await session.bindExtensions({ mode: "json" });
		for (const name of ["show_image", "show_html", "show_video"]) {
			assert.equal(session.getToolDefinition(name)?.renderShell, "self");
			assert.ok(session.getActiveToolNames().includes(name));
		}
		assert.notEqual(session.getToolDefinition("read")?.renderShell, "self");
		writeFileSync(join(dir, "screen.png"), Buffer.from(PNG, "base64"));
		const image = await session.getToolDefinition("show_image")!.execute("image", { path: "screen.png" }, undefined, undefined, { cwd: dir } as any);
		assert.equal((image.details as any).data, PNG);
		assert.deepEqual(image.content, [{ type: "text", text: `Displayed image: ${join(dir, "screen.png")}` }]);
	} finally {
		if (session) {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("standalone entrypoint installs only media, independently of Grok settings and chrome", () => {
	const h = harness();
	media(h.pi as any);
	try {
		assert.deepEqual([...h.tools.keys()], ["show_image", "show_html", "show_video"]);
		assert.equal(h.handlers.has("before_agent_start"), false, "no communication-style prompt replacement");
		assert.equal(h.handlers.has("tool_result"), false, "no edited-file history");
		h.emit("session_start");
		for (const tool of h.tools.values()) {
			assert.equal(tool.renderShell, "self");
			assert.equal(typeof tool.renderCall, "function");
			assert.equal(typeof tool.renderResult, "function");
			assert.match(tool.promptGuidelines.join(" "), /inline-code/);
		}
	} finally { h.emit("session_shutdown"); }
});

test("standalone media retain diamond gestures and global expansion", () => {
	const h = harness();
	const opened: OpenTarget[] = [];
	createMediaExtension(h.pi as any, { openMedia: async target => { opened.push(target); }, hyperlinks: () => false });
	h.emit("session_start");
	try {
		for (const name of ["show_image", "show_html", "show_video"]) {
			const tool = h.tools.get(name);
			const path = name === "show_image" ? "/repo/screen.png" : name === "show_html" ? "/repo/page.html" : "/repo/clip.mp4";
			const context = { state: {} as any, expanded: false, showImages: false, invalidate() {} };
			const header = tool.renderCall({ path }, theme, context);
			const result = { content: [{ type: "text", text: "shown" }], details: { path } };
			const body = tool.renderResult(result, { expanded: false }, theme, context);
			const state = () => context.state.grokImage ?? context.state.grokVideo;
			assertDiamondGestures(name, {
				header: event => header.handleMouse(event), body: event => body.handleMouse(event),
				isOpen: () => state().open, opened: () => opened,
			});
			tool.renderResult(result, { expanded: true }, theme, context);
			assert.equal(state().open, true, "Ctrl+O expands");
			tool.renderResult(result, { expanded: false }, theme, context);
			assert.equal(state().open, false, "Ctrl+O collapses");
		}
		assert.deepEqual(opened.map(target => target.path), ["/repo/screen.png", "/repo/screen.png", "/repo/page.html", "/repo/page.html", "/repo/clip.mp4", "/repo/clip.mp4"]);
	} finally { h.emit("session_shutdown"); }
});

test("standalone startup refreshes relative paths without replacing the restored video owner", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-media-extension-"));
	const h = harness();
	const opened: OpenTarget[] = [];
	createMediaExtension(h.pi as any, { openMedia: async target => { opened.push(target); }, hyperlinks: () => false });
	const video = h.tools.get("show_video");
	try {
		writeFileSync(join(dir, "screen.png"), Buffer.from(PNG, "base64"));
		writeFileSync(join(dir, "clip.mp4"), "video execution only validates the path");
		h.ctx.cwd = dir;
		h.emit("session_start");
		assert.strictEqual(h.tools.get("show_video"), video);
		const image = h.tools.get("show_image");
		const result = await image.execute("image", { path: "screen.png" }, undefined, undefined, { cwd: dir });
		assert.equal(result.details.data, PNG, "pixels remain in transcript details");
		assert.deepEqual(result.content, [{ type: "text", text: `Displayed image: ${join(dir, "screen.png")}` }]);
		const clip = await video.execute("video", { path: "clip.mp4" }, undefined, undefined, { cwd: dir });
		assert.deepEqual(clip.details, { path: join(dir, "clip.mp4") }, "no frames are stored");
		image.renderCall({ path: "screen.png" }, theme).handleMouse(ctrl);
		video.renderCall({ path: "clip.mp4" }, theme).handleMouse(ctrl);
		await flush();
		assert.deepEqual(opened.map(target => target.path), [join(dir, "screen.png"), join(dir, "clip.mp4")]);
		h.emit("session_shutdown");
		image.renderCall({ path: "screen.png" }, theme).handleMouse(ctrl);
		await flush();
		assert.equal(opened.length, 2, "stale image rows cannot open after shutdown");
		h.ctx.cwd = "/next";
		h.emit("session_start");
		h.tools.get("show_image").renderCall({ path: "screen.png" }, theme).handleMouse(ctrl);
		await flush();
		assert.equal(opened.at(-1)?.path, "/next/screen.png");
	} finally { h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
});

test("restored HTML and image headers follow the session cwd without replacing their renderer owners", async () => {
	const h = harness();
	const opened: OpenTarget[] = [];
	createMediaExtension(h.pi as any, { openMedia: async target => { opened.push(target); }, hyperlinks: () => false });
	const restored = ["show_html", "show_image"].map(name => {
		const tool = h.tools.get(name);
		const path = name === "show_html" ? "page.html" : "screen.png";
		const context = { state: {}, invalidate() {}, showImages: false };
		return { name, tool, path, header: tool.renderCall({ path }, theme, context), context };
	});
	try {
		h.ctx.cwd = "/restored-project";
		h.emit("session_start");
		for (const { name, tool, path, header, context } of restored) {
			assert.strictEqual(h.tools.get(name), tool, "restored rows retain their renderer owner");
			header.handleMouse(ctrl);
			tool.renderResult({ content: [], details: { path: join(h.ctx.cwd, path) } }, { expanded: false }, theme, context).handleMouse(ctrl);
		}
		await flush();
		assert.deepEqual(opened.map(target => target.path), ["/restored-project/page.html", "/restored-project/page.html", "/restored-project/screen.png", "/restored-project/screen.png"]);
		h.ctx.cwd = "/next-project";
		h.emit("session_start");
		restored[0].header.handleMouse(ctrl);
		await flush();
		assert.equal(opened.at(-1)?.path, "/next-project/page.html");
	} finally { h.emit("session_shutdown"); }
});

test("desktop-opening failures notify only the session that requested them", async () => {
	const h = harness();
	let reject!: (error: Error) => void;
	let pending = false;
	createMediaExtension(h.pi as any, {
		hyperlinks: () => false,
		openMedia: async () => {
			if (pending) await new Promise<void>((_resolve, fail) => { reject = fail; });
			else throw new Error("missing player");
		},
	});
	h.emit("session_start");
	try {
		const open = () => h.tools.get("show_image").renderCall({ path: "screen.png" }, theme).handleMouse(ctrl);
		open();
		await flush();
		assert.deepEqual(h.notifications, [["Failed to open media: missing player", "error"]]);
		pending = true;
		open();
		h.emit("session_start");
		reject(new Error("old failure"));
		await flush();
		assert.equal(h.notifications.length, 1);
	} finally { h.emit("session_shutdown"); }
});

test("standalone media references use the owning session and leave code and web links alone", { skip: process.platform !== "linux" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-media-links-"));
	const h = harness();
	const opened: OpenTarget[] = [];
	createMediaExtension(h.pi as any, { openMedia: async target => { opened.push(target); }, hyperlinks: () => true });
	try {
		writeFileSync(join(dir, "screen.png"), Buffer.from(PNG, "base64"));
		writeFileSync(join(dir, "clip.mp4"), "video");
		const restoredUrl = /\(<([^>]+)>\)/.exec(h.markdown(`\`${join(dir, "screen.png")}\``))![1];
		h.ctx.cwd = dir;
		h.ctx.mode = "tui";
		h.emit("session_start");
		await dispatchFileLink(restoredUrl);
		assert.equal(opened[0].path, join(dir, "screen.png"), "links restored before startup remain valid");
		opened.length = 0;
		const markdown = "See `screen.png` and `clip.mp4`. Code `src/a.ts` and [web](https://example.com) stay unchanged.";
		const linked = h.markdown(markdown);
		const urls = [...linked.matchAll(/\(<(grok-pi-file:[^>]+)>\)/g)].map(match => match[1]);
		assert.equal(urls.length, 2);
		assert.match(linked, /Code `src\/a\.ts` and \[web\]\(https:\/\/example.com\) stay unchanged\./);
		assert.equal(h.markdown(markdown, "assistant-thinking"), markdown);
		assert.equal(h.markdown("```\n`screen.png`\n```"), "```\n`screen.png`\n```");
		assert.equal(h.markdown(linked), linked, "already-linked paths remain stable");
		for (const url of urls) await dispatchFileLink(url);
		assert.deepEqual(opened.map(target => target.path), [join(dir, "screen.png"), join(dir, "clip.mp4")]);
		h.emit("session_start");
		await assert.rejects(dispatchFileLink(urls[0]), /expired/);
		const renewed = /\(<([^>]+)>\)/.exec(h.markdown("`screen.png`"))![1];
		await dispatchFileLink(renewed);
		h.emit("session_shutdown");
		await assert.rejects(dispatchFileLink(renewed), /expired/);
		const nextRestored = /\(<([^>]+)>\)/.exec(h.markdown("`screen.png`"))![1];
		h.emit("session_start");
		await dispatchFileLink(nextRestored);
		assert.equal(opened.at(-1)?.path, join(dir, "screen.png"), "replacement-session restoration survives startup");
	} finally { h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
});
