import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentSettings } from "../src/subagents/settings.ts";
import { defaultFeatures, saveFeatures } from "../src/extension/features.ts";
import { saveStyleColor } from "../src/chrome/style-colors.ts";

function fixture(t: test.TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "grok-subagent-settings-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "grok-style.json");
	return { path, save: (value: unknown) => writeFileSync(path, JSON.stringify(value)) };
}

test("subagent settings are optional and support per-type model and effort overrides", (t) => {
	const { path, save } = fixture(t);
	assert.deepEqual(loadSubagentSettings(path), {});
	save({ footer: false });
	assert.deepEqual(loadSubagentSettings(path), {});
	const subagents = {
		explore: { model: "sonnet", effort: "low" },
		plan: { model: "inherit" },
		review: { effort: "high" },
		"general-purpose": {},
		researcher: { model: "provider/model-id", effort: "max" },
		"custom-agent": { effort: "off" },
	};
	save({ subagents });
	assert.deepEqual(loadSubagentSettings(path), subagents);
	saveFeatures({ ...defaultFeatures, footer: false }, path);
	saveStyleColor("comment", "#112233", path);
	assert.deepEqual(loadSubagentSettings(path), subagents, "other settings writers preserve agent preferences");
	save({ subagents: { explore: { model: "  sonnet  " } } });
	assert.deepEqual(loadSubagentSettings(path), { explore: { model: "sonnet" } });
});

test("invalid subagent settings report the affected key rather than silently ignoring it", (t) => {
	const { path, save } = fixture(t);
	for (const subagents of [null, [], true, "sonnet"]) {
		save({ subagents });
		assert.throws(() => loadSubagentSettings(path), /Grok subagents must be an object/);
	}
	for (const value of [null, [], "sonnet"]) {
		save({ subagents: { explore: value } });
		assert.throws(() => loadSubagentSettings(path), /subagents\.explore must be an object/);
	}
	for (const model of [null, false, 123, "", "  "]) {
		save({ subagents: { explore: { model } } });
		assert.throws(() => loadSubagentSettings(path), /subagents\.explore\.model/);
	}
	for (const effort of [null, true, 123, "inherit", "HIGH", "turbo"]) {
		save({ subagents: { explore: { effort } } });
		assert.throws(() => loadSubagentSettings(path), /subagents\.explore\.effort/);
	}
	save({ subagents: { explore: { thinking: "high" } } });
	assert.throws(() => loadSubagentSettings(path), /subagents\.explore\.thinking is unsupported/);
	for (const name of ["", " explore"]) {
		save({ subagents: { [name]: {} } });
		assert.throws(() => loadSubagentSettings(path), /subagent types must be non-empty names/);
	}
	writeFileSync(path, "{broken json");
	assert.throws(() => loadSubagentSettings(path), SyntaxError);
});
