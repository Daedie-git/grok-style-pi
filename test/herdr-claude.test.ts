import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { claudeArgs, claudeTools, handleClaudeHook } from "../src/herdr/claude.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import { HerdrRunner, type SpawnRequest } from "../src/herdr/runner.ts";

function fixture(t: TestContext, extra: Partial<HerdrClient> = {}) {
	const root = mkdtempSync(join(tmpdir(), "herdr-claude-"));
	const live = new Map<string, string>();
	const prompts: string[] = [];
	const starts: string[][] = [];
	let closes = 0;
	const client: HerdrClient = {
		split: async () => ({ paneId: "w1:p2" }),
		createTab: async () => ({ paneId: "w1:p2", tabId: "w1:t2" }),
		startPi: async () => { throw new Error("Claude must not launch Pi"); },
		startClaude: async ({ name, paneId, args }) => { live.set(name, paneId); starts.push(args); },
		promptAgent: async (_name, text) => { prompts.push(text); },
		closePane: async () => { closes++; live.clear(); },
		isAlive: async (name) => live.has(name),
		listAgents: async () => [...live].map(([name, paneId]) => ({ name, paneId })),
		listPanes: async () => [],
		showLabel: async () => {},
		...extra,
	};
	const runner = new HerdrRunner({ root, client });
	t.after(async () => { await runner.close(); rmSync(root, { recursive: true, force: true }); });
	const request: SpawnRequest = { runtime: "claude-code", prompt: "Review launch code", description: "Review launch code", subagentType: "reviewer", cwd: root, paneId: "w1:p1", runInBackground: true };
	const hook = async (event: string, data: Record<string, unknown> = {}) => {
		const record = await runner.resolve("reviewer");
		return handleClaudeHook(runner.store, record.id, { session_id: record.sessionId!, hook_event_name: event, ...data });
	};
	return { root, runner, request, prompts, starts, hook, client, closes: () => closes };
}

test("Claude native launch, permission blocking, final results, and resume retain immutable runs", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn({ ...f.request, model: "sonnet", thinking: "high" });
	assert.equal(f.starts.length, 1);
	assert.ok(f.starts[0].includes("--session-id"));
	assert.ok(f.starts[0].includes("sonnet"));
	assert.ok(f.starts[0].includes("--effort"));
	assert.ok(!f.starts[0].includes("--dangerously-skip-permissions"));
	assert.equal(f.prompts.length, 1);
	assert.match(f.prompts[0], /own Claude Code pane/);
	assert.equal((await f.runner.read(first)).phase, "starting");
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	assert.equal((await f.runner.read(first)).accepted, false, "receipt alone cannot confirm execution while other input hooks run");
	await f.hook("PreToolUse", { tool_name: "Read" });
	assert.equal((await f.runner.read(first)).accepted, true);
	await f.hook("PermissionRequest");
	assert.equal((await f.runner.wait(first)).phase, "blocked");
	await f.hook("PostToolUse");
	assert.equal((await f.runner.read(first)).phase, "running");
	await f.hook("Stop", { last_assistant_message: "First review" });
	assert.equal((await f.runner.wait(first)).result, "First review");
	assert.equal((await f.runner.store.notices("w1:p1"))[0].runId, first.runId);
	const second = await f.runner.resume(first.agentId, "Review follow-up");
	assert.notEqual(second.runId, first.runId);
	assert.equal(f.starts.length, 1, "resume reuses the interactive Claude conversation");
	await f.hook("Stop", { last_assistant_message: "Late first stop" });
	assert.equal((await f.runner.read(second)).phase, "starting", "old hook cannot settle a new unaccepted run");
	await f.hook("UserPromptSubmit", { prompt: f.prompts[1] });
	await f.hook("Stop", { last_assistant_message: "Second review" });
	assert.equal((await f.runner.read(first)).result, "First review");
	assert.equal((await f.runner.read(second)).result, "Second review");
	assert.equal(f.closes(), 0);
});

test("Claude hook rejects stale commands and other sessions", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	const rejected = await handleClaudeHook(f.runner.store, ref.agentId, { session_id: "another-session", hook_event_name: "UserPromptSubmit", prompt: f.prompts[0] });
	assert.equal(rejected?.decision, "block");
	assert.equal((await f.runner.read(ref)).accepted, false);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("Stop", { last_assistant_message: "Done" });
	assert.equal((await f.hook("UserPromptSubmit", { prompt: f.prompts[0] }))?.decision, "block");
});

test("Claude cancellation confirms owned pane closure and refuses resume after exit", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("PermissionRequest");
	assert.equal((await f.runner.cancel(ref)).phase, "stopped");
	assert.equal(f.closes(), 1);
	await f.hook("Stop", { last_assistant_message: "Late completion" });
	assert.equal((await f.runner.read(ref)).phase, "stopped");
	await assert.rejects(f.runner.resume(ref.agentId, "Continue"), /no longer running/);
});

test("Claude cancellation failure remains pending, not falsely stopped", async (t) => {
	const f = fixture(t, { closePane: async () => { throw new Error("close failed"); } });
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("PreToolUse", { tool_name: "Read" });
	await assert.rejects(f.runner.cancel(ref), /close failed/);
	const run = await f.runner.read(ref);
	assert.equal(run.cancelRequested, true);
	assert.equal(run.phase, "running");
});

test("Claude submission uncertainty is not replayed", async (t) => {
	let submissions = 0;
	const f = fixture(t, { promptAgent: async () => { submissions++; throw new Error("transport lost"); } });
	await assert.rejects(f.runner.spawn(f.request), /transport lost/);
	const record = await f.runner.resolve("reviewer");
	const ref = { agentId: record.id, runId: record.currentRunId };
	assert.equal((await f.runner.read(ref)).phase, "failed");
	await f.runner.maintain();
	assert.equal(submissions, 1);
});

test("Claude errors and session exit never report success", async (t) => {
	for (const event of ["StopFailure", "SessionEnd"]) {
		const f = fixture(t);
		const ref = await f.runner.spawn(f.request);
		await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
		await f.hook(event, { error: "authentication_failed" });
		assert.equal((await f.runner.read(ref)).phase, "failed");
	}
});

test("Unsupported Claude controls fail before opening a pane", async (t) => {
	const f = fixture(t);
	for (const extra of [{ inheritContext: true }, { maxTurns: 1 }, { thinking: "off" }]) {
		await assert.rejects(f.runner.spawn({ ...f.request, ...extra }));
	}
	assert.equal(f.starts.length, 0);
	assert.deepEqual(await f.runner.store.listAgents(), []);
	const ref = await f.runner.spawn(f.request);
	await assert.rejects(f.runner.steer(ref, "Change focus"), /Live steering is not supported/);
});

test("Claude tool selection maps built-ins without granting permission bypass", () => {
	assert.deepEqual(claudeTools(["read", "find", "ls"]), ["Read", "Glob"]);
	assert.throws(() => claudeTools(["customTool"]), /cannot enforce/);
	const args = claudeArgs({ id: "agent", allowedTools: ["read"], description: "", prompt: "", herdrName: "agent", paneId: "p", depth: 1, type: "review", createdAt: "" }, "session", "/state path/'quoted");
	assert.equal(args[args.indexOf("--tools") + 1], "Read");
	assert.ok(args.includes("--strict-mcp-config"));
	assert.ok(!args.includes("--allowedTools"));
	const hooks = JSON.parse(args[args.indexOf("--settings") + 1]).hooks;
	assert.match(hooks.Stop[0].hooks[0].command, /claude-hook-entry.mjs/);
});

test("Claude launch arguments carry multiline instructions only through task submission", async (t) => {
	const f = fixture(t);
	const task = { id: "reviewer", herdrName: "reviewer", paneId: "w1:p2", depth: 1, type: "reviewer", description: "Review", prompt: "Task", createdAt: "", instructions: "First paragraph\n\nSecond paragraph" };
	const args = claudeArgs(task, "session", f.root);
	assert.ok(args.every((arg) => !/[\r\n]/.test(arg)), "Herdr rejects any newline in native launch arguments");
});

test("Claude accepts paste-wrapped markers and blocks wrapped expired markers", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	const wrapped = `<pasted_content>\n${f.prompts[0]}\n</pasted_content>`;
	assert.equal(await f.hook("UserPromptSubmit", { prompt: wrapped }), undefined);
	await f.hook("Stop", { last_assistant_message: "Wrapped result" });
	assert.equal((await f.runner.read(ref)).result, "Wrapped result");
	assert.equal((await f.hook("UserPromptSubmit", { prompt: wrapped }))?.decision, "block");
});

test("Claude rejected input hooks expire rather than leaving a permanently running run", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	const received = await f.runner.read(ref);
	assert.equal(received.accepted, false);
	assert.ok(received.deadline > Date.now() + 240_000, "give slow model-only responses a bounded execution-confirmation window");
	await f.runner.store.expireUnacceptedRun(ref, received.deadline + 1);
	assert.equal((await f.runner.read(ref)).phase, "failed");
});

test("Claude overlapping approvals stay blocked until every matching tool finishes", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	const a = { tool_name: "Bash", tool_input: { command: "first", description: "A" } };
	const b = { tool_name: "Bash", tool_input: { command: "second" } };
	await f.hook("PermissionRequest", a);
	await f.hook("PermissionRequest", b);
	await f.hook("Notification", { notification_type: "permission_prompt" });
	await f.hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "unrelated" } });
	assert.equal((await f.runner.read(ref)).phase, "blocked");
	await f.hook("PostToolUse", { tool_name: "Bash", tool_input: { description: "A", command: "first" } });
	assert.equal((await f.runner.read(ref)).phase, "blocked");
	await f.hook("PostToolUseFailure", b);
	assert.equal((await f.runner.read(ref)).phase, "running");
});

test("Cancelling a resumed Claude dispatch closes the pane even after acceptance", async (t) => {
	const f = fixture(t);
	const first = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	await f.hook("Stop", { last_assistant_message: "First" });
	const abort = new AbortController();
	f.client.promptAgent = async (_name, prompt, signal) => {
		await f.hook("UserPromptSubmit", { prompt });
		await f.hook("PreToolUse", { tool_name: "Read" });
		abort.abort();
		signal!.throwIfAborted();
	};
	await assert.rejects(f.runner.resume(first.agentId, "Follow up", abort.signal), /abort/i);
	const record = await f.runner.resolve(first.agentId);
	assert.equal((await f.runner.read({ agentId: record.id, runId: record.currentRunId })).phase, "stopped");
	assert.equal(f.closes(), 1);
	assert.equal((await f.runner.read(first)).result, "First");
});

test("Cancelling Claude after input receipt but before execution confirmation closes its pane", async (t) => {
	for (const resume of [false, true]) {
		const f = fixture(t);
		let first;
		if (resume) {
			first = await f.runner.spawn(f.request);
			await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
			await f.hook("Stop", { last_assistant_message: "First" });
		}
		const abort = new AbortController();
		f.client.promptAgent = async (_name, prompt, signal) => {
			await f.hook("UserPromptSubmit", { prompt });
			abort.abort();
			signal!.throwIfAborted();
		};
		await assert.rejects(first ? f.runner.resume(first.agentId, "Follow up", abort.signal) : f.runner.spawn(f.request, abort.signal), /abort/i);
		const record = await f.runner.resolve("reviewer");
		const run = await f.runner.read({ agentId: record.id, runId: record.currentRunId });
		assert.equal(run.phase, "stopped");
		assert.equal(run.cancelRequested, true);
		assert.equal(f.closes(), 1);
	}
});

test("Durable Claude input receipt repairs a lost transport reply without accepting execution", async (t) => {
	const f = fixture(t);
	f.client.promptAgent = async (_name, prompt) => {
		await f.hook("UserPromptSubmit", { prompt });
		throw new Error("lost reply");
	};
	const ref = await f.runner.spawn(f.request);
	const run = await f.runner.read(ref);
	assert.equal(run.inputReceived, true);
	assert.equal(run.accepted, false);
	assert.equal(run.phase, "starting");
	assert.equal(f.closes(), 0);
	await f.hook("Stop", { last_assistant_message: "Recovered result" });
	assert.equal((await f.runner.read(ref)).result, "Recovered result");
});

test("Resolved tool batches clear denied and identity-free permission prompts", async (t) => {
	for (const notification of [true, false]) {
		const f = fixture(t);
		const ref = await f.runner.spawn(f.request);
		await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
		const tool = { tool_name: "Bash", tool_input: { command: "network request" } };
		await f.hook("PreToolUse", tool);
		if (notification) {
			await f.hook("Notification", { notification_type: "permission_prompt" });
			await f.hook("PostToolUse", tool);
		} else {
			await f.hook("PermissionRequest", tool);
			// A manual denial has no PostToolUseFailure, but the tool batch still settles.
		}
		assert.equal((await f.runner.read(ref)).phase, "blocked");
		await f.hook("PostToolBatch");
		assert.equal((await f.runner.read(ref)).phase, "running");
	}
});

test("Native Claude agents cannot clear each other's approvals or settle the main run", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	await f.hook("UserPromptSubmit", { prompt: f.prompts[0] });
	const tool = { tool_name: "Read", tool_input: { file_path: "same-file" } };
	await f.hook("PermissionRequest", tool);
	await f.hook("PermissionRequest", { ...tool, agent_id: "native-child" });
	await f.hook("PostToolBatch", { agent_id: "native-child" });
	assert.equal((await f.runner.read(ref)).phase, "blocked", "child batch must preserve the main approval");
	await f.hook("Stop", { agent_id: "native-child", last_assistant_message: "Child result" });
	assert.equal((await f.runner.read(ref)).phase, "blocked", "child lifecycle must not settle the main run");
	await f.hook("PostToolUse", tool);
	assert.equal((await f.runner.read(ref)).phase, "running");
	await f.hook("PermissionRequest", { ...tool, agent_id: "native-child" });
	await f.hook("PostToolBatch");
	assert.equal((await f.runner.read(ref)).phase, "blocked", "main batch must preserve the child approval");
	await f.hook("PostToolBatch", { agent_id: "native-child" });
	assert.equal((await f.runner.read(ref)).phase, "running");
	await f.hook("Stop", { last_assistant_message: "Main result" });
	assert.equal((await f.runner.read(ref)).result, "Main result");
});

test("Standalone Claude hook entry communicates through the real SQLite worker", async (t) => {
	const f = fixture(t);
	const ref = await f.runner.spawn(f.request);
	const record = await f.runner.resolve(ref.agentId);
	const entry = fileURLToPath(new URL("../src/herdr/claude-hook-entry.mjs", import.meta.url));
	for (const [event, data] of [["UserPromptSubmit", { prompt: f.prompts[0] }], ["Stop", { last_assistant_message: "Entry result" }]] as const) {
		const result = spawnSync(process.execPath, [entry, f.root, record.id], { input: JSON.stringify({ session_id: record.sessionId, hook_event_name: event, ...data }), encoding: "utf8", timeout: 15_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
	}
	assert.equal((await f.runner.read(ref)).result, "Entry result");
});
