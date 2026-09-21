import assert from "node:assert/strict";
import test from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { ActivityViewer } from "../src/activity-ui.ts";
import { GROK_FG, GROK_BG, GROK_CURSOR } from "../src/terminal-chrome.ts";
import {
	grokNightPath,
	loadThemeJson,
	missingRequiredTokens,
	REQUIRED_COLOR_TOKENS,
	resolveThemeColors,
	unresolvedVarRefs,
} from "../src/theme.ts";

test("GrokNight defines every required Pi color token and resolves vars", () => {
	const theme = loadThemeJson(grokNightPath());
	assert.equal(theme.name, "groknight");
	assert.deepEqual(missingRequiredTokens(theme), []);
	assert.deepEqual(unresolvedVarRefs(theme), []);

	const resolved = resolveThemeColors(theme);
	for (const token of REQUIRED_COLOR_TOKENS) {
		assert.ok(token in theme.colors, `missing ${token}`);
		const value = resolved[token];
		assert.notEqual(value, undefined, `unresolved ${token}`);
		if (typeof value === "string" && value !== "") {
			assert.ok(value.startsWith("#"), `${token} should resolve to hex, got ${String(value)}`);
			assert.notEqual(value, token);
		}
	}

	assert.equal(resolved.accent, theme.vars?.blue);
	assert.equal(resolved.borderMuted, theme.vars?.promptBorder);
	assert.equal(resolved.borderAccent, theme.vars?.promptBorderActive);
	assert.equal(resolved.text, "#e1e1e1");
	assert.equal(resolved.userMessageBg, "#242424");
	assert.equal(resolved.userMessageText, "#e1e1e1");
	assert.equal(resolved.customMessageBg, "#1c1c1c");
});

test("terminal defaults match explicit GrokNight colors", () => {
	const colors = resolveThemeColors(loadThemeJson(grokNightPath()));
	assert.equal(GROK_FG, "#c8c8c8");
	assert.equal(GROK_FG, colors.mdCodeBlock);
	assert.equal(GROK_BG, colors.toolPendingBg);
	assert.equal(GROK_CURSOR, colors.mdCodeBlock);
});

test("activity viewer paints output and footer controls with the real theme", () => {
	const colors = resolveThemeColors(loadThemeJson(grokNightPath()));
	const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
	const viewer = new ActivityViewer({
		id: "preview", kind: "agent", title: "Explore", status: "running", startedAt: 0,
		output: "Result body", stop() {},
	}, theme, () => 24, () => {}, () => {}, () => {});
	const rendered = viewer.render(80).join("\n");
	assert.ok(rendered.includes(theme.fg("toolOutput", "Result body")));
	assert.ok(rendered.includes(theme.fg("accent", "[Close: Esc]")));
	assert.ok(rendered.includes(theme.fg("error", "[Stop: x]  ")));
});
