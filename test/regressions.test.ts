import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as agent from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi, visibleWidth } from "@earendil-works/pi-tui";
import { textComponent } from "../src/diamond.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { loadToolOptions } from "../src/tool-settings.ts";
import { wrapWithDiamondRenderer, type DiamondTool } from "../src/tools.ts";

const theme = { fg: (token: string, text: string) => `\x1b[${token === "error" ? 31 : 90}m${text}\x1b[0m` };

test("tool results wrap without losing long output and summaries fit narrow terminals", () => {
	const tool = wrapWithDiamondRenderer(agent.createReadTool(process.cwd()));
	const body = "x".repeat(200);
	const result = tool.renderResult({ content: [{ type: "text", text: body }] }, { expanded: true }, theme);
	for (const width of [1, 8, 40, 80]) {
		const lines = result.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.equal(lines.map((line) => stripAnsi(line).trimStart()).join(""), body);
		const call = tool.renderCall({ path: "目录/".repeat(20) }, theme).render(width);
		assert.equal(call.length, 1);
		assert.ok(visibleWidth(call[0]) <= width);
	}
	assert.deepEqual(result.render(0), []);
	const unicode = textComponent(theme.fg("dim", "目录\t🙂\nsecond line")).render(8);
	assert.ok(unicode.every((line) => visibleWidth(line) <= 8));
	assert.equal(unicode.map(stripAnsi).join("").replace(/ /g, ""), "目录🙂secondline");
});

test("failed tools use context.isError and remain visibly failed while collapsed", () => {
	const tool = wrapWithDiamondRenderer(agent.createBashTool(process.cwd()));
	const context = { isError: true };
	const call = tool.renderCall({ command: "false" }, theme, context).render(80)[0];
	assert.match(stripAnsi(call), /Failed/);
	assert.match(call, /\x1b\[31m/);
	const result = { content: [{ type: "text", text: "command failed" }] };
	assert.deepEqual(tool.renderResult(result, { expanded: false }, theme, context).render(80), []);
	const expanded = tool.renderResult(result, { expanded: true }, theme, context).render(80)[0];
	assert.match(expanded, /\x1b\[31m/);
	assert.equal(stripAnsi(expanded).trimStart(), "command failed");
	assert.equal(stripAnsi(tool.renderResult({ content: [] }, { expanded: true }, theme, context).render(80)[0]).trimStart(), "error");
});

test("expanded real edits retain their diff", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "grok-edit-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "sample.txt"), "before\n");
	const tool = wrapWithDiamondRenderer(agent.createEditTool(cwd));
	const result = await tool.execute("edit-probe", { path: "sample.txt", edits: [{ oldText: "before", newText: "after" }] });
	const expanded = tool.renderResult(result, { expanded: true }, theme).render(80).map(stripAnsi).join("\n");
	assert.match(expanded, /Successfully replaced/);
	assert.match(expanded, /-.*before/);
	assert.match(expanded, /\+.*after/);
	assert.deepEqual(tool.renderResult(result, { expanded: false }, theme).render(80), []);
});

test("registered tools honor global and trusted project shell/image settings", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "grok-settings-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	await mkdir(join(cwd, ".pi"));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		shellCommandPrefix: "export GROK_REVIEW_PROBE=global",
		shellPath: "/bin/bash",
		images: { autoResize: false },
	}));
	await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
		shellCommandPrefix: "export GROK_REVIEW_PROBE=project",
		images: { autoResize: true },
	}));
	for (const trusted of [false, true]) {
		let start: Function | undefined;
		const registered: DiamondTool[] = [];
		let readOptions: unknown;
		let bashOptions: unknown;
		createGrokStyleExtension({
			on(event, handler) { if (event === "session_start") start = handler; },
			registerTool(tool) { registered.push(tool as DiamondTool); },
		}, {
			CustomEditor: class { render() { return []; } },
			getToolOptions: (ctx) => loadToolOptions(ctx, agentDir),
			tools: {
				read: (dir, options) => { readOptions = options; return agent.createReadTool(dir, options); },
				bash: (dir, options) => { bashOptions = options; return agent.createBashTool(dir, options); },
				powershell: agent.createPowerShellTool,
				edit: agent.createEditTool,
				write: agent.createWriteTool,
				grep: agent.createGrepTool,
				find: agent.createFindTool,
				ls: agent.createLsTool,
			},
		});
		await start!({}, { cwd, isProjectTrusted: () => trusted, hasUI: false, mode: "print", ui: {} });
		const expected = trusted ? "project" : "global";
		assert.deepEqual(readOptions, { autoResizeImages: trusted });
		assert.deepEqual(bashOptions, { shellPath: "/bin/bash", commandPrefix: `export GROK_REVIEW_PROBE=${expected}` });
		const result = await registered.find((tool) => tool.name === "bash")!.execute("settings-probe", {
			command: 'printf "%s" "${GROK_REVIEW_PROBE:-missing}"',
		});
		assert.equal(result.content[0].text, expected);
	}
});


test("text components reuse wrapped lines and recalculate on resize", async () => {
	const { textComponent } = await import("../src/diamond.ts");
	const component = textComponent("long output with tabs\tand multiple words ".repeat(100));
	const wide = component.render(80);
	assert.strictEqual(component.render(80), wide);
	component.invalidate();
	assert.strictEqual(component.render(80), wide);
	const narrow = component.render(20);
	assert.notStrictEqual(narrow, wide);
	assert.ok(narrow.length > wide.length);
	assert.strictEqual(component.render(20), narrow);
	assert.deepEqual(component.render(80), wide);
});

test("untrusted tool text is sanitized before theme colors are applied", () => {
	const tool = wrapWithDiamondRenderer(agent.createEditToolDefinition(process.cwd()));
	const attack = '\x1b]52;c;VEVTVA==\x07\x1b[2J\x1b[H\x1b[31m';
	const result = { content: [{ type: "text", text: `before${attack}after\nnext\tcolumn` }], details: { diff: `+added${attack}line` } };
	const rendered = tool.renderResult(result, { expanded: true }, theme).render(100).join("\n");
	assert.doesNotMatch(rendered, /\x1b\]|\x1b\[2J|\x1b\[H|VEVTVA|\x1b\[31m/);
	assert.match(rendered, /\x1b\[90m/);
	assert.match(stripAnsi(rendered), /beforeafter/);
	assert.match(stripAnsi(rendered), /\+addedline/);
	assert.match(stripAnsi(rendered), /next   column/);
	const call = tool.renderCall({ path: `safe${attack}.ts` }, theme).render(100).join("\n");
	assert.doesNotMatch(call, /\x1b\]|\x1b\[2J|VEVTVA/);
	assert.match(stripAnsi(call), /safe.ts/);
	assert.ok(result.content[0].text.includes(attack), "execution results stay unmodified");
});

test("disabled styling retains native command details and edit diffs", () => {
	agent.initTheme("dark");
	let start: Function;
	const registered: any[] = [];
	const nativeFactories = {
		read: agent.createReadToolDefinition, bash: agent.createBashToolDefinition,
		powershell: agent.createPowerShellToolDefinition, edit: agent.createEditToolDefinition,
		write: agent.createWriteToolDefinition, grep: agent.createGrepToolDefinition,
		find: agent.createFindToolDefinition, ls: agent.createLsToolDefinition,
	};
	createGrokStyleExtension({ on(name, handler) { if (name === "session_start") start = handler; }, registerTool(tool) { registered.push(tool); } }, {
		features: { toolStyling: false, footer: false, composer: false, terminalColors: false },
		CustomEditor: class { render() { return []; } }, tools: nativeFactories,
	});
	start!({}, { cwd: process.cwd(), mode: "tui", ui: {} });
	const bash = registered.find((tool) => tool.name === "bash");
	const call = bash.renderCall({ command: "printf native-command", timeout: 5 }, {}, { state: {} }).render(100).join("\n");
	assert.match(stripAnsi(call), /printf native-command/);
	assert.match(stripAnsi(call), /5s/);
	const edit = registered.find((tool) => tool.name === "edit");
	const result = edit.renderResult({ content: [], details: { diff: "-1 old\n+1 new" } }, { expanded: true }, theme,
		{ state: {}, args: { path: "file.txt" }, isError: false }).render(100).join("\n");
	assert.match(stripAnsi(result), /old/);
	assert.match(stripAnsi(result), /new/);
	assert.deepEqual(edit.promptGuidelines, nativeFactories.edit(process.cwd()).promptGuidelines);
});
