import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadHooks, matching } from "../src/hooks/config.ts";
import { decideStart, decideStop, decideTask, startInput, stopInput, taskInput, StopLoopState } from "../src/hooks/decide.ts";
import { runHook } from "../src/hooks/runner.ts";
import type { HookRunResult } from "../src/hooks/runner.ts";
import type { AgentDefinition, HookCommand, HookConfig } from "../src/types.ts";

const script = fileURLToPath(new URL("./fixtures/hooks/hook.mjs", import.meta.url));
const exec = (mode = "echo", timeout?: number): HookCommand => ({ type: "command", command: process.execPath, args: [script, mode], ...(timeout === undefined ? {} : { timeout }) });
const result = (patch: Partial<HookRunResult> = {}): HookRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, missingScript: false, ...patch });
const block = () => result({ json: { decision: "block", reason: "json feedback" } });
const context = () => result({ json: { hookSpecificOutput: { additionalContext: "extra context" } } });
const definition = (hooks: HookConfig, source: AgentDefinition["source"] = "user"): AgentDefinition => ({ agentType: "custom", description: "custom", prompt: "", source, skills: [], disallowedTools: [], diagnostics: [], hooks });
async function scratch(t: { after: (fn: () => Promise<void>) => void }) {
	const captures = resolve("captures");
	await mkdir(captures, { recursive: true });
	const root = await mkdtemp(join(captures, "hooks-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "user"), cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(join(cwd, ".pi"), { recursive: true });
	return { root, agentDir, cwd };
}

test("load file and definition hooks in order, reject non-command types, honor trust", async (t) => {
	const { agentDir, cwd } = await scratch(t);
	const config = (command: string): HookConfig => ({ SubagentStop: [{ matcher: "Explore", hooks: [{ type: "command", command }] }] });
	await writeFile(join(agentDir, "hooks.json"), "\uFEFF" + JSON.stringify({ hooks: config("user") }));
	await writeFile(join(cwd, ".pi/hooks.json"), JSON.stringify(config("project")));
	const loaded = loadHooks({ agentDir, cwd, projectTrusted: true, definition: definition(config("definition")) });
	assert.deepEqual(matching(loaded.config, "SubagentStop", "Explore").map((h) => h.command), ["user", "project", "definition"]);
	assert.deepEqual(loaded.diagnostics, []);
	assert.deepEqual(matching(loadHooks({ agentDir, cwd, projectTrusted: false }).config, "SubagentStop", "Explore").map((h) => h.command), ["user"]);
	assert.deepEqual(matching(loadHooks({ agentDir, cwd, projectTrusted: false, definition: definition(config("untrusted"), "project") }).config, "SubagentStop", "Explore").map((h) => h.command), ["user"]);
	const packaged = loadHooks({ agentDir, cwd, projectTrusted: false, definition: definition(config("package"), "package") });
	assert.deepEqual(matching(packaged.config, "SubagentStop", "Explore").map((h) => h.command), ["user"]);
	assert.match(packaged.diagnostics.join("\n"), /Package/);
	await writeFile(join(cwd, ".pi/hooks.json"), JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: "prompt", prompt: "ignored" }, { type: "http", url: "ignored" }, { type: "command", command: "valid" }, { type: "command", command: "invalid", timeout: -1 }] }] } }));
	const filtered = loadHooks({ agentDir, cwd, projectTrusted: true });
	assert.equal(filtered.diagnostics.length, 3);
	assert.equal(matching(filtered.config, "SubagentStop", "Explore").length, 2);
});

test("invalid JSON/config files are diagnostics; missing files are normal", async (t) => {
	const { agentDir, cwd } = await scratch(t);
	assert.deepEqual(loadHooks({ agentDir, cwd, projectTrusted: true }), { config: {}, diagnostics: [] });
	await writeFile(join(agentDir, "hooks.json"), "{");
	await writeFile(join(cwd, ".pi/hooks.json"), JSON.stringify({ hooks: [] }));
	assert.equal(loadHooks({ agentDir, cwd, projectTrusted: true }).diagnostics.length, 2);
	await writeFile(join(agentDir, "hooks.json"), JSON.stringify({ Stop: [], SubagentStart: "bad", SubagentStop: [{ matcher: 4, hooks: [] }, { matcher: "[", hooks: [exec()] }] }));
	const loaded = loadHooks({ agentDir, cwd, projectTrusted: false });
	assert.equal(loaded.diagnostics.length, 4);
	assert.equal(matching(loaded.config, "SubagentStop", "[" ).length, 1);
	assert.equal(matching(loaded.config, "SubagentStop", "Explore").length, 0);
});

test("matchers support exact, regex, wildcard and empty; task events ignore them", () => {
	const group = (matcher?: string) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [exec(matcher ?? "unset")] });
	const config: HookConfig = { SubagentStart: [group("Explore"), group("^(Plan|Explore)$"), group("*"), group(""), group()], TaskCreated: [group("never matches")] };
	assert.equal(matching(config, "SubagentStart", "Explore").length, 5);
	assert.equal(matching(config, "SubagentStart", "Plan").length, 4);
	assert.equal(matching(config, "SubagentStart", "other").length, 3);
	assert.equal(matching(config, "SubagentStart").length, 3);
	assert.equal(matching(config, "TaskCreated", "anything").length, 1);
	assert.deepEqual(matching({}, "SubagentStop", "Explore"), []);
});

test("stop precedence table covers every pair in both hook orders", () => {
	const rules = [
		{ name: "prevention", raw: result({ json: { continue: false, stopReason: "stop" } }), feedback: undefined, diagnostic: false },
		{ name: "missing script", raw: result({ exitCode: 2, missingScript: true, stderr: "not found", json: { decision: "block" }, jsonError: "bad JSON" }), feedback: undefined, diagnostic: true },
		{ name: "exit 2", raw: result({ exitCode: 2, stderr: "exit feedback", jsonError: "bad JSON" }), feedback: "exit feedback", diagnostic: false },
		{ name: "JSON block", raw: block(), feedback: "json feedback", diagnostic: false },
		{ name: "context", raw: context(), feedback: "extra context", diagnostic: false },
		{ name: "plain success", raw: result({ stdout: "hello", json: { continue: true } }), feedback: undefined, diagnostic: false },
		{ name: "invalid JSON", raw: result({ jsonError: "bad JSON" }), feedback: undefined, diagnostic: true },
	];
	for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
		for (const pair of [[rules[i], rules[j]], [rules[j], rules[i]]]) {
			const actual = decideStop(pair.map((r) => r.raw));
			const label = pair.map((r) => r.name).join(" + ");
			if (pair.some((r) => r.name === "prevention")) assert.deepEqual(actual.decision, { kind: "prevent", reason: "stop" }, label);
			else {
				const expected = pair.flatMap((r) => r.feedback ? [r.feedback] : []);
				assert.equal(actual.decision.kind, expected.length ? "feedback" : "allow", label);
				if (actual.decision.kind === "feedback") assert.deepEqual([...actual.decision.messages].sort(), expected.sort(), label);
			}
			assert.equal(actual.diagnostics.length, pair.filter((r) => r.diagnostic).length, label);
		}
	}
});

test("combined output precedence, diagnostics and no accidental retries", () => {
	assert.deepEqual(decideStop([result({ exitCode: 2, stderr: "stderr", json: { continue: false, decision: "block", stopReason: "prevent" } })]).decision, { kind: "prevent", reason: "prevent" });
	assert.deepEqual(decideStop([result({ exitCode: 2, missingScript: true, json: { continue: false } })]).decision, { kind: "prevent" });
	assert.deepEqual(decideStop([result({ exitCode: 2, stderr: "stderr", json: { decision: "block", reason: "stdout" } })]).decision, { kind: "feedback", messages: ["stderr"] });
	assert.deepEqual(decideStop([result({ exitCode: 2, stderr: "" })]).decision, { kind: "feedback", messages: ["Blocked by hook"] });
	assert.deepEqual(decideStop([result({ json: { decision: "block", hookSpecificOutput: { additionalContext: "context" } } })]).decision, { kind: "feedback", messages: ["Blocked by hook", "context"] });
	for (const raw of [result(), result({ stdout: "report" }), result({ json: { continue: true } }), result({ json: { hookSpecificOutput: { additionalContext: "  " } } })]) assert.deepEqual(decideStop([raw]), { decision: { kind: "allow" }, diagnostics: [] });
	for (const raw of [result({ exitCode: 1, json: { decision: "block" }, stderr: "execution failed" }), result({ timedOut: true, json: { decision: "block" } }), result({ exitCode: null, stderr: "spawn failed" }), result({ jsonError: "schema" })]) {
		const decision = decideStop([raw]);
		assert.equal(decision.decision.kind, "allow");
		assert.equal(decision.diagnostics.length, 1);
	}
});

test("start converts blocks/context into messages, while task vetoes only block signals", () => {
	const results = [block(), context(), result({ exitCode: 2, stderr: "stderr feedback" })];
	assert.deepEqual(decideStart(results), { contextMessages: ["json feedback", "stderr feedback", "extra context"], diagnostics: [] });
	assert.deepEqual(decideTask(results), { block: "json feedback\n\nstderr feedback", diagnostics: [] });
	assert.deepEqual(decideTask([context()]), { diagnostics: [] });
	assert.deepEqual(decideStart([result({ json: { continue: false } })]).contextMessages, []);
	assert.equal(decideStart([result({ json: { continue: false } })]).diagnostics.length, 1);
	assert.equal(decideTask([result({ exitCode: 2, missingScript: true })]).block, undefined);
});

test("stop-loop cap permits eight retries, overrides ninth, and resets only consecutive count", () => {
	const state = new StopLoopState(8);
	assert.equal(state.stopHookActive, false);
	state.onToolTurn();
	assert.equal(state.stopHookActive, false);
	for (let i = 0; i < 8; i++) assert.deepEqual(state.onFeedbackRetry(), { allowed: true });
	assert.equal(state.stopHookActive, true);
	assert.match(state.onFeedbackRetry().warning!, /cap \(8\)/);
	assert.equal(state.onFeedbackRetry().allowed, false);
	state.onToolTurn();
	assert.equal(state.stopHookActive, true);
	for (let i = 0; i < 8; i++) assert.equal(state.onFeedbackRetry().allowed, true);
	assert.equal(state.onFeedbackRetry().allowed, false);
	for (const cap of [0, -1]) {
		const unlimited = new StopLoopState(cap);
		for (let i = 0; i < 100; i++) assert.equal(unlimited.onFeedbackRetry().allowed, true);
	}
});

test("stop-loop cap reads environment with default and invalid-value fallback", (t) => {
	const previous = process.env.PI_STOP_HOOK_BLOCK_CAP;
	t.after(() => { if (previous === undefined) delete process.env.PI_STOP_HOOK_BLOCK_CAP; else process.env.PI_STOP_HOOK_BLOCK_CAP = previous; });
	for (const value of [undefined, "", "auto", "1.5"]) {
		if (value === undefined) delete process.env.PI_STOP_HOOK_BLOCK_CAP; else process.env.PI_STOP_HOOK_BLOCK_CAP = value;
		const state = new StopLoopState();
		for (let i = 0; i < 8; i++) assert.equal(state.onFeedbackRetry().allowed, true);
		assert.equal(state.onFeedbackRetry().allowed, false);
	}
	process.env.PI_STOP_HOOK_BLOCK_CAP = "1";
	const state = new StopLoopState();
	assert.equal(state.onFeedbackRetry().allowed, true);
	assert.equal(state.onFeedbackRetry().allowed, false);
});

test("payload builders preserve common context and stamp event-specific identity", () => {
	const common = { session_id: "s1", cwd: "/cwd", transcript_path: "/parent.jsonl", hook_event_name: "wrong", agent_id: "wrong" };
	const start = startInput(common, { agentId: "a1", agentType: "Explore" });
	assert.equal(start.hook_event_name, "SubagentStart");
	assert.equal(start.agent_id, "a1");
	const stop = stopInput(common, { agentId: "a1", agentType: "Explore", transcriptPath: "/child.jsonl", lastAssistantMessage: "answer", stopHookActive: true, backgroundWork: ["child-a2"] });
	assert.deepEqual(stop, { ...common, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore", agent_transcript_path: "/child.jsonl", last_assistant_message: "answer", stop_hook_active: true, background_work: ["child-a2"] });
	for (const event of ["TaskCreated", "TaskCompleted"]) {
		const task = taskInput({ ...common, hook_event_name: event, teammate_name: "omit", team_name: "omit" }, { id: "3", subject: "before subject", description: "before description" });
		assert.equal(task.hook_event_name, event);
		assert.equal(task.task_id, "3");
		assert.equal(task.task_subject, "before subject");
		assert.equal(task.task_description, "before description");
		assert.equal(Object.hasOwn(task, "team_name"), false);
		assert.equal(Object.hasOwn(task, "teammate_name"), false);
	}
	assert.equal(common.agent_id, "wrong");
});

test("real exec hook receives JSON stdin, env, cwd and literal arguments", async (t) => {
	const { cwd } = await scratch(t);
	const command = exec();
	command.args!.push("two words", "a&b", "$(not a shell)");
	const input = startInput({ cwd, session_id: "session", transcript_path: "transcript" }, { agentId: "a1", agentType: "Explore" });
	const raw = await runHook(command, input, { cwd, env: { HOOK_MARKER: "marker" } });
	assert.equal(raw.exitCode, 0);
	assert.equal(raw.jsonError, undefined);
	const decision = decideStart([raw]);
	const echoed = JSON.parse(decision.contextMessages[0]);
	assert.deepEqual(echoed.payload, input);
	assert.equal(echoed.cwd, cwd);
	assert.equal(echoed.marker, "marker");
	assert.deepEqual(echoed.args, ["two words", "a&b", "$(not a shell)"]);
});

test("real exec hooks exercise exit-2 malformed JSON, prevention and missing-script exception", async () => {
	const options = { cwd: process.cwd() };
	const malformed = await runHook(exec("exit2"), {}, options);
	assert.ok(malformed.jsonError);
	assert.deepEqual(decideStop([malformed]).decision, { kind: "feedback", messages: ["Please finish the verification."] });
	const prevented = await runHook(exec("prevent"), {}, options);
	assert.deepEqual(decideStop([malformed, prevented]).decision, { kind: "prevent", reason: "Finish now" });
	for (const mode of ["missing", "127"]) {
		const missing = await runHook(exec(mode), {}, options);
		assert.equal(missing.missingScript, true);
		assert.equal(decideStop([missing]).decision.kind, "allow");
		assert.equal(decideStop([missing]).diagnostics.length, 1);
	}
	const missingData = await runHook(exec("missing-data"), {}, options);
	assert.equal(missingData.missingScript, false);
	assert.deepEqual(decideStop([missingData]).decision, { kind: "feedback", messages: ["No such file or directory: input.data"] });
	const schema = await runHook(exec("schema"), {}, options);
	assert.match(schema.jsonError!, /schema/);
	assert.equal(decideStop([schema]).decision.kind, "allow");
	const plain = await runHook(exec("plain"), {}, options);
	assert.equal(plain.jsonError, undefined);
	assert.deepEqual(decideStop([plain]), { decision: { kind: "allow" }, diagnostics: [] });
});

test("missing executable, real missing Node script and timeout remain diagnostics", async () => {
	const options = { cwd: process.cwd() };
	const missing = await runHook({ type: "command", command: "__missing_hook_executable__", args: [] }, {}, options);
	assert.equal(missing.exitCode, null);
	assert.equal(missing.missingScript, true);
	assert.equal(decideStop([missing]).decision.kind, "allow");
	const nodeMissing = await runHook({ type: "command", command: process.execPath, args: [script + ".missing"] }, {}, options);
	assert.notEqual(nodeMissing.exitCode, 0);
	assert.equal(decideStop([nodeMissing]).decision.kind, "allow");
	const began = Date.now();
	const timedOut = await runHook(exec("hang", 0.1), {}, options);
	assert.equal(timedOut.timedOut, true);
	assert.ok(Date.now() - began < 4000);
	assert.equal(decideStop([timedOut]).decision.kind, "allow");
	assert.match(decideStop([timedOut]).diagnostics.join("\n"), /timed out/);
});

test("caller cancellation and output overflow settle without blocking feedback", async () => {
	const controller = new AbortController();
	const pending = runHook(exec("hang"), {}, { cwd: process.cwd(), signal: controller.signal });
	setTimeout(() => controller.abort(), 100);
	const cancelled = await pending;
	assert.equal(cancelled.timedOut, false);
	assert.equal(decideStop([cancelled]).decision.kind, "allow");
	const preCancelled = await runHook(exec(), {}, { cwd: process.cwd(), signal: controller.signal });
	assert.match(preCancelled.stderr, /cancelled before execution/);
	const large = await runHook(exec("large"), {}, { cwd: process.cwd() });
	assert.ok(large.stdout.length <= 1_048_576);
	assert.ok(large.jsonError);
	assert.equal(decideStop([large]).decision.kind, "allow");
});

test("shell form remains distinct from exec form", async () => {
	const output = await runHook({ type: "command", command: "echo hook-shell" }, {}, { cwd: process.cwd() });
	assert.equal(output.exitCode, 0);
	assert.match(output.stdout, /hook-shell/);
	assert.equal(output.jsonError, undefined);
});
