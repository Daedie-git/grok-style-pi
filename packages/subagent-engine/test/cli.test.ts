import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const entry of ["./bundle/cli.js", "./cli.js"]) {
	test(`the standalone engine loads through the Pi CLI (${entry})`, { timeout: 30_000 }, (t) => {
		const root = mkdtempSync(join(tmpdir(), "engine-cli-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cli = fileURLToPath(new URL(entry, import.meta.resolve("@earendil-works/pi-coding-agent")));
		const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
		const result = spawnSync(process.execPath, [cli,
			"--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
			"--no-themes", "--no-context-files", "--no-session", "-e", extension, "--mode", "rpc",
		], {
			cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, encoding: "utf8", timeout: 25_000,
			input: `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const response = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === "state");
		assert.equal(response?.success, true, result.stdout);
	});
}
