import assert from "node:assert/strict";
import test from "node:test";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { INSERT_BG } from "../src/rendering/diff-render.ts";
import { highlightLines, languageForPath } from "../src/rendering/highlight.ts";
import { wrapWithDiamondRenderer, type OriginalTool } from "../src/tools/renderer.ts";

initTheme("dark");

const theme = {
	fg: (token: string, text: string) => `\x1b[${token === "toolDiffAdded" ? 32 : token === "muted" ? 90 : 37}m${text}\x1b[0m`,
};

function tool(name: string): ReturnType<typeof wrapWithDiamondRenderer> {
	const original = { name, description: name, parameters: {}, execute: async () => ({ content: [] }) } as OriginalTool;
	return wrapWithDiamondRenderer(original);
}

test("C++ headers and the requested source extensions map to a highlighter", () => {
	assert.equal(languageForPath("include/widget.h"), "cpp");
	assert.equal(languageForPath("include/widget.hpp"), "cpp");
	assert.equal(languageForPath("include/widget.hh"), "cpp");
	assert.equal(languageForPath("include/widget.hxx"), "cpp");
	assert.equal(languageForPath("include/widget.h++"), "cpp");
	assert.equal(languageForPath("src/widget.inl"), "cpp");
	assert.equal(languageForPath("src/widget.ipp"), "cpp");
	assert.equal(languageForPath("src/widget.tpp"), "cpp");
	assert.equal(languageForPath("src/widget.cu"), "cpp");
	assert.equal(languageForPath("src/widget.cuh"), "cpp");
	assert.equal(languageForPath("src/app.cpp"), "cpp");
	assert.equal(languageForPath("src/app.c"), "c");
	assert.equal(languageForPath("src/app.ts"), "typescript");
	assert.equal(languageForPath("src/app.tsx"), "typescript");
	assert.equal(languageForPath("src/app.js"), "javascript");
	assert.equal(languageForPath("src/app.rs"), "rust");
	assert.equal(languageForPath("src/app.py"), "python");
	assert.equal(languageForPath("scripts/run.sh"), "bash");
	assert.equal(languageForPath("scripts/run.ps1"), "powershell");
	assert.equal(languageForPath("scripts/run.psm1"), "powershell");
});

test("expanded reads highlight C++ and the other requested languages", () => {
	const samples = [
		["widget.h", "class Widget {};", "cpp"],
		["app.ts", "const value: number = 1;", "typescript"],
		["app.js", "const value = 1;", "javascript"],
		["app.rs", "fn main() {}", "rust"],
		["app.py", "def main():\nreturn 1", "python"],
		["run.sh", "if true; then echo hi; fi", "bash"],
		["run.ps1", "Get-ChildItem -Path $x", "powershell"],
	] as const;
	for (const [path, source, lang] of samples) {
		const output = tool("read").renderResult(
			{ content: [{ type: "text", text: source }] },
			{ expanded: true },
			theme,
			{ args: { path } },
		).render(120).join("\n");
		assert.equal(stripAnsi(output).split("\n").map((line) => line.trimStart()).join("\n").trim(), source);
		assert.ok(output.includes("\x1b["), `${path} should color ${lang}`);
	}
});

test("read continuation notices stay outside the highlighted source", () => {
	const source = "class Widget {};";
	const notice = "[Showing lines 1-1 of 9. Use offset=2 to continue.]";
	const output = tool("read").renderResult(
		{ content: [{ type: "text", text: `${source}\n\n${notice}` }] },
		{ expanded: true },
		theme,
		{ args: { path: "widget.hpp" } },
	).render(120).join("\n");
	assert.ok(output.includes("\x1b["));
	assert.ok(output.includes(theme.fg("muted", notice)));
	assert.equal(stripAnsi(output).replace(/\s+/g, " ").trim(), `${source} ${notice}`);
});

test("new C++ files keep a green gutter and highlight the source", () => {
	const source = "class Widget {};";
	const output = tool("write").renderResult(
		{ content: [{ type: "text", text: "wrote" }], details: { grokWrite: { kind: "created", lines: 1, preview: `${source}\n` } } },
		{ expanded: false },
		theme,
		{ args: { path: "widget.h", content: source }, state: {} },
	).render(120).join("\n");
	assert.ok(output.includes("\x1b[32m+1 "));
	assert.ok(output.includes(`\x1b[48;2;${INSERT_BG}m`));
	assert.ok(output.includes("\x1b["));
	assert.match(stripAnsi(output), /\+1 class Widget \{\};/);
});

test("bash and powershell commands are highlighted and their output is not", () => {
	const command = "if true; then echo hi; fi";
	const output = tool("bash").renderResult(
		{ content: [{ type: "text", text: "hi" }] },
		{ expanded: true },
		theme,
		{ args: { command } },
	).render(120).join("\n");
	assert.ok(output.includes(theme.fg("toolOutput", "$ ")));
	assert.ok(output.includes("\x1b["));
	assert.ok(output.includes(theme.fg("toolOutput", "hi")));
	assert.equal(stripAnsi(output).replace(/\n+/g, "\n"), `  $ ${command}\n  \n  hi`);

	const ps = "Get-ChildItem -Path $x";
	const powershell = tool("powershell").renderResult(
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: true },
		theme,
		{ args: { command: ps } },
	).render(120).join("\n");
	assert.ok(powershell.includes("\x1b["));
	assert.ok(powershell.includes(theme.fg("toolOutput", "ok")));
});

test("highlighting falls back to Pi without bat and does not change the source", () => {
	const lines = highlightLines("const value = 1;", "typescript", "app.ts", () => undefined);
	assert.ok(lines);
	assert.equal(stripAnsi(lines.join("\n")), "const value = 1;");
	assert.equal(highlightLines("", "typescript", "app.ts", () => undefined), undefined);
});

test("temporary primary failures retry before caching a successful highlight", () => {
	const source = "const retry = 1;";
	const primary = [`\x1b[31m${source}\x1b[0m`];
	let calls = 0;
	const attempt = () => ++calls === 1 ? undefined : primary;
	assert.equal(stripAnsi(highlightLines(source, "typescript", "retry.ts", attempt)!.join("\n")), source);
	assert.deepEqual(highlightLines(source, "typescript", "retry.ts", attempt), primary);
	assert.deepEqual(highlightLines(source, "typescript", "retry.ts", attempt), primary);
	assert.equal(calls, 2);
	const other = [`\x1b[32m${source}\x1b[0m`];
	assert.deepEqual(highlightLines(source, "typescript", "retry.ts", () => other), other);
});

test("primary highlighting cache remains bounded", () => {
	let calls = 0;
	const attempt = (text: string) => { calls++; return [`\x1b[31m${text}\x1b[0m`]; };
	for (let index = 0; index < 65; index++) highlightLines(String(index), undefined, undefined, attempt);
	highlightLines("64", undefined, undefined, attempt);
	assert.equal(calls, 65);
	highlightLines("0", undefined, undefined, attempt);
	assert.equal(calls, 66);
});

test("expanded read panels use the lighter GrokNight code-block background", () => {
	const panel = { ...theme, bg: (token: string, text: string) => token === "customMessageBg" ? `\x1b[48;2;28;28;28m${text}\x1b[49m` : text };
	const output = tool("read").renderResult(
		{ content: [{ type: "text", text: "class Widget {};" }] },
		{ expanded: true },
		panel,
		{ args: { path: "widget.h" } },
	).render(40).join("\n");
	assert.match(output, /\x1b\[48;2;28;28;28m/);
	assert.equal(stripAnsi(output).trim(), "class Widget {};");
	const plain = tool("bash").renderResult(
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: true },
		panel,
		{ args: { command: "true" } },
	).render(40).join("\n");
	assert.doesNotMatch(plain, /\x1b\[48;2;28;28;28m/);
});

test("failed shell commands stay error-colored instead of syntax-highlighted", () => {
	const output = tool("bash").renderResult(
		{ content: [{ type: "text", text: "command failed" }] },
		{ expanded: true },
		theme,
		{ isError: true, args: { command: "if true; then false; fi" } },
	).render(120).join("\n");
	assert.match(output, /\x1b\[37m/);
	assert.doesNotMatch(output, new RegExp(highlightCode("if", "bash")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(stripAnsi(output), /command failed/);
});
