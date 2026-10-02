import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findHerdrMachine, machinesFromList, tabFromCreate, panesFromList, type HerdrClient } from "../src/herdr/client.ts";
import { createChildSession, type ChildMessenger } from "../src/herdr/child.ts";
import { createHerdrSubagents, machineGuidance, remoteWorkerEntry, samePath } from "../src/herdr/extension.ts";
import { HerdrRunner, qualifiedAgentId, splitAgentId } from "../src/herdr/runner.ts";
import { HerdrStore, sshChannel, workerChannel, type StoreChannelFactory } from "../src/herdr/store.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const ENTRY = fileURLToPath(new URL("../src/herdr/worker-entry.mjs", import.meta.url));
// Remote stores check machine_cwd on their own machine, which in these tests is this one.
const PROJECT = mkdtempSync(join(tmpdir(), "herdr-laptop-project-"));
process.on("exit", () => rmSync(PROJECT, { recursive: true, force: true }));

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
		listPanes: async () => [{ paneId: "w9:p1", tabId: "w9:t1", workspaceId: "w9", cwd: PROJECT }],
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

test("a reply that hits a closed connection still retires the channel's owners", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-epipe-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, root], { stdio: ["pipe", "pipe", "inherit"] });
	const closed = once(child, "close");
	// The reading end goes away while input stays open, so only the failed reply can end the channel.
	child.stdout.destroy();
	const owner = "4343:launch:desk-machine";
	const task = { id: "orphan", herdrName: "orphan", paneId: "", type: "Explore", description: "orphan", prompt: "x", depth: 1, createdAt: new Date().toISOString() };
	child.stdin.write(JSON.stringify({ id: 1, operation: "reserveAgent", args: [task, join(root, "orphan.jsonl"), owner, Date.now()] }) + "\n");
	await closed;
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
	assert.equal(machineGuidance([]), "", "no saved machines, or an older Herdr, adds nothing");
	assert.equal(machineGuidance([{ id: "m1", label: "lappy", target: "lappy", enabled: true }]), " Saved machines: lappy. Pass the name shown first as machine.");
	// Repeated labels are ambiguous to herdr --machine, even when one profile is disabled.
	assert.equal(machineGuidance([
		{ id: "m1", label: "laptop", target: "aim@lappy", enabled: true },
		{ id: "m2", label: "laptop", target: "aim@old-lappy", enabled: false },
		{ id: "m3", label: "build", target: "build", enabled: true },
	]), " Saved machines: m1 (label laptop, aim@lappy), build. Pass the name shown first as machine.");
	assert.equal(remoteWorkerEntry({ GROK_HERDR_REMOTE_PACKAGE: "/opt/grok-style-pi/" }), "/opt/grok-style-pi/src/herdr/worker-entry.mjs");
});

test("a remote package with another protocol is refused before any launch, with which side to update", async () => {
	// A channel whose worker answers remoteProtocol as an older or newer package would. A refused store gets no other call.
	const operations: string[] = [];
	const remote = (answer: { value?: unknown; error?: string }): StoreChannelFactory => (events) => ({
		post(request) {
			operations.push(request.operation);
			if (request.operation === "remoteProtocol") queueMicrotask(() => events.reply({ id: request.id, ...answer }));
		},
		hold() {}, close: async () => {},
	});
	const answers: Record<string, { value?: unknown; error?: string }> = {
		old: { error: "Unknown Herdr control operation" }, behind: { value: 0 }, ahead: { value: 999 },
	};
	const tools: any[] = [];
	const pi = { registerTool(tool: any) { tools.push(tool); }, on() {}, appendEntry() {} } as unknown as ExtensionAPI;
	await createHerdrSubagents({
		root: "", client: remoteClient().client, agentDir: "", hostname: "desk", env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
		machineClient: () => remoteClient().client, machineChannel: async (machine) => remote(answers[machine]), listMachines: async () => [],
	})(pi);
	const ctx = { cwd: PROJECT, sessionManager: { getSessionFile: () => undefined } };
	const launch = (machine: string) => tools[0].execute("call", { prompt: "x", description: "x", subagent_type: "Explore", machine, machine_cwd: PROJECT }, undefined, undefined, ctx);
	await assert.rejects(launch("old"), /old runs an older grok-style-pi\. Update grok-style-pi on old/);
	await assert.rejects(launch("behind"), /behind speaks remote protocol 0; this machine speaks \d+\. Update grok-style-pi on behind/);
	await assert.rejects(launch("ahead"), /Update grok-style-pi on this machine/);
	assert.deepEqual(operations, ["remoteProtocol", "remoteProtocol", "remoteProtocol"]);
});

test("a failed or superseded open never removes or outlives its replacement, and each machine's failure is reported once", async () => {
	// Channels answer the protocol check only when released, so opens can be raced against shutdown and each other.
	const channels: Array<{ machine: string; closed: boolean; answer(value: unknown): void }> = [];
	const channelFor = (machine: string): StoreChannelFactory => (events) => {
		const entry = { machine, closed: false, answer(_value: unknown) {} };
		channels.push(entry);
		return {
			post(request) {
				if (request.operation === "remoteProtocol") entry.answer = (value) => events.reply({ id: request.id, value });
				else queueMicrotask(() => events.reply({ id: request.id, value: request.operation === "notices" ? [] : undefined }));
			},
			hold() {}, close: async () => { entry.closed = true; },
		};
	};
	const tools: any[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const notices: string[] = [];
	const saved: any[] = [];
	const pi = {
		registerTool(tool: any) { tools.push(tool); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		sendMessage() {}, sendUserMessage() {},
		appendEntry(customType: string, data: unknown) { saved.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	let clock = Date.now();
	const localRoot = mkdtempSync(join(tmpdir(), "herdr-race-"));
	await createHerdrSubagents({
		root: localRoot, client: remoteClient().client, agentDir: localRoot, hostname: "desk", now: () => clock,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, listMachines: async () => [],
		machineClient: () => remoteClient().client, machineChannel: async (machine) => channelFor(machine),
	})(pi);
	const ctx = { cwd: localRoot, isIdle: () => true, abort() {}, ui: { notify(text: string) { notices.push(text); } }, sessionManager: { getEntries: () => saved, getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "parent" } };
	try {
		// Shutdown closes an open whose check is stalled; a later answer must not leave it running untracked.
		await handlers.get("session_start")!({}, ctx);
		const first = tools[0].execute("call", { prompt: "x", description: "x", subagent_type: "Explore", machine: "a", machine_cwd: PROJECT }, undefined, undefined, ctx);
		await eventually(() => channels.length === 1);
		await handlers.get("session_shutdown")!({ reason: "quit" });
		await assert.rejects(first);
		assert.ok(channels[0].closed, "shutdown closed the stalled open");
		channels[0].answer(1);

		// Two recorded machines with mismatched packages each report once across reconnect cycles.
		saved.push({ type: "custom", customType: "herdr-remote-machine", data: { machine: "b" } }, { type: "custom", customType: "herdr-remote-machine", data: { machine: "c" } });
		await handlers.get("session_start")!({}, ctx);
		for (let cycle = 0; cycle < 3; cycle++) {
			const opened = channels.length;
			await eventually(() => channels.length === opened + 2, "both machines reconnect");
			for (const channel of channels.slice(opened)) channel.answer(0);
			await eventually(() => channels.slice(opened).every((channel) => channel.closed));
			clock += 10_001;
		}
		assert.equal(notices.filter((text) => /b speaks remote protocol 0/.test(text)).length, 1);
		assert.equal(notices.filter((text) => /c speaks remote protocol 0/.test(text)).length, 1);
	} finally {
		await handlers.get("session_shutdown")!({ reason: "quit" });
		rmSync(localRoot, { recursive: true, force: true });
	}
	assert.ok(channels.every((channel) => channel.closed), "no channel outlives shutdown");
});

test("a Herdr without saved machines explains the upgrade instead of its raw CLI error", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-old-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "herdr");
	// Herdr 0.8 output for `herdr machine list --json`.
	writeFileSync(bin, "#!/bin/sh\necho 'unknown command: machine' >&2\necho \"run 'herdr --help' for usage\" >&2\nexit 2\n");
	chmodSync(bin, 0o755);
	await assert.rejects(findHerdrMachine("lappy", { HERDR_BIN_PATH: bin }), /need Herdr 0\.9\.1 or later.*Do not work around this/s);
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

test("machine_cwd matches a Windows pane by either separator and case, and POSIX paths exactly", () => {
	assert.ok(samePath("C:\\Git\\Project\\", "c:/git/project"));
	assert.ok(samePath("\\\\HOST\\Share\\Project", "//host/share/project"));
	assert.ok(samePath("//HOST/Share/Project", "\\\\host\\share\\project"));
	assert.ok(samePath("/home/aim/project/", "/home/aim/project"));
	assert.ok(samePath("/", "/"));
	assert.ok(!samePath("/project/foo\\bar", "/project/foo/bar"), "a POSIX backslash is part of the name");
	assert.ok(!samePath("/home/aim/Project", "/home/aim/project"));
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
	await createHerdrSubagents({
		root: localRoot, client: local, agentDir: localRoot, hostname: "desk", now: () => clock,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" },
		machineClient: (machine) => { assert.equal(machine, "laptop"); return remote.client; },
		listMachines: async () => [
			{ id: "m1", label: "laptop", target: "aim@lappy.local", enabled: true },
			{ id: "m2", label: "old", target: "old", enabled: false },
		],
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
	assert.match(agentTool.description, /Saved machines: laptop \(aim@lappy\.local\)\. Pass the name shown first as machine\.$/, "the model can map a casual name to the saved label");
	await handlers.get("session_start")!({}, ctx);
	try {
		const started = await agentTool.execute("call", { prompt: "Check the build", description: "Check build", subagent_type: "Explore", machine: "laptop", machine_cwd: PROJECT }, undefined, undefined, ctx);
		const agentId = started.details.agentId as string;
		assert.match(agentId, /^explore@laptop$/);
		assert.match(started.content[0].text, /Pane: w9:p\d+ on laptop/);
		assert.deepEqual(localEvents, []);
		assert.ok(remote.events.some((event) => event === `tab:w9:${PROJECT}`), "the tab opens in the workspace already at that directory");
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
		// A directory missing on the machine fails before any pane opens, naming where that machine's panes are.
		const before = remote.events.length;
		await assert.rejects(
			agentTool.execute("call", { prompt: "x", description: "x", subagent_type: "Explore", machine: "laptop", machine_cwd: "/home/aim/git/missing" }, undefined, undefined, ctx),
			(error: Error) => error.message.includes("/home/aim/git/missing does not exist on laptop") && error.message.includes(`open in: ${PROJECT}`),
		);
		// A relative path would be checked against the worker's directory, not the pane's.
		await assert.rejects(
			agentTool.execute("call", { prompt: "x", description: "x", subagent_type: "Explore", machine: "laptop", machine_cwd: "." }, undefined, undefined, ctx),
			/machine_cwd \. is not an absolute path on laptop/,
		);
		assert.equal(remote.events.length, before);
		await assert.rejects(agentTool.execute("call", { prompt: "x", description: "x", subagent_type: "Explore", machine: "laptop", inherit_context: true }, undefined, undefined, ctx), /inherit_context/);

		// Reload reopens the machine this session used.
		await handlers.get("session_shutdown")!({ reason: "reload" });
		await handlers.get("session_start")!({}, ctx);
		await eventually(() => opens === 2, "the used machine was not reopened after reload");
		await agentTool.execute("call", { prompt: "y", description: "Second", subagent_type: "Explore", machine: "laptop", machine_cwd: PROJECT }, undefined, undefined, ctx);
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
	await createHerdrSubagents({
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

		await assert.rejects(tools[0].execute("call", { prompt: "x", description: "Broken", subagent_type: "Explore", machine: "broken", machine_cwd: PROJECT }, undefined, undefined, ctx), /pi is not installed/);
		assert.ok(saved.some((entry) => entry.customType === "herdr-remote-machine" && entry.data.machine === "broken"));
	} finally {
		await handlers.get("session_shutdown")!({ reason: "quit" });
	}
});

test("shutdown is not held by a reconnect whose owner retirement stalls", { timeout: 20_000 }, async (t) => {
	const localRoot = mkdtempSync(join(tmpdir(), "herdr-retire-local-"));
	const remoteRoot = mkdtempSync(join(tmpdir(), "herdr-retire-remote-"));
	t.after(() => { rmSync(localRoot, { recursive: true, force: true }); rmSync(remoteRoot, { recursive: true, force: true }); });
	const remote = remoteClient();
	let opens = 0;
	let clock = Date.now();
	let drop = () => {};
	let stalledPosts = 0;
	const tools: any[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const notices: string[] = [];
	const saved: any[] = [];
	const pi = {
		registerTool(tool: any) { tools.push(tool); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		sendMessage() {}, sendUserMessage() {},
		appendEntry(customType: string, data: unknown) { saved.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	await createHerdrSubagents({
		root: localRoot, client: remote.client, agentDir: localRoot, hostname: "desk", now: () => clock,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
		machineClient: () => remote.client,
		machineChannel: async () => {
			opens++;
			if (opens === 1) return (events) => { drop = () => events.fail(new Error("connection lost")); return workerChannel(remoteRoot)(events); };
			// The reconnect's channel never answers, including the retirement of the lost owner.
			return () => ({ post() { stalledPosts++; }, hold() {}, close: async () => {} });
		},
	})(pi);
	const ctx = { cwd: localRoot, isIdle: () => true, abort() {}, ui: { notify(text: string) { notices.push(text); } }, sessionManager: { getEntries: () => saved, getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "parent" } };
	await handlers.get("session_start")!({}, ctx);
	await tools[0].execute("call", { prompt: "p", description: "Remote", subagent_type: "Explore", machine: "laptop", machine_cwd: PROJECT }, undefined, undefined, ctx);
	drop();
	await eventually(() => notices.some((text) => text.includes("laptop: connection lost")));
	clock += 10_001;
	await eventually(() => opens === 2 && stalledPosts > 0, "the reconnect did not start retiring the lost owner");
	const shutdown = handlers.get("session_shutdown")!({ reason: "quit" });
	const outcome = await Promise.race([shutdown.then(() => "closed"), new Promise((resolve) => setTimeout(resolve, 8000, "hung"))]);
	assert.equal(outcome, "closed");
});
