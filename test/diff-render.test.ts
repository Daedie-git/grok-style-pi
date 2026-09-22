import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { buildDiffRows, defaultDiffPalette, DELETE_BG, DELETE_CHAR_BG, emphasizeSpan, INSERT_BG, INSERT_CHAR_BG, paintRows } from "../src/diff-render.ts";

const theme = {
	paint: (token: string, text: string) => `\x1b[${token === "toolDiffAdded" ? 32 : token === "toolDiffRemoved" ? 31 : 90}m${text}\x1b[39m`,
	inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

function marked(line: string, bg: string): string {
	return line.split(`\x1b[48;2;${bg}m`).slice(1)
		.map((part) => stripTerminalSequences(part.split(/\x1b\[48;2;/)[0])).join("");
}

test("diff rows keep source characters and do not leak backgrounds across kinds", () => {
	const rows = buildDiffRows("-1 😀foo\n+1 😀bar\n 2 kept", theme, (text) => text.split("\n"));
	const lines = paintRows(rows, 40, "  ");
	assert.match(stripTerminalSequences(lines[0]), /😀foo/);
	assert.match(stripTerminalSequences(lines[1]), /😀bar/);
	assert.match(stripTerminalSequences(lines[2]), /kept/);
	assert.match(lines[0], new RegExp(`\\x1b\\[48;2;${DELETE_BG}m`));
	assert.match(lines[1], new RegExp(`\\x1b\\[48;2;${INSERT_BG}m`));
	assert.doesNotMatch(lines[1], new RegExp(`48;2;${DELETE_BG}|48;2;${DELETE_CHAR_BG}`));
	assert.doesNotMatch(lines[2], new RegExp(`48;2;${INSERT_BG}|48;2;${DELETE_BG}|48;2;${INSERT_CHAR_BG}|48;2;${DELETE_CHAR_BG}`));
	assert.ok(lines.every((line) => line.endsWith("\x1b[0m") || !line.includes("48;2;")));
	const long = buildDiffRows("-1 removed\n+1 added\n " + "context ".repeat(12), theme, (text) => text.split("\n"));
	const narrow = paintRows(long, 10, "");
	assert.ok(narrow.length > 3);
	assert.doesNotMatch(narrow.filter((line) => stripTerminalSequences(line).includes("context")).join("\n"), /48;2;/);
});

test("emphasis preserves graphemes split across syntax colors and keeps syntax sequences", () => {
	const plain = "let true\u0301foo = 1;";
	const colored = "let \x1b[31mtrue\x1b[0m\x1b[37m\u0301\x1b[0m\x1b[32mfoo\x1b[0m = 1;";
	const marked = emphasizeSpan(colored, plain, 8, 11, theme.inverse);
	assert.equal(stripTerminalSequences(marked), plain);
	assert.ok(marked.includes(theme.inverse("foo")));
	assert.equal(marked.replaceAll("\x1b[7m", "").replaceAll("\x1b[27m", ""), colored);

	for (const source of ["e\u0301foo", "👩‍💻foo", "🇺🇸foo"]) {
		const chars = Array.from(source);
		const highlighted = chars.map((char) => `\x1b[31m${char}\x1b[0m`).join("");
		const emphasized = emphasizeSpan(highlighted, source, 0, 4, theme.inverse);
		assert.equal(stripTerminalSequences(emphasized), source);
		assert.equal(emphasized.replaceAll("\x1b[7m", "").replaceAll("\x1b[27m", ""), highlighted);
	}
	const rows = buildDiffRows("-1 " + plain + "\n+1 " + plain.replace("foo", "bar"), theme,
		(text) => text.split("\n").map((line) => line.replace("true", "\x1b[31mtrue\x1b[0m")));
	assert.deepEqual(rows.map((row) => stripTerminalSequences(row.text)), ["-1 " + plain, "+1 " + plain.replace("foo", "bar")]);
});

test("character highlights follow mapped lines instead of one shared prefix and suffix", () => {
	const rows = buildDiffRows([
		"-1 return old_value;",
		"+1 return new_value;",
		"-2 keep();",
		"+2 keep();",
		"-3 only removed",
		" 4 context",
		"+5 only added",
	].join("\n"), theme, (text) => text.split("\n"));
	const painted = paintRows(rows, 80);
	assert.equal(marked(painted[0], DELETE_CHAR_BG), "old");
	assert.equal(marked(painted[1], INSERT_CHAR_BG), "new");
	assert.equal(marked(painted[2], DELETE_CHAR_BG), "");
	assert.equal(marked(painted[3], INSERT_CHAR_BG), "");
	assert.equal(marked(painted[4], DELETE_CHAR_BG), "");
	assert.equal(marked(painted[6], INSERT_CHAR_BG), "");
	assert.doesNotMatch(painted.join("\n"), /\x1b\[7m/);

	const split = buildDiffRows("-1 const a = 1; const b = 2;\n+1 const a = 9; const b = 8;", theme, (text) => text.split("\n"));
	const splitPainted = paintRows(split, 80);
	assert.equal(marked(splitPainted[0], DELETE_CHAR_BG), "12");
	assert.equal(marked(splitPainted[1], INSERT_CHAR_BG), "98");

	const swallowed = buildDiffRows("-1 XX..YY\n+1 AA..BB", theme, (text) => text.split("\n"));
	assert.equal(marked(paintRows(swallowed, 40)[0], DELETE_CHAR_BG), "XX..YY");
	const kept = buildDiffRows("-1 XX | YY\n+1 AA | BB", theme, (text) => text.split("\n"));
	assert.equal(marked(paintRows(kept, 40)[0], DELETE_CHAR_BG), "XXYY");

	const indented = buildDiffRows("-1     return old;\n+1         return new;", theme, (text) => text.split("\n"));
	const indentedPainted = paintRows(indented, 40);
	assert.equal(marked(indentedPainted[0], DELETE_CHAR_BG), "old");
	assert.equal(marked(indentedPainted[1], INSERT_CHAR_BG), "new");

	const word = buildDiffRows("-1 backgroundColor\n+1 backgroundColour", theme, (text) => text.split("\n"));
	const wordPainted = paintRows(word, 40);
	assert.equal(marked(wordPainted[0], DELETE_CHAR_BG), "backgroundColor");
	assert.equal(marked(wordPainted[1], INSERT_CHAR_BG), "backgroundColour");
});

test("configured diff colors replace the default backgrounds", () => {
	const palette = { ...defaultDiffPalette, insert: "1;2;3", insertChar: "4;5;6" };
	const rows = buildDiffRows("-1 old\n+1 new", theme, (text) => text.split("\n"), palette);
	const painted = paintRows(rows, 40, "", palette).join("\n");
	assert.match(painted, /\x1b\[48;2;1;2;3m/);
	assert.match(painted, /\x1b\[48;2;4;5;6mnew/);
	assert.doesNotMatch(painted, new RegExp(`48;2;${INSERT_BG}|48;2;${INSERT_CHAR_BG}`));
});

test("emphasis inserts into highlighted text without splitting a grapheme", () => {
	const colored = "\x1b[38;2;1;2;3m😀foo\x1b[0m";
	const marked = emphasizeSpan(colored, "😀foo", 1, 4, (text) => `\x1b[7m${text}\x1b[27m`);
	assert.match(marked, /😀\x1b\[7mfoo\x1b\[27m/);
	assert.doesNotMatch(marked, /\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
