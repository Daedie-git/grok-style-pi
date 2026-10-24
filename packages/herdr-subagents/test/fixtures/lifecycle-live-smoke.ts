// Opt-in: node packages/herdr-subagents/test/fixtures/lifecycle-live-smoke.ts
// Starts two real Pi processes, makes two model requests, and closes only its own panes.
// --self --deleted-workspace also verifies self-close recovery, caller placement and orphan adoption.
// --upgrade-db verifies a paused inherited database and the explicit post-drain activation CLI.
// Add --quarantine-cold to verify the public resume refuses a gone pane before activation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createHerdrCli } from "../../src/herdr/client.ts";
import { HerdrRunner, spawnHerdrAgent, type SpawnRequest } from "../../src/herdr/runner.ts";

assert.equal(process.env.HERDR_ENV, "1", "Run inside a Herdr pane");
const captures = resolve("captures");
mkdirSync(captures, { recursive: true });
const root = mkdtempSync(join(captures, "lifecycle-live-"));
if (process.argv.includes("--upgrade-db")) {
	// A legacy database exists, but its seed connection has drained before new workers start.
	const legacy = new DatabaseSync(join(root, "control.sqlite"));
	legacy.exec("PRAGMA user_version=2");
	legacy.close();
}
const extension = join(root, "extension.ts");
const factory = new URL("../../src/herdr/extension.ts", import.meta.url).pathname;
writeFileSync(join(root, "herdr-subagents.json"), JSON.stringify({ idleCloseSeconds: 1 }));
writeFileSync(extension, `import { createHerdrSubagents } from ${JSON.stringify(factory)};\nexport default createHerdrSubagents({ root: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(root)} });\n`);
const native = createHerdrCli();
const reporter = process.env.HERDR_PI_REPORTER || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "extensions", "herdr-agent-state.ts");
const client = { ...native, startPi: (options: { name: string; paneId: string; args: string[] }, signal?: AbortSignal) => native.startPi({ ...options, args: ["--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "-e", reporter, "-e", extension, ...options.args] }, signal) };
const runner = new HerdrRunner({ root, client, idleCloseSeconds: 1 });
const token = `remember-${Date.now()}`;
const request: SpawnRequest = {
	name: `lifecycle-${process.pid}`, subagentType: "test", description: "Lifecycle live smoke",
	prompt: `Remember this token for my next message: ${token}. Reply only with that token. Do not use tools.`,
	cwd: process.cwd(), paneId: process.env.HERDR_PANE_ID!, tabId: process.env.HERDR_TAB_ID,
	workspaceId: process.env.HERDR_WORKSPACE_ID, runInBackground: false,
	model: `${process.env.PI_PROVIDER || "openai-codex"}/${process.env.PI_MODEL || "gpt-6.1-sol"}`, thinking: "low",
	resolved: { allowedTools: [] },
};
const signal = AbortSignal.timeout(180_000);
const herdr = process.env.HERDR_BIN_PATH || "herdr";
let temporaryWorkspace: string | undefined;
try {
	request.sessionFile = (await native.getPane!(request.paneId))?.session;
	let initial = request;
	if (process.argv.includes("--deleted-workspace")) {
		const created = JSON.parse(execFileSync(herdr, ["workspace", "create", "--cwd", request.cwd, "--label", "Lifecycle isolated smoke", "--no-focus"], { encoding: "utf8" })).result;
		temporaryWorkspace = created.workspace.workspace_id;
		assert.equal(typeof temporaryWorkspace, "string");
		initial = { ...request, paneId: created.root_pane.pane_id, tabId: created.tab.tab_id, workspaceId: temporaryWorkspace, sessionFile: undefined };
	}
	const first = await spawnHerdrAgent(initial, { root, client, runner, signal });
	assert.equal(first.details.status, "completed", first.text);
	assert.ok(first.text.includes(token), first.text);
	const agentId = String(first.details.agentId);
	const before = await runner.resolve(agentId);
	if (process.argv.includes("--upgrade-db")) {
		assert.equal(await runner.store.lifecycleAllowed(), false);
		await delay(1800);
		await runner.maintain();
		assert.ok(await native.getAgent(before.herdrName), "the inherited database cannot reap before drain confirmation");
		if (process.argv.includes("--quarantine-cold")) {
			await native.closePane(before.paneId);
			await runner.store.parkAgent({ agentId, runId: before.currentRunId }, before.paneId, Date.now());
			const unchanged = await runner.resolve(agentId);
			const refused = await spawnHerdrAgent({ ...request, resume: agentId, prompt: "Must not start while quarantined" }, { root, client, runner, signal });
			assert.equal(refused.details.status, "error", refused.text);
			assert.match(refused.text, /lifecycle-upgrade\.mjs/);
			assert.deepEqual(await runner.resolve(agentId), unchanged);
			assert.equal(await native.getAgent(before.herdrName), undefined);
		}
		const command = fileURLToPath(new URL("../../src/herdr/lifecycle-upgrade.mjs", import.meta.url));
		assert.equal(JSON.parse(execFileSync(process.execPath, [command, "--root", root, "--status"], { encoding: "utf8" })).allowed, false);
		assert.equal(JSON.parse(execFileSync(process.execPath, [command, "--root", root, "--confirm-old-workers-stopped"], { encoding: "utf8" })).allowed, true);
	}
	// No further model/tool activity: maintenance alone must retire the finished pane.
	for (let attempt = 0; attempt < 60; attempt++) {
		signal.throwIfAborted();
		if (!process.argv.includes("--self")) await runner.maintain();
		const record = await runner.resolve(agentId);
		if ((record.paneState === "parked" || record.paneClose) && !(await native.getAgent(record.herdrName))) break;
		await delay(173);
	}
	const parked = await runner.resolve(agentId);
	assert.ok(parked.paneState === "parked" || parked.paneClose, JSON.stringify(await native.getAgent(parked.herdrName)));
	assert.equal(await native.getAgent(parked.herdrName), undefined);
	if (temporaryWorkspace) {
		execFileSync(herdr, ["workspace", "close", temporaryWorkspace]);
		temporaryWorkspace = undefined;
	}
	const second = await spawnHerdrAgent({ ...request, resume: agentId, prompt: "What exact token did I ask you to remember? Reply only with it." }, { root, client, runner, signal });
	assert.equal(second.details.status, "completed", second.text);
	assert.ok(second.text.includes(token), second.text);
	const after = await runner.resolve(agentId);
	assert.notEqual(after.paneId, before.paneId);
	assert.equal(after.sessionFile, before.sessionFile);
	assert.equal(after.sessionId, before.sessionId);
	assert.equal(after.parentPaneId, request.paneId);
	assert.equal(after.parentSessionFile, request.sessionFile);
	console.log(JSON.stringify({ status: "passed", firstPane: before.paneId, resumedPane: after.paneId, sameConversation: true, adoptedOwnerPane: after.parentPaneId, deletedWorkspaceFallback: process.argv.includes("--deleted-workspace"), upgradeConfirmed: process.argv.includes("--upgrade-db"), quarantinedColdRefused: process.argv.includes("--quarantine-cold") }));
} finally {
	for (const record of await runner.store.listAgents()) {
		const live = await native.getAgent(record.herdrName).catch(() => undefined);
		if (live?.paneId && (live.session?.split("/").pop() === record.sessionFile.split("/").pop() || live.paneId === record.paneId)) await native.closePane(live.paneId);
	}
	if (temporaryWorkspace) execFileSync(herdr, ["workspace", "close", temporaryWorkspace]);
	await runner.close();
	rmSync(root, { recursive: true, force: true });
}
