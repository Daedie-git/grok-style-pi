import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { machinesFromList, tabFromCreate, panesFromList, type HerdrClient } from "../src/herdr/client.ts";
import { createChildSession, type ChildMessenger } from "../src/herdr/child.ts";
import { createHerdrSubagents, remoteWorkerEntry } from "../src/herdr/extension.ts";
import { HerdrRunner, qualifiedAgentId, splitAgentId } from "../src/herdr/runner.ts";
import { HerdrStore, sshChannel, workerChannel, type StoreChannelFactory } from "../src/herdr/store.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const ENTRY = fileURLToPath(new URL("../src/herdr/worker-entry.mjs", import.meta.url));

/** An `ssh` on PATH that runs the remote command locally, so quoting and stdio match real SSH. */
function fakeSsh(t: TestContext, script = 'for last; do :; done\nexec sh -c "$last"\n') {
	const dir = mkdtempSync(join(tmpdir(), "herdr-ssh-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\n${script}`);
	chmodSync(join(bin, "ssh"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	t.after(() => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); });
	return { dir, args: () => readFileSync(join(dir, "args"), "utf8").trim().split("\n") };
}

function remoteClient() {
	const events: string[] = [];
	const live = new Set<string>();
	let sequence = 2;
	const client: HerdrClient = {
		split: async (options) => { events.push(`split:${options.paneId}`); return { paneId: `w9:p${sequence++}` }; },
		startPi: async (options) => { events.push(`start:${options.name}:${options.paneId}`); live.add(options.name); },
		closePane: async (paneId) => { events.push(`close:${paneId}`); },
		isAlive: async (name) => live.has(name),
		showLabel: async () => undefined,
		listAgents: async () => [],
		listPanes: async () => [{ paneId: "w9:p1", tabId: "w9:t1", workspaceId: "w9", cwd: "/laptop/project" }],
		createTab: async (options) => { events.push(`tab:${options.workspaceId}:${options.cwd}`); return { tabId: `w9:t${sequence++}`, paneId: `w9:p${sequence++}`, workspaceId: "w9" }; },
	};
	return { client, events, live };
}

test("the store worker serves the same protocol over SSH stdio", async (t) => {
	const ssh = fakeSsh(t);
	const root = mkdtempSync(join(tmpdir(), "herdr remote root "));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new HerdrStore(sshChannel({ target: "laptop", entry: ENTRY, root }));
	try {
		assert.deepEqual(await store.listAgents(), []);
		const session = await store.createSession({ type: "session", cwd: "/laptop/project" });
		assert.ok(session.startsWith(join(root, "sessions")));
		assert.equal(JSON.parse(readFileSync(session, "utf8")).cwd, "/laptop/project");
		await assert.rejects(store.read({ agentId: "missing", runId: "none" }), /Run not found/);
	} finally { await store.close(); }
	const args = ssh.args();
	const split = args.indexOf("--");
	assert.deepEqual(args.slice(split - 6, split + 2), ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--", "laptop"].slice(1));
	assert.equal(args[0], "-T");
	assert.match(args[split + 2], new RegExp(`'${root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`), "a root with spaces is quoted for the remote shell");
});

test("a dropped SSH channel fails pending and later calls with its diagnostics", async (t) => {
	fakeSsh(t, 'echo "Permission denied (publickey)" >&2\nexit 255\n');
	const store = new HerdrStore(sshChannel({ target: "laptop", entry: ENTRY }));
	try {
		await assert.rejects(store.listAgents(), /laptop closed \(255\): Permission denied/);
		assert.equal(store.failed, true);
		await assert.rejects(store.listAgents(), /Permission denied/);
	} finally { await store.close(); }
});

test("the stdio worker skips stray lines instead of exiting", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-stdio-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, root], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout });
	child.stdin.write("Last login: yesterday\nnull\n{\"id\":7,\"operation\":\"listAgents\",\"args\":[]}\n");
	const [line] = await once(lines, "line");
	assert.deepEqual(JSON.parse(line), { id: 7, value: [] });
	child.stdin.end();
	await once(child, "close");
});

test("ending the stdio channel retires the launch owners it carried, as after a parent crash", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-crash-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, root], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout });
	const owner = "4242:launch:desk-machine";
	const task = { id: "orphan", herdrName: "orphan", paneId: "", type: "Explore", description: "orphan", prompt: "x", depth: 1, createdAt: new Date().toISOString() };
	child.stdin.write(JSON.stringify({ id: 1, operation: "reserveAgent", args: [task, join(root, "orphan.jsonl"), owner, Date.now()] }) + "\n");
	await once(lines, "line");
	// A crashed parent drops its SSH connection, which reaches the worker as end of input.
	child.stdin.end();
	await once(child, "close");
	const store = new HerdrStore(root);
	try { assert.equal(await store.ownerRetired(owner), true); }
	finally { await store.close(); }
});

test("closing a store settles calls stalled on its channel", async () => {
	const store = new HerdrStore(() => ({ post() {}, hold() {}, close: async () => {} }));
	const stalled = store.listAgents();
	await store.close();
	await assert.rejects(stalled, /store closed/);
});

test("machine listings and remote placement facts are parsed", () => {
	assert.deepEqual(machinesFromList([
		{ id: "m1", label: "laptop", target: "ssh://aim@laptop:2222", session: "default", enabled: true, selected: false },
		{ id: "broken" },
	]), [{ id: "m1", label: "laptop", target: "ssh://aim@laptop:2222", enabled: true }]);
	assert.throws(() => machinesFromList({}), /array/);
	assert.deepEqual(tabFromCreate({ result: { tab: { tab_id: "w2:t3", workspace_id: "w2" }, root_pane: { pane_id: "w2:p4" } } }), { tabId: "w2:t3", paneId: "w2:p4", workspaceId: "w2" });
	assert.deepEqual(panesFromList({ result: { panes: [{ pane_id: "w2:p4", tab_id: "w2:t3", workspace_id: "w2", cwd: "/x" }] } }), [{ paneId: "w2:p4", tabId: "w2:t3", workspaceId: "w2", cwd: "/x" }]);
	assert.equal(qualifiedAgentId("review", "laptop"), "review@laptop");
	assert.deepEqual(splitAgentId("review@Build machine"), { id: "review", machine: "Build machine" });
	assert.deepEqual(splitAgentId("review"), { id: "review" });
	assert.equal(remoteWorkerEntry({ GROK_HERDR_REMOTE_PACKAGE: "/opt/grok-style-pi/" }), "/opt/grok-style-pi/src/herdr/worker-entry.mjs");
});

test("a launch owned on another host is never recovered by PID", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-host-"));
	const remote = remoteClient();
	const runner = new HerdrRunner({ root, client: remote.client });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	// PID 1 here is unrelated to the PID the other host recorded.
	const owner = "999999:launch:another-machine-id";
	const task = { id: "orphan", herdrName: "orphan", paneId: "", type: "Explore", description: "orphan", prompt: "x", depth: 1, createdAt: new Date().toISOString() };
	const ref = (await runner.store.reserveAgent(task, join(root, "orphan.jsonl"), owner, Date.now()))!;
	await runner.store.recordLaunch(ref, owner, "starting-pi", { paneId: "w9:orphan", tabId: "w9:t1", column: "left" }, Date.now());
	await runner.maintain();
	await runner.reconcile();
	assert.ok(!remote.events.includes("close:w9:orphan"));
	assert.equal((await runner.read(ref)).phase, "queued");
});

test("Agent with machine runs in that machine's panes and store, and routes results by qualified ID", { timeout: 20_000 }, async (t) => {
	fakeSsh(t);
	const localRoot = mkdtempSync(join(tmpdir(), "herdr-local-"));
	const remoteRoot = mkdtempSync(join(tmpdir(), "herdr-laptop-"));
	t.after(() => { rmSync(localRoot, { recursive: true, force: true }); rmSync(remoteRoot, { recursive: true, force: true }); });
	const remote = remoteClient();
	const localEvents: string[] = [];
	const local: HerdrClient = new Proxy({} as HerdrClient, { get: (_target, name) => async () => { localEvents.push(String(name)); throw new Error("local Herdr must not be used"); } });
	let opens = 0;
	let clock = Date.now();
	let drop = () => {};
	const notices: string[] = [];
	const tools: any[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const queued: any[] = [];
	const saved: any[] = [];
	const pi = {
		registerTool(tool: any) { tools.push(tool); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		sendMessage(message: any) { queued.push(message); },
		sendUserMessage() {},
		appendEntry(customType: string, data: unknown) { saved.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	createHerdrSubagents({
		root: localRoot, client: local, agentDir: localRoot, hostname: "desk", now: () => clock,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" },
		machineClient: (machine) => { assert.equal(machine, "laptop"); return remote.client; },
		machineChannel: async () => {
			opens++;
			if (opens === 1) return sshChannel({ target: "laptop", entry: ENTRY, root: remoteRoot });
			// Later channels can be dropped on demand, like a lost SSH connection.
			const factory: StoreChannelFactory = (events) => { drop = () => events.fail(new Error("connection lost")); return workerChannel(remoteRoot)(events); };
			return factory;
		},
	})(pi);
	// Agent definitions come from this session's directory, not the remote one.
	mkdirSync(join(localRoot, ".pi", "agents"), { recursive: true });
	writeFileSync(join(localRoot, ".pi", "agents", "Explore.md"), "---\ntools: read\n---\nOnly read the build log.");
	const ctx = { cwd: localRoot, isIdle: () => true, abort() {}, ui: { notify(text: string) { notices.push(text); } }, sessionManager: { getEntries: () => saved, getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "parent" } };
	const [agentTool, resultTool] = tools;
	assert.match(agentTool.parameters.properties.machine.description, /Only when the user asks/);
	await handlers.get("session_start")!({}, ctx);
	try {
		const started = await agentTool.execute("call", { prompt: "Check the build", description: "Check build", subagent_type: "Explore", machine: "laptop", machine_cwd: "/laptop/project" }, undefined, undefined, ctx);
		const agentId = started.details.agentId as string;
		assert.match(agentId, /^explore@laptop$/);
		assert.match(started.content[0].text, /Pane: w9:p\d+ on laptop/);
		assert.deepEqual(localEvents, []);
		assert.ok(remote.events.some((event) => event === "tab:w9:/laptop/project"), "the tab opens in the workspace already at that directory");
		assert.deepEqual(saved.map((entry) => entry.customType), ["herdr-remote-machine"]);

		// The child on the laptop sees an ordinary record in its own store.
		const laptop = new HerdrStore(remoteRoot);
		t.after(() => laptop.close());
		const record = (await laptop.findAgent("explore"))!;
		assert.equal(record.parentPaneId, "desk/w1:p1");
		assert.equal(record.instructions, "Only read the build log.");
		assert.deepEqual(record.allowedTools, ["read"]);
		assert.ok(record.sessionFile.startsWith(remoteRoot));
		assert.ok(existsSync(record.sessionFile));
		const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8")).id;
		let streaming = false;
		let assistant = "";
		const sent: string[] = [];
		const messenger: ChildMessenger = {
			sendUserMessage(text) { sent.push(text); }, abort() {}, assistantText: () => assistant,
			streaming: () => streaming, clearAssistant() { assistant = ""; },
		};
		const child = (await createChildSession(laptop, record.paneId, { sessionFile: record.sessionFile, sessionId }, messenger))!;
		await child.poll();
		assert.equal(sent.length, 1);
		await child.input(sent[0]);
		streaming = true;
		await child.noteLive();
		assistant = "Build is green";
		streaming = false;
		await child.noteSettled("completed");

		await eventually(() => queued.length === 1);
		assert.equal(queued[0].details.agentId, "explore@laptop");
		assert.equal(queued[0].details.machine, "laptop");
		assert.match(queued[0].content, /agent_id "explore@laptop"/);
		const result = await resultTool.execute("call", { agent_id: agentId }, undefined, undefined, ctx);
		assert.match(result.content[0].text, /Build is green/);
		assert.match(result.content[0].text, /Agent: explore@laptop/);
		// Receipts are acknowledged in the machine's store.
		saved.push({ type: "custom_message", ...queued[0] });
		await eventually(async () => (await laptop.notices("desk/w1:p1")).length === 0);
		await assert.rejects(agentTool.execute("call", { prompt: "x", description: "x", subagent_type: "Explore", machine: "laptop", inherit_context: true }, undefined, undefined, ctx), /inherit_context/);

		// Reload reopens the machine this session used.
		await handlers.get("session_shutdown")!({ reason: "reload" });
		await handlers.get("session_start")!({}, ctx);
		await eventually(() => opens === 2, "the used machine was not reopened after reload");
		await agentTool.execute("call", { prompt: "y", description: "Second", subagent_type: "Explore", machine: "laptop", machine_cwd: "/laptop/project" }, undefined, undefined, ctx);
		const second = (await laptop.launches()).find((launch) => launch.agentId !== "explore")!;
		// A dropped channel is reported, replaced, and the new channel retires the owner it lost.
		drop();
		await eventually(() => notices.some((text) => text.includes("laptop: connection lost")), "the lost channel was not reported");
		assert.equal(opens, 2, "reconnects wait out the retry interval");
		clock += 10_001;
		await eventually(() => opens === 3, "the dropped machine was not reopened");
		await eventually(() => laptop.ownerRetired(second.owner), "the lost owner was not retired");
	} finally {
		await handlers.get("session_shutdown")!({ reason: "quit" });
	}
});

async function eventually(predicate: () => boolean | Promise<boolean>, message = "condition did not become true") {
	for (let count = 0; count < 300; count++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

test("a stalled machine never delays local notices, and a failed first launch still records its machine", { timeout: 20_000 }, async (t) => {
	const localRoot = mkdtempSync(join(tmpdir(), "herdr-stall-local-"));
	const brokenRoot = mkdtempSync(join(tmpdir(), "herdr-stall-broken-"));
	const local = remoteClient();
	const runner = new HerdrRunner({ root: localRoot, client: local.client });
	t.after(async () => { await runner.close(); rmSync(localRoot, { recursive: true, force: true }); rmSync(brokenRoot, { recursive: true, force: true }); });
	let stalledPosts = 0;
	const stalled: StoreChannelFactory = () => ({ post() { stalledPosts++; }, hold() {}, close: async () => {} });
	const broken = remoteClient();
	broken.client.startPi = async () => { throw new Error("pi is not installed there"); };
	const tools: any[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const queued: any[] = [];
	const saved: any[] = [{ type: "custom", customType: "herdr-remote-machine", data: { machine: "laptop" } }];
	const pi = {
		registerTool(tool: any) { tools.push(tool); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		sendMessage(message: any) { queued.push(message); },
		sendUserMessage() {},
		appendEntry(customType: string, data: unknown) { saved.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	createHerdrSubagents({
		root: localRoot, client: local.client, agentDir: localRoot, hostname: "desk",
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
		machineClient: (machine) => machine === "broken" ? broken.client : local.client,
		machineChannel: async (machine) => machine === "broken" ? workerChannel(brokenRoot) : stalled,
	})(pi);
	const ctx = { cwd: localRoot, isIdle: () => true, abort() {}, ui: { notify() {} }, sessionManager: { getEntries: () => saved, getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "parent" } };
	await handlers.get("session_start")!({}, ctx);
	try {
		await eventually(() => stalledPosts > 0, "the saved machine was not reopened");
		// Finish a local run only after the machine's poll has stalled.
		const ref = await runner.spawn({ prompt: "p", description: "Local", subagentType: "Explore", runInBackground: true, cwd: localRoot, paneId: "w1:p1" });
		const record = await runner.resolve(ref.agentId);
		const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8")).id;
		let streaming = false;
		const sent: string[] = [];
		const child = (await createChildSession(runner.store, record.paneId, { sessionFile: record.sessionFile, sessionId }, {
			sendUserMessage(text) { sent.push(text); }, abort() {}, assistantText: () => "local done",
			streaming: () => streaming, clearAssistant() {},
		}))!;
		await child.poll();
		await child.input(sent[0]);
		streaming = true;
		await child.noteLive();
		streaming = false;
		await child.noteSettled("completed");
		await eventually(() => queued.some((message) => message.details.agentId === ref.agentId), "a stalled machine blocked local notices");

		await assert.rejects(tools[0].execute("call", { prompt: "x", description: "Broken", subagent_type: "Explore", machine: "broken", machine_cwd: "/x" }, undefined, undefined, ctx), /pi is not installed/);
		assert.ok(saved.some((entry) => entry.customType === "herdr-remote-machine" && entry.data.machine === "broken"));
	} finally {
		await handlers.get("session_shutdown")!({ reason: "quit" });
	}
});
