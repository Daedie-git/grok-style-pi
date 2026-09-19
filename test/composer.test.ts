import assert from "node:assert/strict";
import test from "node:test";
import {
	applyComposerBorderColor,
	composerBorderToken,
	FOCUS_BORDER_TOKEN,
	IDLE_BORDER_TOKEN,
	renderComposerFrame,
} from "../src/composer.ts";

test("composerBorderToken is muted idle and brighter focused", () => {
	assert.equal(composerBorderToken(false), IDLE_BORDER_TOKEN);
	assert.equal(composerBorderToken(true), FOCUS_BORDER_TOKEN);
	assert.notEqual(IDLE_BORDER_TOKEN, FOCUS_BORDER_TOKEN);
});

test("renderComposerFrame draws a box that differs when focused", () => {
	const paint = (token: string, text: string) => `[${token}]${text}`;
	const idle = renderComposerFrame(["hello"], { focused: false, width: 12, paint });
	const focused = renderComposerFrame(["hello"], { focused: true, width: 12, paint });

	assert.ok(idle.length >= 3);
	assert.ok(idle[0]?.includes("┌"));
	assert.ok(idle[idle.length - 1]?.includes("└"));
	assert.ok(idle.some((line) => line.includes("│") && line.includes("hello")));
	assert.ok(idle.every((line) => line.includes(`[${IDLE_BORDER_TOKEN}]`)));
	assert.ok(focused.every((line) => line.includes(`[${FOCUS_BORDER_TOKEN}]`)));
	assert.notEqual(idle.join("\n"), focused.join("\n"));
});

test("applyComposerBorderColor paints with the focused token", () => {
	let painted = "";
	applyComposerBorderColor(
		(fn) => {
			painted = fn("─");
		},
		true,
		(token, text) => `${token}:${text}`,
	);
	assert.equal(painted, `${FOCUS_BORDER_TOKEN}:─`);
});
