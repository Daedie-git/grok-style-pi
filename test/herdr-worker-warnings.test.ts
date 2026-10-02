import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("proxy-enabled worker startup does not write Undici notices over Pi's UI", { timeout: 25_000 }, async () => {
	const storeModule = new URL("../src/herdr/store.ts", import.meta.url).href;
	const visualModule = new URL("../src/rendering/visual-preparation.ts", import.meta.url).href;
	const paletteModule = new URL("../src/rendering/style-palette.ts", import.meta.url).href;
	const node = process.env.GROK_WARNING_NODE || process.execPath;
	const { stdout, stderr } = await execute(node, ["--disable-warning=UNDICI-EHPA", "--input-type=module", "--eval", `
		import { mkdtempSync, rmSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { HerdrStore } from ${JSON.stringify(storeModule)};
		import { VisualPreparation } from ${JSON.stringify(visualModule)};
		import { defaultStyleColors } from ${JSON.stringify(paletteModule)};
		const root = mkdtempSync(join(tmpdir(), "grok-proxy-warning-"));
		const store = new HerdrStore(root);
		const visual = new VisualPreparation();
		try {
			await store.listAgents();
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("visual worker did not finish")), 15000);
				visual.request({ kind: "layout", text: "worker result", rows: [], width: 40, colors: defaultStyleColors }, {}, () => { clearTimeout(timeout); resolve(); });
			});
			process.emitWarning("unrelated host warning remains visible");
			console.log("proxy-enabled SQLite and visual workers completed");
		} finally {
			visual.reset();
			await store.close();
			rmSync(root, { recursive: true, force: true });
		}
	`], { env: { ...process.env, NODE_OPTIONS: "", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" } });
	assert.match(stdout, /SQLite and visual workers completed/);
	assert.doesNotMatch(stderr, /UNDICI-EHPA/, "worker boot warnings bypass the parent warning listener and corrupt its composer");
	assert.match(stderr, /unrelated host warning remains visible/);
});

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
