import assert from "node:assert/strict";
import test from "node:test";
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

	assert.equal(resolved.accent, theme.vars?.magenta);
	assert.equal(resolved.borderMuted, theme.vars?.promptBorder);
	assert.equal(resolved.borderAccent, theme.vars?.promptBorderActive);
});
