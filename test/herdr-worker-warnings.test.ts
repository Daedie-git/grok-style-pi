import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("Herdr SQLite workers do not write experimental notices over Pi's UI", { timeout: 20_000 }, async () => {
	const module = new URL("../src/herdr/store.ts", import.meta.url).href;
	const { stdout, stderr } = await execute(process.execPath, ["--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { HerdrStore } from ${JSON.stringify(module)};
		const root = mkdtempSync(join(tmpdir(), "grok-worker-warning-"));
		const brokenRoot = mkdtempSync(join(tmpdir(), "grok-worker-broken-"));
		const store = new HerdrStore(root);
		let broken;
		try {
			await store.assertProtocolReady();
			assert.deepEqual(await store.listAgents(), []);
			process.emitWarning("host experimental warning remains visible", { type: "ExperimentalWarning" });
			process.emitWarning("host regular warning remains visible");
			mkdirSync(join(brokenRoot, "control.sqlite"));
			broken = new HerdrStore(brokenRoot);
			await assert.rejects(broken.assertProtocolReady(), /\\[DEBUG-herdr-db\\] operation=initialize control\\.sqlite/);
			console.log("database operations and initialization diagnostics passed");
		} finally {
			await store.close();
			await broken?.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(brokenRoot, { recursive: true, force: true });
		}
	`], { env: { ...process.env, NODE_OPTIONS: "" } });
	assert.match(stdout, /database operations and initialization diagnostics passed/);
	assert.doesNotMatch(stderr, /ExperimentalWarning: SQLite/, "worker startup must not corrupt Pi's terminal UI");
	assert.match(stderr, /ExperimentalWarning: host experimental warning remains visible/);
	assert.match(stderr, /Warning: host regular warning remains visible/);
});
