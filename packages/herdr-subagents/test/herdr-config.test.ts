import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { machineDefaultCwd, readMachineSettings } from "../src/herdr/config.ts";

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
