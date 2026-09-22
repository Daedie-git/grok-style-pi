import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFeatures, loadFeatures, saveFeatures, installFeatureSettings } from "../src/features.ts";
import { defaultStyleColors, loadStyleColors } from "../src/style-colors.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools.ts";

function settingsFile(t: any) {
	const dir = mkdtempSync(join(tmpdir(), "grok-features-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "grok-style.json");
}

test("feature preferences default on, persist and reject malformed values", (t) => {
	const path = settingsFile(t);
	assert.deepEqual(loadFeatures(path), defaultFeatures);
	saveFeatures({ ...defaultFeatures, activity: false, footer: false }, path);
	assert.equal(loadFeatures(path).activity, false);
	assert.equal(loadFeatures(path).composer, true);
	writeFileSync(path, '{"composer":false}');
	assert.deepEqual(loadFeatures(path), { ...defaultFeatures, composer: false });
	writeFileSync(path, '{"activity":"false"}');
	assert.throws(() => loadFeatures(path), /must be true or false/);
	writeFileSync(path, '{"footer":true,"colors":{"diffInsert":"#112233"}}');
	saveFeatures({ ...defaultFeatures, composer: false }, path);
	assert.equal(loadStyleColors(path).diffInsert, "#112233");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).composer, false);
	writeFileSync(path, '{"colors":{"comment":"blue"}}');
	assert.throws(() => loadStyleColors(path), /#rrggbb/);
});

test("settings command supports menu toggles, all-off, validation and cancellation", async (t) => {
	const path = settingsFile(t);
	let command: any;
	const notices: string[] = [];
	installFeatureSettings({ registerCommand(name, config) { assert.equal(name, "grok-style"); command = config; } } as any, path);
	let selected = 0;
	const ctx = { ui: { select: async (_title: string, labels: string[]) => labels[selected], notify: (message: string) => notices.push(message) } };
	await command.handler("", ctx);
	assert.equal(loadFeatures(path).footer, false);
	await command.handler("all off", ctx);
	assert.ok(Object.values(loadFeatures(path)).every((value) => value === false));
	await command.handler("activity on", ctx);
	assert.equal(loadFeatures(path).activity, true);
	assert.equal(loadFeatures(path).toolStyling, false);
	await command.handler("activity maybe", ctx);
	assert.match(notices.at(-1)!, /Usage/);
	const before = loadFeatures(path);
	selected = -1;
	await command.handler("", ctx);
	assert.deepEqual(loadFeatures(path), before);
	assert.ok(notices.some((message) => message.includes("/reload")));
	await command.handler("color comment #a0a8b8", ctx);
	assert.equal(loadStyleColors(path).comment, "#a0a8b8");
	assert.equal(loadFeatures(path).activity, true);
	await command.handler("color comment reset", ctx);
	assert.deepEqual(loadStyleColors(path), defaultStyleColors);
	await command.handler("color comment blue", ctx);
	assert.match(notices.at(-1)!, /Usage/);
});

class Editor {
	focused = false;
	borderColor = (text: string) => text;
	render() { return ["native editor"]; }
}

function setup(features: any) {
	const handlers = new Map<string, Function>();
	const tools: any[] = [];
	let footer: any, editor: any;
	const writes: string[] = [];
	createGrokStyleExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool(tool) { const index = tools.findIndex((entry) => entry.name === tool.name); if (index >= 0) tools[index] = tool; else tools.push(tool); } }, {
		features, CustomEditor: Editor,
		tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map((name) => [name, () => ({ name, description: name, parameters: {}, execute() {}, renderCall: "native" })])) as any,
	});
	handlers.get("session_start")!({}, { cwd: "/tmp", hasUI: true, ui: {
		setFooter(factory: any) { footer = factory; }, setEditorComponent(factory: any) { editor = factory({ terminal: { write(text: string) { writes.push(text); } } }, {}, {}); },
	} });
	return { tools, footer, editor, writes, shutdown: () => handlers.get("session_shutdown")!() };
}

test("all-disabled restores native tools and leaves footer/editor alone", () => {
	const h = setup(Object.fromEntries(Object.keys(defaultFeatures).map((key) => [key, false])));
	assert.equal(h.footer, undefined);
	assert.equal(h.editor, undefined);
	assert.ok(h.tools.every((tool) => tool.renderCall === "native"));
	assert.deepEqual(h.writes, []);
	h.shutdown();
});

test("terminal colors work independently of composer styling", () => {
	const h = setup({ composer: false, footer: false, terminalColors: true });
	assert.deepEqual(h.editor.render(80), ["native editor"]);
	assert.equal(h.writes.length, 1);
	h.shutdown();
	assert.equal(h.writes.length, 2);
	const noColors = setup({ terminalColors: false });
	assert.equal(typeof noColors.footer, "function");
	assert.ok(noColors.editor);
	assert.deepEqual(noColors.writes, []);
	noColors.shutdown();
});
