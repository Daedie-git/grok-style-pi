import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeConfig } from "../src/claude-memory/location.ts";
import { usesMemorySelector } from "../src/claude-memory/mode.ts";

test("mode follows Claude's cold flag cache, whole-map fallback, OAuth path and stores override", (t) => {
	const home = mkdtempSync(join(tmpdir(), "memory-mode-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const configDir = join(home, "claude-config");
	mkdirSync(configDir);
	const config = claudeConfig({ CLAUDE_CONFIG_DIR: configDir }, home);
	const current = join(configDir, ".claude.json");
	const enabled = { cachedFeatureFlags: { tengu_moth_copse: true } };
	writeFileSync(join(home, ".claude.json"), JSON.stringify(enabled));
	assert.equal(usesMemorySelector(config), false);
	writeFileSync(current, JSON.stringify(enabled));
	assert.equal(usesMemorySelector(config), true);
	writeFileSync(current, JSON.stringify({ ...enabled, cachedGrowthBookFeatures: {} }));
	assert.equal(usesMemorySelector(config), false);
	for (const stores of [" ", "false", "[]", "0"]) assert.equal(usesMemorySelector({ ...config, env: { ...config.env, CLAUDE_MEMORY_STORES: stores } }), !!stores.trim());
	writeFileSync(join(configDir, ".claude-custom-oauth.json"), JSON.stringify(enabled));
	assert.equal(usesMemorySelector({ ...config, env: { ...config.env, CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://example.test" } }), true);
	writeFileSync(join(configDir, ".config.json"), JSON.stringify(enabled));
	assert.equal(usesMemorySelector(config), true);
});
