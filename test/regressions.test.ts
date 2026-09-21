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
import { grokNightPath, loadThemeJson, resolveThemeColors } from "../src/theme.ts";

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
	const colors = resolveThemeColors(loadThemeJson(grokNightPath()));
	const actualTheme = new agent.Theme(colors as any, colors as any, "truecolor");
	const defaultLines = tool.renderResult(result, { expanded: false }, actualTheme).render(80);
	const rendered = defaultLines.join("\n");
	assert.ok(rendered.includes(actualTheme.getFgAnsi("toolDiffAdded")), "actual edits must contain green ANSI styling");
	assert.ok(rendered.includes(actualTheme.getFgAnsi("toolDiffRemoved")), "actual edits must contain red ANSI styling");
	// Pi's emphasis helper follows terminal color support (unlike RGB fg).
	if (actualTheme.inverse("x") !== "x") assert.match(rendered, /\x1b\[7m/);
	const expanded = defaultLines.map(stripAnsi).join("\n");
	assert.match(expanded, /Successfully replaced/);
	assert.match(expanded, /-.*before/);
	assert.match(expanded, /\+.*after/);
	assert.deepEqual(tool.renderResult(result, { expanded: true }, actualTheme).render(80), defaultLines);
});

test("expanded diffs color changes without coloring ordinary output as a diff", () => {
	const tool = wrapWithDiamondRenderer(agent.createEditToolDefinition(process.cwd()));
	const colors: Record<string, number> = { toolOutput: 90, toolDiffContext: 90, toolDiffAdded: 32, toolDiffRemoved: 31 };
	const diffTheme = { fg: (token: string, text: string) => `\x1b[${colors[token]}m${text}\x1b[0m` };
	for (const key of ["diff", "patch"]) {
		const result = {
			content: [{ type: "text", text: "+ordinary output" }],
			details: { [key]: "--- a/file\n+++ b/file\n context\n-1 old\n+1 new\x1b]52;c;payload\x07" },
		};
		const component = tool.renderResult(result, { expanded: true }, diffTheme);
		const lines = component.render(80);
		assert.ok(lines.some((line) => line.includes("\x1b[90m+ordinary output")));
		assert.ok(lines.some((line) => line.includes("\x1b[90m+++ b/file")));
		assert.ok(lines.some((line) => line.includes("\x1b[31m-1 ")));
		assert.ok(lines.some((line) => line.includes("\x1b[32m+1 ")));
		assert.ok(lines.some((line) => line.includes("\x1b[48;2;66;14;20m")));
		assert.ok(lines.some((line) => line.includes("\x1b[48;2;6;56;6m")));
		assert.match(stripAnsi(lines.join("\n")), /-1 old/);
		assert.match(stripAnsi(lines.join("\n")), /\+1 new/);
		assert.doesNotMatch(lines.join("\n"), /payload|\x1b\]/);
		assert.ok(component.render(8).every((line) => visibleWidth(line) <= 8));
		assert.deepEqual(tool.renderResult(result, { expanded: false }, diffTheme).render(80), lines);
	}
});

test("edits start open, collapse by clicking their diamond, and follow global expansion changes", () => {
	const tool = wrapWithDiamondRenderer(agent.createEditToolDefinition(process.cwd()));
	const result = { content: [], details: { diff: "- 1 old\n+ 1 new" } };
	let invalidated = 0;
	const context = { state: {}, expanded: false, invalidate: () => { invalidated++; } };
	const body = () => tool.renderResult(result, { expanded: context.expanded }, theme, context).render(80);
	const click = () => (tool.renderCall({ path: "file" }, theme, context) as any).handleMouse({ type: "click", button: "left" });
	assert.ok(body().length > 0);
	assert.deepEqual(click(), { handled: true });
	assert.deepEqual(body(), []);
	click();
	assert.ok(body().length > 0);
	assert.equal(invalidated, 2);
	context.expanded = true;
	assert.ok(body().length > 0);
	context.expanded = false;
	assert.deepEqual(body(), []);
	assert.deepEqual(tool.renderResult(result, { expanded: true, isPartial: true }, theme, context).render(80), []);
});

test("replacement emphasis isolates changed text and keeps terminal controls sanitized", () => {
	const tool = wrapWithDiamondRenderer(agent.createEditToolDefinition(process.cwd()));
	const emphasized: string[] = [];
	const paint = { ...theme, inverse(text: string) { emphasized.push(text); return `\x1b[7m${text}\x1b[27m`; } };
	const result = { content: [], details: { diff: "- 42 return old_value;\n+ 42 return new_value;\x1b]52;c;attack\x07" } };
	const output = tool.renderResult(result, { expanded: false }, paint).render(80).join("\n");
	assert.deepEqual(emphasized, ["old", "new"]);
	assert.doesNotMatch(output, /attack|\x1b\]/);
	assert.match(output, /\x1b\[7mnew\x1b\[27m/);
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
			registerTool(tool) { const index = registered.findIndex((entry) => entry.name === tool.name); if (index >= 0) registered[index] = tool as DiamondTool; else registered.push(tool as DiamondTool); },
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
	createGrokStyleExtension({ on(name, handler) { if (name === "session_start") start = handler; }, registerTool(tool) { const index = registered.findIndex((entry) => entry.name === tool.name); if (index >= 0) registered[index] = tool; else registered.push(tool); } }, {
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

test("failed shell diamonds summarize exit status and expand the exact command", async () => {
	const tool = wrapWithDiamondRenderer(agent.createBashToolDefinition(process.cwd()));
	const args = { command: "exit 1", description: "Capture consecutive play-mode GUI frames" };
	let failure = "";
	try { await tool.execute("fail", args); } catch (error) { failure = (error as Error).message; }
	assert.match(failure, /Command exited with code 1/);
	const context = { args, isError: true, state: {} };
	const header = tool.renderCall(args, theme, context);
	const result = { content: [{ type: "text", text: failure }] };
	assert.deepEqual(tool.renderResult(result, { expanded: false }, theme, context).render(100), []);
	assert.equal(stripAnsi(header.render(100)[0]), "◆ Failed: Capture consecutive play-mode GUI frames · exit 1");
	const expanded = stripAnsi(tool.renderResult(result, { expanded: true }, theme, context).render(100).join("\n"));
	assert.match(expanded, /\$ exit 1/);
	assert.match(expanded, /Command exited with code 1/);
	assert.doesNotMatch(expanded, /\(no output\)/);
	const output = { content: [{ type: "text", text: "real stderr\n\nCommand exited with code 2" }] };
	const multiline = { ...context, args: { command: "printf 'real stderr' >&2\nexit 2\x1b]52;c;attack\x07" } };
	const details = stripAnsi(tool.renderResult(output, { expanded: true }, theme, multiline).render(100).join("\n"));
	assert.match(details, /\$ printf 'real stderr' >&2\n  exit 2/);
	assert.match(details, /real stderr\n\s*\n  Command exited with code 2/);
	assert.doesNotMatch(details, /attack|\x1b/);
});
