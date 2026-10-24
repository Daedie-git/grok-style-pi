import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackendController } from "../src/herdr/backend.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import { HerdrRunner, splitAgentId } from "../src/herdr/runner.ts";
import { HerdrStore, type AgentOwnership } from "../src/herdr/store.ts";

async function finished(store: HerdrStore, cwd: string, id: string, paneId: string, ownership: AgentOwnership = {}) {
	const file = await store.createSession({ type: "session", version: 3, id, cwd });
	const ref = (await store.reserveAgent({ id, herdrName: id, paneId, cwd, type: "test", depth: 1, description: id, prompt: "work", createdAt: new Date().toISOString(), ...ownership }, file, "test-owner", 1))!;
	await store.publish(ref, "work", true, 2);
	const binding = (await store.attach(paneId, file, id))!;
	await store.claimNextCommand(id, binding.token, false);
	await store.recordExecutionEvent(ref, binding.token, { type: "live" }, 3);
	await store.recordExecutionEvent(ref, binding.token, { type: "completed", result: "retained result" }, 4);
	return { ref, record: (await store.findAgent(id))! };
}

test("remote completion delivery follows a cold-resumed parent's session across two independent stores", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-owner-notices-"));
	const local = new HerdrRunner({ root: join(root, "local"), client: {} as HerdrClient });
	const remote = new HerdrRunner({ root: join(root, "remote"), client: {} as HerdrClient, machine: "target" });
	t.after(async () => { await local.close(); await remote.close(); rmSync(root, { recursive: true, force: true }); });
	const parent = await finished(local.store, root, "parent", "w1:p2");
	await local.store.acknowledgeNotice(parent.ref.runId);
	const ownership = { parentPaneId: "host/w1:p2", parentSessionFile: parent.record.sessionFile, parentMachine: local.machineId };
	const child = await finished(remote.store, root, "remote-child", "w9:p2", ownership);
	const legacy = await finished(remote.store, root, "legacy-child", "w9:p3", { ...ownership, parentMachine: undefined });
	await local.store.rebindPane(parent.record.id, parent.ref.runId, "w2:p20", parent.record.herdrName);
	const destination = "host/w2:p20";
	assert.equal((await remote.store.findAgent(child.record.id))?.parentPaneId, "host/w1:p2", "the target store was not rewritten from another machine");
	assert.equal((await remote.store.notices(destination, parent.record.sessionFile, local.machineId)).length, 2);
	assert.deepEqual((await remote.store.notices(destination, parent.record.sessionFile, "another-machine")).map((notice) => notice.agentId), [legacy.record.id]);
	assert.equal((await remote.store.notices("renamed-host/w2:p20", parent.record.sessionFile, local.machineId)).length, 1, "hardware identity survives a host rename; unverified legacy host identities do not");
	assert.equal((await remote.store.notices("host/w1:p2", "/a-new-session-in-the-old-pane.jsonl", local.machineId)).length, 0);
	assert.equal((await remote.store.notices("w2:p20", parent.record.sessionFile)).length, 0, "local and remote ownership namespaces do not mix");
	const controller = createBackendController({
		async route(id) { return { id: splitAgentId(id).id, runner: remote }; },
		async spawn() { throw new Error("unused"); }, content: () => "retained result", assertActive() {}, paneChild: () => false,
	});
	const delivered: string[] = [];
	controller.handle.onNotice((notice) => { delivered.push(notice.noticeId); });
	await controller.deliver(remote, destination, parent.record.sessionFile, local.machineId);
	assert.deepEqual(new Set(delivered), new Set([child.ref.runId, legacy.ref.runId]));
	for (const notice of delivered) await controller.handle.acknowledge(notice);
	assert.deepEqual(await remote.store.notices(destination, parent.record.sessionFile, local.machineId), []);
});
