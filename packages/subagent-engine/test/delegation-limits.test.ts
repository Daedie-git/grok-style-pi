import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { delegationLimits } from "../src/delegation-limits.ts";

test("host limits preserve absent-file defaults and explicit environment overrides", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegation-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.deepEqual(delegationLimits({}, dir), { maxDepth: 3, maxConcurrent: 20, workflowsEnabled: true });
	const path = join(dir, "subagents.json");
	writeFileSync(path, JSON.stringify({ maxSubagentDepth: 1, workflowsEnabled: false, unrelated: "ignored" }));
	assert.deepEqual(delegationLimits({ PI_MAX_SUBAGENT_SPAWN_DEPTH: "-5" }, dir), { maxDepth: 1, maxConcurrent: 20, workflowsEnabled: false });
	assert.deepEqual(delegationLimits({ PI_MAX_SUBAGENT_SPAWN_DEPTH: "4", PI_MAX_CONCURRENT_SUBAGENTS: "5", PI_SUBAGENT_WORKFLOW: "1" }, dir), { maxDepth: 4, maxConcurrent: 5, workflowsEnabled: true });
	for (const malformed of ["{", "[]", "null", '{"maxSubagentDepth":-1}', '{"workflowsEnabled":"false"}']) {
		writeFileSync(path, malformed);
		assert.throws(() => delegationLimits({}, dir), /subagents.json/);
	}
});
