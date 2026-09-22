import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { highlightLines } from "../src/rendering/highlight.ts";

test("Grok Night colors punctuation and types that the Pi highlighter leaves plain", { skip: process.env.GROK_BAT_INTEGRATION !== "1" }, () => {
	const lines = highlightLines("class Widget { int n_; };", "cpp", "widget.hpp", undefined);
	assert.ok(lines);
	const colored = lines.join("");
	assert.match(colored, /\x1b\[38;2;187;154;247mclass/);
	assert.match(colored, /\x1b\[38;2;154;189;245m\{/);
	assert.match(colored, /\x1b\[38;2;187;154;247mint/);
	assert.equal(stripAnsi(colored), "class Widget { int n_; };");
});
