import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HerdrCliError, type HerdrAgentRef, type HerdrClient } from "../src/herdr/client.ts";
import { createHerdrSubagents } from "../src/herdr/extension.ts";
import { createHcCli, HC_AGENT_LABEL, HC_SESSION_LABEL, HcError, hcConnect, hcCoreId, hcRef, hcSession, hcSessionTag, hcTerminalName, listHcMachines, type HcCall } from "../src/herdr/hc.ts";
import { hostPaneId, terminalHost } from "../src/herdr/host.ts";
import { HerdrRunner } from "../src/herdr/runner.ts";
import type { ChildBinding } from "../src/herdr/store.ts";

interface Terminal {
	address: string;
	state: "live" | "finished";
	name: string | null;
	pid: number;
	argv: string[];
	cwd: string;
	labels: Record<string, string>;
	foreground: { pid: number; name: string; argv: string[]; cwd: string } | null;
	status: { app: string; state: string } | null;
}

/** An hc core: terminals on this machine and others, answering the API calls the client makes. */
function fakeHc(options: { onRun?: (terminal: Terminal) => Promise<void> } = {}) {
	const terminals = new Map<string, Terminal>();
	const calls: { method: string; params: Record<string, any>; anonymous?: boolean }[] = [];
	const machines = new Map([["hermes", "connected"]]);
	let sequence = 1;
	let pid = 1000;
	const find = (address: string) => {
		const terminal = terminals.get(address);
		if (!terminal) throw new HcError(`no terminal "${address}"`, "not_found");
		return terminal;
	};
	const add = (address: string, extra: Partial<Terminal> = {}): Terminal => {
		const terminal: Terminal = { address, state: "live", name: null, pid: ++pid, argv: ["bash"], cwd: "/", labels: {}, foreground: null, status: null, ...extra };
		terminal.foreground ??= { pid: terminal.pid, name: terminal.argv[0], argv: terminal.argv, cwd: terminal.cwd };
		terminals.set(address, terminal);
		return terminal;
	};
	const call: HcCall = async (method, raw, callOptions) => {
		const params = raw as Record<string, any>;
		calls.push({ method, params: structuredClone(params), anonymous: callOptions?.anonymous });
		switch (method) {
			case "terminal.run": {
				const name = params.name as string | undefined;
				if (name && [...terminals.values()].some((item) => item.state === "live" && item.name === name)) throw new HcError(`a live terminal is already named "${name}"`, "name_taken");
				const argv = params.argv as string[];
				const terminal = add(`${params.on ? `${params.on}/` : ""}t${++sequence}`, {
					name: name ?? null, argv, cwd: params.cwd as string, labels: { ...params.labels as Record<string, string> },
					status: { app: argv[0] === "claude" ? "claude-code" : "pi", state: "idle" },
				});
				await options.onRun?.(terminal);
				return structuredClone(terminal);
			}
			case "terminal.list": {
				const labels = Object.entries((params.labels ?? {}) as Record<string, string>);
				return { terminals: structuredClone([...terminals.values()].filter((item) => (params.all || item.state === "live")
					// An unreachable machine's terminals are left out of the listing.
					&& !(item.address.includes("/") && machines.get(item.address.split("/")[0]) !== "connected")
					&& labels.every(([key, value]) => item.labels[key] === value))), machines: [...machines].map(([name, state]) => ({ name, state })), hidden_finished: 0 };
			}
			case "terminal.get": return structuredClone(find(params.terminal));
			case "terminal.kill": {
				const terminal = find(params.terminal);
				Object.assign(terminal, { state: "finished", foreground: null, status: null });
				return structuredClone(terminal);
			}
			case "terminal.rm": {
				if (find(params.terminal).state !== "finished") throw new HcError("still live", "live");
				terminals.delete(params.terminal);
				return { removed: params.terminal };
			}
			case "terminal.send": find(params.terminal); return { started: null, status: null, turn: 0 };
			case "terminal.label": {
				const terminal = find(params.terminal);
				for (const [key, value] of Object.entries(params.labels as Record<string, string>)) {
					if (value) terminal.labels[key] = value;
					else delete terminal.labels[key];
				}
				return structuredClone(terminal);
			}
			case "server.status": return { core: { id: "core-a", name: "desk" }, version: "0.1.19" };
			case "machine.list": return { machines: [{ id: "8b8d", name: "hermes", target: "hermes-cloud", state: "connected", session: "work" }] };
			default: throw new Error(`Unexpected hc call ${method}`);
		}
	};
	return { call, calls, terminals, machines, add, runs: () => calls.filter((item) => item.method === "terminal.run") };
}

test("the innermost terminal host wins and HERDR_SUBAGENTS_HOST picks a present one", () => {
	assert.equal(terminalHost({}), undefined);
	assert.equal(terminalHost({ HERDR_ENV: "1" }), "herdr");
	assert.equal(terminalHost({ HC_TERMINAL_ID: "t7" }), "hc");
	// A herdr TUI started inside an app terminal.
	assert.equal(terminalHost({ HC_TERMINAL_ID: "t7", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), "herdr");
	assert.equal(terminalHost({ HC_TERMINAL_ID: "t7", HERDR_ENV: "1" }), "hc");
	assert.equal(terminalHost({ HC_TERMINAL_ID: "t7", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SUBAGENTS_HOST: "hc" }), "hc");
	assert.equal(terminalHost({ HC_TERMINAL_ID: "t7", HERDR_SUBAGENTS_HOST: "herdr" }), undefined);
	assert.equal(terminalHost({ HERDR_ENV: "1", HERDR_SUBAGENTS_HOST: "hc" }), undefined);
	assert.equal(hostPaneId({ HC_TERMINAL_ID: "t7", HERDR_PANE_ID: "w1:p1" }, "hc"), "t7");
	assert.equal(hostPaneId({ HC_TERMINAL_ID: "t7", HERDR_PANE_ID: "w1:p1" }, "herdr"), "w1:p1");
});

test("app rows name the machine, then the role, within hc's name rules", () => {
	assert.equal(hcTerminalName("reviewer", "hermes"), "hermes-reviewer");
	assert.equal(hcTerminalName("Explore"), "explore");
	assert.equal(hcTerminalName("Code Review!", "Windows.Station"), "windows-station-code-review");
	assert.equal(hcTerminalName("x".repeat(40)).length, 28);
	assert.equal(hcTerminalName("???"), "agent");
});

test("a terminal's conversation is proven only by its program", () => {
	const base = { address: "t3", state: "live", pid: 50, argv: ["pi", "--session", "/s/launched.jsonl"], foreground: { pid: 50, name: "pi" }, status: { app: "pi", state: "idle" } };
	// A Pi's own label, tied to its PID, wins over the launch argv after /new.
	assert.equal(hcSession({ ...base, labels: { [HC_SESSION_LABEL]: "50:current.jsonl", [HC_AGENT_LABEL]: "a" } }), "current.jsonl");
	// A Pi that exited left its label behind; the shell now in the foreground proves nothing.
	assert.equal(hcSession({ ...base, foreground: { pid: 60, name: "bash" }, labels: { [HC_SESSION_LABEL]: "50:current.jsonl" } }), undefined);
	assert.equal(hcSession({ ...base, labels: { [HC_SESSION_LABEL]: "garbage" } }), undefined);
	// A subagent's launched program runs the session it was started with until it publishes one.
	assert.equal(hcSession({ ...base, labels: { [HC_AGENT_LABEL]: "a" } }), "/s/launched.jsonl");
	assert.equal(hcSession({ ...base, argv: ["claude", "--resume", "uuid-1"], labels: { [HC_AGENT_LABEL]: "a" } }), "uuid-1");
	assert.equal(hcSession({ ...base, labels: {} }), undefined, "an unlabelled terminal is not a subagent");
	assert.equal(hcSession({ ...base, state: "finished", labels: { [HC_AGENT_LABEL]: "a" } }), undefined);

	assert.deepEqual(hcRef({ ...base, address: "hermes/t3", labels: { [HC_AGENT_LABEL]: "a" } }, "t3", "hermes/t3"),
		{ name: "a", paneId: "t3", focused: true, status: "idle", session: "/s/launched.jsonl" });
	assert.equal(hcRef({ ...base, labels: {} }, "t3", null).focused, false, "without a window nothing is focused");
	assert.equal(hcRef({ ...base, labels: {} }, "t3").focused, undefined);
	assert.equal(hcRef({ ...base, state: "finished", foreground: null, status: null, labels: { [HC_AGENT_LABEL]: "a" } }, "t3").plainShell, true);
	assert.equal(hcRef({ ...base, foreground: { pid: 9, name: "bash" }, status: null, labels: {} }, "t3").plainShell, true);
	for (const uncertain of [{ foreground: { pid: 9, name: "node" }, status: null }, { foreground: { pid: 9, name: "bash" }, status: { app: "claude-code", state: "idle" } }, { foreground: null, status: null }]) {
		assert.equal(hcRef({ ...base, ...uncertain, labels: {} }, "t3").plainShell, undefined, JSON.stringify(uncertain));
	}
	assert.equal(hcRef({ ...base, status: null, labels: {} }, "t3").status, "unknown");
});

test("hc launches a nested, labelled terminal and retries only a taken name", async () => {
	const hc = fakeHc();
	hc.add("t9", { name: "hermes-reviewer" });
	const client = createHcCli({ HC_TERMINAL_ID: "t1" }, { machine: "hermes", call: hc.call, focus: async () => null });
	assert.deepEqual(await client.launch!({ name: "reviewer", kind: "pi", args: ["--session", "/s.jsonl"], cwd: "/work", role: "reviewer" }), { paneId: "t2" });
	assert.deepEqual(hc.runs().map((item) => item.params), [
		{ argv: ["pi", "--session", "/s.jsonl"], cwd: "/work", labels: { [HC_AGENT_LABEL]: "reviewer" }, caller: "t1", on: "hermes", name: "hermes-reviewer", outlive_parent: true, no_notify: true },
		{ argv: ["pi", "--session", "/s.jsonl"], cwd: "/work", labels: { [HC_AGENT_LABEL]: "reviewer" }, caller: "t1", on: "hermes", name: "hermes-reviewer-2", outlive_parent: true, no_notify: true },
	]);
	assert.ok(hc.terminals.has("hermes/t2"));
	// Any other refusal may hide a started terminal and is never retried.
	const failing = createHcCli({}, { call: async () => { throw new HcError("spawn failed", "spawn_failed"); } });
	await assert.rejects(failing.launch!({ name: "a", kind: "pi", args: [], cwd: "/", role: "a" }), { message: "spawn failed" });
	const rejected = createHcCli({}, { call: async () => { throw new HcError("no machine", "machine_unknown"); } });
	await assert.rejects(rejected.launch!({ name: "a", kind: "pi", args: [], cwd: "/", role: "a" }), (error) => error instanceof HerdrCliError && error.code === "machine_unknown");
	// Ten clashes leave the terminal unnamed rather than failing.
	const crowded = fakeHc();
	for (const name of ["explore", ...Array.from({ length: 8 }, (_, index) => `explore-${index + 2}`)]) crowded.add(`t${100 + name.length}${name}`, { name });
	await createHcCli({}, { call: crowded.call }).launch!({ name: "explore", kind: "pi", args: [], cwd: "/", role: "explore" });
	assert.equal(crowded.runs().length, 10);
	assert.equal(crowded.runs().at(-1)!.params.name, undefined);
});

test("hc lookups stay on the client's machine and find agents by label", async () => {
	const hc = fakeHc();
	hc.add("t2", { argv: ["pi", "--session", "/s/a.jsonl"], labels: { [HC_AGENT_LABEL]: "explore" }, status: { app: "pi", state: "working" } });
	hc.add("hermes/t2", { argv: ["pi", "--session", "/s/b.jsonl"], labels: { [HC_AGENT_LABEL]: "explore" }, status: { app: "pi", state: "idle" } });
	hc.add("t3", { labels: { [HC_SESSION_LABEL]: "1010:owner.jsonl" } });
	hc.add("t4", { argv: ["claude"], status: { app: "claude-code", state: "working" } });
	hc.add("t5", { state: "finished", foreground: null, labels: { [HC_AGENT_LABEL]: "gone" } });
	const local = createHcCli({}, { call: hc.call, focus: async () => "t2" });
	const hermes = createHcCli({}, { machine: "hermes", call: hc.call, focus: async () => "t2" });
	assert.deepEqual(await local.getAgent("explore"), { name: "explore", paneId: "t2", cwd: "/", status: "working", session: "/s/a.jsonl" });
	assert.deepEqual(await hermes.getAgent("explore"), { name: "explore", paneId: "t2", cwd: "/", status: "idle", session: "/s/b.jsonl" });
	assert.equal(await local.isAlive("gone"), false);
	assert.equal(await local.getAgent("missing"), undefined);
	// Untracked terminals, such as another Claude, cannot hold a conversation of this package and are left out.
	assert.deepEqual((await local.listAgents()).map((item) => item.paneId), ["t2", "t3"]);
	const panes = await local.listPanes();
	assert.deepEqual(panes.map((item) => [item.paneId, item.focused, item.plainShell]), [["t2", true, undefined], ["t3", false, true], ["t5", false, true]]);
	assert.equal(panes[1].session, undefined, "t3's Pi exited: its label names a PID that is not its shell");
	assert.equal((await hermes.getPane!("t2"))?.focused, false);
	assert.equal(await local.getPane!("t99"), undefined);
	await hermes.promptAgent!("t2", "/compact");
	assert.deepEqual(hc.calls.at(-1), { method: "terminal.send", params: { terminal: "hermes/t2", text: "/compact" }, anonymous: true });
	await local.closePane("t2");
	assert.equal(hc.terminals.has("t2"), false);
	await local.closePane("t2");
	await local.publishSession!("t3", "/home/me/.pi/sessions/x_1.jsonl");
	assert.equal(hc.terminals.get("t3")!.labels[HC_SESSION_LABEL], `${process.pid}:x_1.jsonl`);
	await local.publishSession!("t3", undefined);
	assert.equal(hc.terminals.get("t3")!.labels[HC_SESSION_LABEL], undefined);
	await assert.rejects(local.split({ paneId: "t3", direction: "right", cwd: "/" }), /Use launch/);
});

test("hc connect sends one request and drops the terminal identity for anonymous calls", {
	skip: process.platform === "win32" ? "Fixture requires executable shebang scripts" : false,
}, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-hc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "hc");
	const trace = join(dir, "trace.json");
	writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(process.env.HC_TEST_TRACE, JSON.stringify({ args: process.argv.slice(2), request, terminal: process.env.HC_TERMINAL_ID ?? null, scope: process.env.HC_SCOPE ?? null }));
process.stdout.write(request.method === 'terminal.get'
	? JSON.stringify({ id: 1, jsonrpc: '2.0', error: { code: -32000, message: 'no terminal', data: { kind: 'not_found' } } }) + '\\n'
	: JSON.stringify({ id: 1, jsonrpc: '2.0', result: { ok: request.params } }) + '\\n');
`);
	chmodSync(bin, 0o755);
	const call = hcConnect({ ...process.env, HC_BIN_PATH: bin, HC_TEST_TRACE: trace, HC_TERMINAL_ID: "t7", HC_SCOPE: "scope" });
	assert.deepEqual(await call("terminal.list", { all: true }), { ok: { all: true } });
	assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), { args: ["connect"], request: { jsonrpc: "2.0", id: 1, method: "terminal.list", params: { all: true } }, terminal: "t7", scope: "scope" });
	await call("terminal.send", { terminal: "t2", text: "hi" }, { anonymous: true });
	assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")).terminal, null);
	assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")).scope, null);
	await assert.rejects(call("terminal.get", { terminal: "t9" }), (error) => error instanceof HcError && error.code === "not_found");
	await assert.rejects(hcConnect({ HC_BIN_PATH: join(dir, "missing") })("terminal.list", {}), { code: "ENOENT" });
});

/** An hc runner whose parent Pi runs in t1 and whose subagents attach when their program starts. */
async function fixture(t: test.TestContext, tag = hcSessionTag("core-a")) {
	const root = mkdtempSync(join(tmpdir(), "herdr-hc-"));
	let now = 1_000_000;
	let runner!: HerdrRunner;
	let binding: ChildBinding | undefined;
	const hc = fakeHc({
		async onRun(terminal) {
			terminal.foreground = { pid: terminal.pid, name: "pi", argv: ["pi"], cwd: terminal.cwd };
		},
	});
	const parent = hc.add("t1", { argv: ["pi"], status: { app: "pi", state: "working" } });
	parent.labels[HC_SESSION_LABEL] = `${parent.pid}:owner.jsonl`;
	const client = createHcCli({ HC_TERMINAL_ID: "t1" }, { call: hc.call, focus: async () => null });
	runner = new HerdrRunner({ root, client, herdrSession: tag, now: () => now, sleep: async (ms) => { now += ms; } });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const ref = await runner.spawn({
		prompt: "remember this", description: "test", subagentType: "Explore", cwd: root, paneId: "t1", sessionFile: "/sessions/owner.jsonl",
		runInBackground: true, model: "test-model", resolved: { instructions: "test instructions", allowedTools: ["read"] },
	});
	const record = await runner.resolve(ref.agentId);
	binding = await runner.store.attach(record.paneId, record.sessionFile, JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id);
	const complete = async () => {
		assert.ok(binding);
		await runner.store.claimNextCommand(ref.agentId, binding.token, false);
		await runner.store.recordExecutionEvent(ref, binding.token, { type: "live" }, now);
		await runner.store.recordExecutionEvent(ref, binding.token, { type: "completed", result: "remembered" }, now);
		await runner.store.acknowledgeNotice(ref.runId);
	};
	return { root, runner, hc, ref, parent, complete, advance: (ms = 901_000) => { now += ms; } };
}

test("an hc subagent runs in a child terminal, closes when done and reopens cold", async (t) => {
	const f = await fixture(t);
	const record = await f.runner.resolve(f.ref.agentId);
	assert.equal(record.paneId, "t2");
	assert.equal(record.herdrSession, hcSessionTag("core-a"));
	assert.deepEqual(f.hc.runs()[0].params, {
		argv: ["pi", "--session", record.sessionFile, "--model", "test-model", "--thinking", "medium"], cwd: record.cwd,
		labels: { [HC_AGENT_LABEL]: "explore" }, caller: "t1", name: "explore", outlive_parent: true, no_notify: true,
	});
	const launch = (await f.runner.store.launches())[0];
	assert.equal(launch.stage, "published");
	assert.equal(launch.paneId, "t2");
	await f.complete();
	f.advance();
	await f.runner.maintain();
	assert.equal(f.hc.terminals.has("t2"), false, "a finished, idle, unfocused subagent closes");
	assert.equal((await f.runner.resolve(record.id)).paneState, "parked");
	const next = await f.runner.resume(record.id, "what did I say?");
	assert.notEqual(next.runId, f.ref.runId);
	const reopened = await f.runner.resolve(record.id);
	assert.equal(reopened.paneId, "t3");
	assert.equal(reopened.sessionFile, record.sessionFile);
	assert.deepEqual(f.hc.runs()[1].params.argv, ["pi", "--session", record.sessionFile, "--model", "test-model", "--thinking", "medium"]);
	assert.equal((await f.runner.store.launches()).find((item) => item.agentId === record.id)?.stage, "published");
});

test("an hc subagent whose owner's terminal finished is stopped and closed", async (t) => {
	const f = await fixture(t);
	Object.assign(f.parent, { state: "finished", foreground: null, status: null });
	await f.runner.maintain();
	assert.equal(f.hc.terminals.has("t2"), false);
	assert.equal((await f.runner.read(f.ref)).phase, "stopped");
});

test("an hc subagent stays open while its owner's conversation lives or is uncertain", async (t) => {
	const f = await fixture(t);
	// The owner's Pi is starting again in its terminal and has not published its session yet.
	f.parent.labels[HC_SESSION_LABEL] = "1:old.jsonl";
	await f.runner.maintain();
	assert.ok(f.hc.terminals.has("t2"));
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
});

test("a herdr runner leaves the app's records to the app", async (t) => {
	const f = await fixture(t);
	const sessions: string[] = [];
	const down = async () => { throw new HerdrCliError("no herdr server is running", "server_not_running"); };
	let now = 2_000_000;
	const herdr = new HerdrRunner({
		root: f.root, now: () => now, herdrSession: "default",
		client: {
			listAgents: async () => [], listPanes: async () => [], getAgent: async () => undefined, getPane: async () => undefined,
			forSession: (name: string) => { sessions.push(name); return { listAgents: down, listPanes: down, getAgent: down, getPane: down } as unknown as HerdrClient; },
		} as unknown as HerdrClient,
	});
	t.after(() => herdr.close());
	await herdr.maintain();
	now += 60_000;
	await herdr.maintain();
	assert.deepEqual(sessions, []);
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
});

test("an app child attaches once its runner records the terminal, and publishes its conversation", { timeout: 15_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-hc-"));
	const tools: string[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		sendUserMessage() {}, sendMessage() {}, appendEntry() {}, setActiveTools() {}, getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	let started: Promise<unknown> | undefined;
	const hc = fakeHc({
		async onRun(terminal) {
			// The child's Pi starts before hc answers, so before the parent's runner records this terminal.
			const sessionFile = terminal.argv[terminal.argv.indexOf("--session") + 1];
			const sessionId = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]).id;
			const ctx = {
				cwd: root, isIdle: () => true, abort() {}, ui: { notify() {} },
				sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => sessionFile, getSessionId: () => sessionId },
			} as unknown as ExtensionContext;
			started = handlers.get("session_start")!({}, ctx);
			await started;
		},
	});
	hc.add("t1", { argv: ["pi"], status: { app: "pi", state: "working" } });
	const client = createHcCli({ HC_TERMINAL_ID: "t2" }, { call: hc.call, focus: async () => null });
	await createHerdrSubagents({ root, agentDir: root, client, env: { HC_TERMINAL_ID: "t2" }, listMachines: async () => [] })(pi);
	const parent = new HerdrRunner({ root, client: createHcCli({ HC_TERMINAL_ID: "t1" }, { call: hc.call, focus: async () => null }), herdrSession: hcSessionTag("core-a") });
	t.after(async () => {
		await handlers.get("session_shutdown")?.({ reason: "quit" });
		await parent.close();
		rmSync(root, { recursive: true, force: true });
	});
	await parent.spawn({ prompt: "Task", description: "Task", subagentType: "Explore", cwd: root, paneId: "t1", runInBackground: true, resolved: {} });
	await started;
	assert.equal(tools.includes("needs_answer"), false, "the first attach came too early");
	for (let count = 0; count < 100 && !tools.includes("needs_answer"); count++) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(tools.includes("needs_answer"), "the child attached on a later poll");
	assert.match(hc.terminals.get("t2")!.labels[HC_SESSION_LABEL] ?? "", new RegExp(`^${process.pid}:.+\\.jsonl$`));
	await handlers.get("session_shutdown")!({ reason: "quit" });
	handlers.delete("session_shutdown");
	assert.equal(hc.terminals.get("t2")!.labels[HC_SESSION_LABEL], undefined);
});

test("each hc core session keeps its own records; another core's runner leaves them alone", async (t) => {
	assert.equal(await hcCoreId(fakeHc().call), "core-a");
	await assert.rejects(hcCoreId(async () => ({ core: {} })), /did not name its core/);
	assert.deepEqual(await listHcMachines(fakeHc().call), [{ id: "8b8d", label: "hermes", target: "hermes-cloud", enabled: true }]);
	assert.equal(await createHcCli({}, { call: fakeHc().call }).hostId!(), "core-a");
	assert.equal(await createHcCli({}, { machine: "hermes", call: fakeHc().call }).hostId!(), "8b8d", "a machine's core id");
	await assert.rejects(createHcCli({}, { machine: "gone", call: fakeHc().call }).hostId!(), /not listed/);
	const f = await fixture(t);
	// Another core on this machine has its own `t2`, and none of this core's terminals.
	const other = fakeHc();
	const runner = new HerdrRunner({ root: f.root, client: createHcCli({ HC_TERMINAL_ID: "t1" }, { call: other.call, focus: async () => null }), herdrSession: hcSessionTag("other") });
	t.after(() => runner.close());
	await runner.maintain();
	await runner.reconcile();
	assert.equal((await f.runner.read(f.ref)).phase, "queued");
	await assert.rejects(runner.resume(f.ref.agentId, "more"), /belongs to another Herdr app session/);
	assert.deepEqual(other.calls, []);
});

test("an app Pi's session label is withdrawn only after its publication lands", { timeout: 15_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-hc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let label: string | undefined;
	const client = {
		listAgents: async () => [], listPanes: async () => [],
		hostId: async () => "core-a",
		async publishSession(_pane: string, session: string | undefined) {
			// The first publication is slow to land.
			if (session?.endsWith("old.jsonl")) await new Promise((resolve) => setTimeout(resolve, 100));
			label = session?.split("/").pop();
		},
	} as unknown as HerdrClient;
	// A reload loads a fresh extension instance in the same process.
	const start = async (file: string) => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const pi = { on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); }, registerTool() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
		await createHerdrSubagents({ env: { HC_TERMINAL_ID: "t1" }, root, client, agentDir: root, listMachines: async () => [] })(pi);
		const ctx = { isIdle: () => true, abort() {}, ui: { notify() {} }, sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => file, getSessionId: () => file } } as unknown as ExtensionContext;
		await handlers.get("session_start")!({}, ctx);
		return handlers;
	};
	const old = await start("/sessions/old.jsonl");
	await old.get("session_shutdown")!({ reason: "reload" });
	assert.equal(label, undefined);
	const current = await start("/sessions/new.jsonl");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(label, "new.jsonl");
	await current.get("session_shutdown")!({ reason: "quit" });
});

test("a machine hc cannot reach is unknown, and its completed agent closes once it reconnects", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "herdr-hc-"));
	let now = 1_000_000;
	const hc = fakeHc({ async onRun(terminal) { terminal.foreground = { pid: terminal.pid, name: "pi", argv: ["pi"], cwd: terminal.cwd }; } });
	const client = createHcCli({ HC_TERMINAL_ID: "t1" }, { machine: "hermes", call: hc.call, focus: async () => null });
	const runner = new HerdrRunner({ root, client, machine: "hermes", herdrSession: hcSessionTag("8b8d"), now: () => now });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const ref = await runner.spawn({ prompt: "task", description: "task", subagentType: "Explore", cwd: root, paneId: "t1", runInBackground: true, resolved: {} });
	const record = await runner.resolve(ref.agentId);
	const binding = (await runner.store.attach(record.paneId, record.sessionFile, JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id))!;
	await runner.store.claimNextCommand(ref.agentId, binding.token, false);
	await runner.store.recordExecutionEvent(ref, binding.token, { type: "live" }, now);
	await runner.store.recordExecutionEvent(ref, binding.token, { type: "completed", result: "done" }, now);
	for (const state of ["unreachable", undefined]) {
		if (state) hc.machines.set("hermes", state);
		else hc.machines.delete("hermes");
		await assert.rejects(client.listAgents(), (error) => error instanceof HcError && error.code === "unavailable");
		now += 121_000;
		await runner.maintain().catch(() => undefined);
		assert.equal((await runner.resolve(ref.agentId)).paneState, undefined, `machine ${state ?? "missing"}`);
		assert.equal(hc.terminals.get("hermes/t2")?.state, "live");
	}
	hc.machines.set("hermes", "connected");
	now += 121_000;
	await runner.maintain();
	assert.equal((await runner.resolve(ref.agentId)).paneState, "parked");
	assert.equal(hc.terminals.has("hermes/t2"), false);
});

/** An `hc` that routes like hc 0.1.19: HC_SOCKET, then HC_SESSION, then the terminal's inherited socket. */
function routingHc(dir: string) {
	const bin = join(dir, "hc");
	writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
const socket = (path) => path && path.split('/').pop().replace(/\\.sock$/, '');
const core = socket(process.env.HC_SOCKET) || process.env.HC_SESSION || socket(process.env.HC_TERMINAL_SOCKET) || 'default';
const reply = (result) => process.stdout.write(JSON.stringify({ id: 1, jsonrpc: '2.0', result }) + '\\n');
if (process.env.HC_TEST_NO_ID) reply({ core: {} });
else if (request.method === 'server.status') reply({ core: { id: 'id-' + core, name: core } });
else if (request.method === 'terminal.list') reply({ terminals: [], machines: [] });
else if (request.method === 'machine.list') reply({ machines: [] });
else process.stdout.write(JSON.stringify({ id: 1, jsonrpc: '2.0', error: { message: 'no terminal', data: { kind: 'not_found' } } }) + '\\n');
`);
	chmodSync(bin, 0o755);
	return bin;
}

test("app runners tag records with the core hc actually reaches, and leave another core's live agent alone", {
	skip: process.platform === "win32" ? "Fixture requires executable shebang scripts" : false, timeout: 20_000,
}, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-hc-route-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = routingHc(dir);
	const inside = { HC_BIN_PATH: bin, HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/run/hc/a.sock" };
	for (const [env, core] of [
		[inside, "id-a"],
		[{ ...inside, HC_SESSION: "b" }, "id-b"],
		[{ ...inside, HC_SESSION: "b", HC_SOCKET: "/run/hc/c.sock" }, "id-c"],
	] as const) assert.equal(await createHcCli(env).hostId!(), core, JSON.stringify(env));
	// A live agent of the core the inherited socket names; inferring the core from the environment would claim it.
	const f = await fixture(t, hcSessionTag("a"));
	const record = await f.runner.resolve(f.ref.agentId);
	const handlers = new Map<string, (...args: any[]) => any>();
	const notices: string[] = [];
	const pi = { on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); }, registerTool() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
	const ctx = { isIdle: () => true, abort() {}, ui: { notify(text: string) { notices.push(text); } }, sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "s" } } as unknown as ExtensionContext;
	for (const env of [{ ...inside, HC_SOCKET: "/run/hc/b.sock" }, { ...inside, HC_TEST_NO_ID: "1" }]) {
		await createHerdrSubagents({ root: f.root, agentDir: f.root, env, listMachines: async () => [] })(pi);
		await handlers.get("session_start")!({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await handlers.get("session_shutdown")!({ reason: "quit" });
		assert.equal((await f.runner.read(f.ref)).phase, "queued", JSON.stringify(env));
	}
	assert.equal(record.herdrSession, hcSessionTag("a"));
	assert.match(notices.join("\n"), /did not name its core/, "without a core id nothing is maintained");
});

/** An app Pi whose core identification fails `failures` times, counting what its session does. */
async function identifying(t: test.TestContext, failures: number, options: { locked?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "herdr-hc-id-"));
	const counts = { id: 0, published: 0, listed: 0, prompts: 0 };
	let live: HerdrAgentRef | undefined;
	const client = {
		async hostId() { if (++counts.id <= failures) throw new Error("status timed out"); return "core-a"; },
		async isAlive() { return !!live; },
		async launch(task: { name: string; args: string[] }) { live = { paneId: "t2", name: task.name, session: task.args[1], status: "idle", focused: false }; return { paneId: "t2" }; },
		async getAgent() { return live; }, async getPane() { return live; },
		async listAgents() { counts.listed++; return live ? [live] : []; }, async listPanes() { counts.listed++; return live ? [live] : []; },
		async showLabel() {}, async publishSession(_pane: string, session?: string) { if (session) counts.published++; }, async closePane() { live = undefined; },
	} as unknown as HerdrClient;
	const parent = new HerdrRunner({ root, client, herdrSession: hcSessionTag("core-a") });
	const ref = await parent.spawn({ prompt: "task", description: "task", subagentType: "Explore", cwd: root, paneId: "t1", runInBackground: true, resolved: {} });
	const record = await parent.resolve(ref.agentId);
	const sessionId = JSON.parse(readFileSync(record.sessionFile, "utf8").split("\n")[0]).id;
	const handlers = new Map<string, (...args: any[]) => any>();
	const notices: string[] = [];
	const tools: string[] = [];
	const pi = {
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); }, registerTool(tool: { name: string }) { tools.push(tool.name); },
		appendEntry() {}, sendMessage() {}, sendUserMessage() { counts.prompts++; }, setActiveTools() {}, getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	await createHerdrSubagents({ root, agentDir: root, env: { HC_TERMINAL_ID: "t2" }, client, listMachines: async () => [] })(pi);
	const ctx = { isIdle: () => true, abort() {}, ui: { notify(text: string) { notices.push(text); } },
		sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => record.sessionFile, getSessionId: () => sessionId } } as unknown as ExtensionContext;
	let shut = false;
	const shutdown = async () => { if (!shut) { shut = true; await handlers.get("session_shutdown")!({ reason: "quit" }); } };
	// Another pane holds the write lock past the store's busy timeout, so the session's store cannot open.
	let lock: DatabaseSync | undefined;
	if (options.locked) {
		lock = new DatabaseSync(join(root, "control.sqlite"));
		lock.exec("BEGIN IMMEDIATE");
	}
	const unlock = () => { lock?.exec("ROLLBACK"); lock?.close(); lock = undefined; };
	t.after(async () => { unlock(); await shutdown(); await parent.close(); rmSync(root, { recursive: true, force: true }); });
	return { counts, notices, tools, shutdown, unlock, start: () => handlers.get("session_start")!({}, ctx) };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an app session whose core identification fails once begins, once, when a retry identifies it", { timeout: 15_000 }, async (t) => {
	const f = await identifying(t, 1);
	await f.start();
	assert.deepEqual(f.counts, { id: 1, published: 0, listed: 0, prompts: 0 }, "nothing runs before identification");
	assert.deepEqual(f.notices, ["Herdr coordination: status timed out"]);
	for (let count = 0; count < 100 && !f.tools.includes("needs_answer"); count++) await settle(20);
	await settle(600);
	assert.ok(f.tools.includes("needs_answer"), "the child attached");
	assert.equal(f.counts.id, 2);
	assert.equal(f.counts.published, 1);
	assert.equal(f.counts.prompts, 1, "it took its pending task");
	assert.ok(f.counts.listed > 0, "polling and maintenance run");
	assert.equal(f.tools.filter((name) => name === "needs_answer").length, 1);
});

test("an app session that cannot identify its core maintains nothing and stops retrying at shutdown", { timeout: 15_000 }, async (t) => {
	const f = await identifying(t, Infinity);
	await f.start();
	await settle(1000);
	assert.ok(f.counts.id >= 3, "it keeps retrying while the session lasts");
	assert.deepEqual(f.notices, ["Herdr coordination: status timed out"], "one notice for a repeated failure");
	assert.deepEqual({ published: f.counts.published, listed: f.counts.listed, prompts: f.counts.prompts }, { published: 0, listed: 0, prompts: 0 });
	await f.shutdown();
	const after = f.counts.id;
	await settle(1500);
	assert.equal(f.counts.id, after, "no retry outlives the session");
	assert.equal(f.tools.includes("needs_answer"), false);
});

test("an app session whose store cannot open yet retries without crashing, then begins exactly once", { timeout: 40_000 }, async (t) => {
	const unhandled: unknown[] = [];
	const record = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", record);
	t.after(() => { process.off("unhandledRejection", record); });
	// Identification fails once, so the store's failure comes from a timer-launched retry.
	const f = await identifying(t, 1, { locked: true });
	await f.start();
	for (let count = 0; count < 600 && !/database is locked/.test(f.notices.join("\n")); count++) await settle(20);
	assert.match(f.notices.join("\n"), /database is locked/);
	assert.deepEqual({ published: f.counts.published, listed: f.counts.listed, prompts: f.counts.prompts }, { published: 0, listed: 0, prompts: 0 }, "nothing half-started");
	f.unlock();
	for (let count = 0; count < 300 && !f.tools.includes("needs_answer"); count++) await settle(20);
	await settle(600);
	assert.equal(f.tools.filter((name) => name === "needs_answer").length, 1, "attached once");
	assert.equal(f.counts.published, 1);
	// Its task may have expired while the store stayed locked past the start window; it is never delivered twice.
	assert.ok(f.counts.prompts <= 1, "never took its task twice");
	assert.ok(f.counts.listed > 0, "polling runs");
	await f.shutdown();
	const listed = f.counts.listed;
	await settle(600);
	assert.equal(f.counts.listed, listed, "polling stopped at shutdown");
	assert.deepEqual(unhandled, []);
});

test("an app session shut down while its store cannot open cleans up and stops retrying", { timeout: 40_000 }, async (t) => {
	const unhandled: unknown[] = [];
	const record = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", record);
	t.after(() => { process.off("unhandledRejection", record); });
	const f = await identifying(t, 0, { locked: true });
	await f.start();
	assert.match(f.notices.join("\n"), /database is locked/);
	await f.shutdown();
	const attempts = f.counts.id;
	f.unlock();
	await settle(1500);
	assert.equal(f.counts.id, attempts, "no retry outlives the session");
	assert.deepEqual({ published: f.counts.published, listed: f.counts.listed, prompts: f.counts.prompts }, { published: 0, listed: 0, prompts: 0 });
	assert.equal(f.tools.includes("needs_answer"), false);
	assert.deepEqual(unhandled, []);
});
