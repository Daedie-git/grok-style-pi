import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { machineDefaultCwd, machineWorkerEntry, readHerdrSettings, readMachineSettings, type MachineSettings } from "../src/herdr/config.ts";
import { parseAgentFile } from "../src/herdr/agent-file.ts";
import { createHerdrSubagents, type HerdrBackendHandle } from "../src/herdr/extension.ts";
import { HerdrRunner, type SpawnRequest } from "../src/herdr/runner.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const profiles = [{ id: "m1", label: "lappy", target: "aim-laptop", enabled: true }];

test("machine defaults accept Windows paths and resolve both labels and IDs", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.deepEqual(readMachineSettings(dir), {});
	const path = join(dir, "herdr-subagents.json");
	writeFileSync(path, JSON.stringify({ machines: { lappy: { cwd: " C:/git " } } }));
	const settings = readMachineSettings(dir);
	assert.equal(machineDefaultCwd("lappy", profiles, settings), "C:/git");
	assert.equal(machineDefaultCwd("m1", profiles, settings), "C:/git");
	assert.equal(machineDefaultCwd("other", profiles, settings), undefined);
	settings.m1 = { cwd: "C:/work" };
	assert.equal(machineDefaultCwd("lappy", profiles, settings), "C:/work");
	assert.equal(machineDefaultCwd("m1", profiles, settings), "C:/work");
	assert.equal(machineDefaultCwd("toString", profiles, {}), undefined);
	const duplicate = [...profiles, { ...profiles[0], id: "m2" }];
	assert.equal(machineDefaultCwd("m2", duplicate, settings), undefined);
	for (const value of ["{", "null", '{"machines":[]}', '{"machines":{"lappy":{"cwd":""}}}']) {
		writeFileSync(path, value);
		assert.throws(() => readMachineSettings(dir), /Invalid .*herdr-subagents\.json/);
	}
});

test("machine worker entries share directory selector precedence and refuse ambiguous labels", () => {
	const settings: Record<string, MachineSettings> = {
		lappy: { cwd: "C:/git", workerEntry: "C:/label/worker-entry.mjs" },
	};
	for (const selector of ["lappy", "m1"]) assert.equal(machineWorkerEntry(selector, profiles, settings), "C:/label/worker-entry.mjs");
	settings.m1 = { cwd: "C:/work", workerEntry: "C:/id/worker-entry.mjs" };
	for (const selector of ["lappy", "m1"]) assert.equal(machineWorkerEntry(selector, profiles, settings), "C:/id/worker-entry.mjs");
	const duplicate = [...profiles, { ...profiles[0], id: "m2", enabled: false }];
	assert.equal(machineWorkerEntry("lappy", duplicate, settings), undefined);
	assert.equal(machineDefaultCwd("lappy", duplicate, settings), undefined);
	assert.equal(machineWorkerEntry("m2", duplicate, settings), undefined);
	assert.equal(machineWorkerEntry("m1", duplicate, settings), "C:/id/worker-entry.mjs");
	assert.equal(machineWorkerEntry("toString", profiles, settings), undefined);
	assert.equal(machineWorkerEntry("missing", profiles, settings), undefined);
	assert.equal(machineWorkerEntry("lappy", [], settings), "C:/label/worker-entry.mjs", "settings still work when the listing is unavailable");
	settings.m1 = { cwd: "C:/work" };
	assert.equal(machineWorkerEntry("lappy", profiles, settings), undefined, "an ID settings object overrides the label object, as for cwd");
});

test("machine worker entries preserve explicit paths and reject invalid overrides", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "herdr-subagents.json");
	writeFileSync(path, JSON.stringify({ machines: { lappy: { cwd: "C:/git", workerEntry: " C:/git/grok-style-pi/src/herdr/worker-entry.mjs " } } }));
	assert.deepEqual(readMachineSettings(dir).lappy, { cwd: "C:/git", workerEntry: "C:/git/grok-style-pi/src/herdr/worker-entry.mjs" });
	for (const workerEntry of ["", "  ", null, false, 7, [], {}]) {
		writeFileSync(path, JSON.stringify({ machines: { lappy: { cwd: "C:/git", workerEntry } } }));
		assert.throws(() => readMachineSettings(dir), /machines\.lappy\.workerEntry must be a nonempty string/);
	}
	writeFileSync(path, JSON.stringify({ machines: { lappy: { workerEntry: "/worker.mjs" } } }));
	const workerOnly = readMachineSettings(dir);
	assert.deepEqual(workerOnly.lappy, { workerEntry: "/worker.mjs" });
	assert.equal(machineWorkerEntry("m1", profiles, workerOnly), "/worker.mjs");
	assert.equal(machineDefaultCwd("m1", profiles, workerOnly), undefined, "worker configuration must not introduce a new project directory default");
	writeFileSync(path, JSON.stringify({ machines: { lappy: {} } }));
	assert.throws(() => readMachineSettings(dir), /machines\.lappy must set cwd or workerEntry/);
	for (const cwd of ["", "  ", null, false, 7, [], {}]) {
		writeFileSync(path, JSON.stringify({ machines: { lappy: { cwd, workerEntry: "/worker.mjs" } } }));
		assert.throws(() => readMachineSettings(dir), /machines\.lappy\.cwd/);
	}
});

test("closeWhenDone defaults to true and accepts only booleans", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.deepEqual(readHerdrSettings(dir), { machines: {}, closeWhenDone: true });
	const path = join(dir, "herdr-subagents.json");
	for (const value of [{}, { machines: {} }, { closeWhenDone: false }, { closeWhenDone: true, machines: { lappy: { cwd: "C:/git" } } }]) {
		writeFileSync(path, JSON.stringify(value));
		assert.equal(readHerdrSettings(dir).closeWhenDone, "closeWhenDone" in value ? value.closeWhenDone : true);
		assert.deepEqual(readMachineSettings(dir), readHerdrSettings(dir).machines);
	}
	for (const value of [0, "true", null, {}, []]) {
		writeFileSync(path, JSON.stringify({ closeWhenDone: value }));
		assert.throws(() => readHerdrSettings(dir), /closeWhenDone must be true or false/);
	}
});

test("agent-file keep distinguishes pinned, explicitly unpinned and absent defaults", () => {
	assert.equal(parseAgentFile("---\nkeep: true\n---\nTask").keep, true);
	assert.equal(parseAgentFile("---\nkeep: false\n---\nTask").keep, false);
	assert.equal(parseAgentFile("Task").keep, undefined);
	assert.equal(parseAgentFile("---\nkeep: yes\n---\nTask").keep, undefined);
});

test("standalone Agent forwards keep without replacing an absent agent-file default", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const tools: any[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		registerTool(tool: unknown) { tools.push(tool); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI;
	const requests: SpawnRequest[] = [];
	t.mock.method(HerdrRunner.prototype, "spawn", async (request: SpawnRequest) => {
		requests.push(request);
		throw new Error("captured spawn");
	});
	await createHerdrSubagents({ root: dir, agentDir: dir, env: {}, listMachines: async () => [] })(pi);
	t.after(() => handlers.get("session_shutdown")!({ reason: "reload" }));
	const agent = tools.find((tool) => tool.name === "Agent");
	assert.equal(agent.parameters.properties.keep.type, "boolean");
	const ctx = { cwd: dir, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext;
	for (const keep of [true, false, undefined]) {
		await assert.rejects(agent.execute("call", { prompt: "Task", description: "Task", subagent_type: "Explore", keep }, undefined, undefined, ctx), /captured spawn/);
		assert.equal(requests.at(-1)?.keep, keep);
	}
});

test("headless entrypoint forwards backend keep requests", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI;
	let backend!: HerdrBackendHandle;
	let captured: SpawnRequest | undefined;
	t.mock.method(HerdrRunner.prototype, "spawn", async (request: SpawnRequest) => {
		captured = request;
		throw new Error("captured backend spawn");
	});
	await createHerdrSubagents({ mode: "backend", onBackend(handle) { backend = handle; }, root: dir, agentDir: dir, env: {}, listMachines: async () => [] })(pi);
	t.after(() => handlers.get("session_shutdown")!({ reason: "reload" }));
	const ctx = { cwd: dir, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext;
	for (const keep of [true, false, undefined]) {
		await assert.rejects(backend.spawn({ prompt: "Task", description: "Task", subagentType: "Explore", runInBackground: true, cwd: dir, keep }, ctx), /captured backend spawn/);
		assert.equal(captured?.keep, keep);
	}
});
