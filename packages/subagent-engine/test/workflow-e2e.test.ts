import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { createHarness, until, type Harness, type Step } from "./fixtures/harness.ts";
import { chainKey } from "../src/workflow/replay.ts";

interface Receipt {
	status: string;
	taskId: string;
	taskType: string;
	workflowName: string;
	runId: string;
	transcriptDir: string;
	scriptPath: string;
	error?: string;
}
interface Message {
	role?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	content?: unknown;
	details?: unknown;
}
function noNetwork(t: TestContext): void {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in Workflow end-to-end tests"); });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function source(body: string, name = "e2e-workflow"): string {
	return `export const meta = {name:${JSON.stringify(name)},description:'Workflow integration fixture',phases:[{title:'Inspect'},{title:'Verify'}]};\n${body}`;
}
function text(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(block => block?.type === "text").map(block => block.text).join("\n");
}
function toolResults(messages: readonly unknown[], name: string): Message[] {
	return (messages as Message[]).filter(message => message.role === "toolResult" && message.toolName === name);
}
function receiptFrom(messages: readonly unknown[], name = "Workflow", index = 0): Receipt {
	const result = toolResults(messages, name)[index];
	assert.ok(result, `Missing ${name} result ${index}`);
	assert.equal(result.isError, false, text(result));
	assert.ok(result.details && typeof result.details === "object", "Launch receipt survives as tool-result details");
	return result.details as Receipt;
}
function workflowNotice(harness: Harness, taskId: string): Message | undefined {
	return (harness.parent.messages as Message[]).find(message => message.customType === "subagent-notification" && JSON.stringify(message.details).includes(taskId));
}
async function completion(harness: Harness, receipt: Receipt): Promise<{ notice: Message; snapshot: { status: string; taskId: string; runId: string; result?: unknown; error?: string; agentCount: number } }> {
	await until(() => workflowNotice(harness, receipt.taskId) !== undefined, 10_000);
	return {
		notice: workflowNotice(harness, receipt.taskId)!,
		snapshot: JSON.parse(readFileSync(join(harness.root, "agent", "subagents", harness.parent.sessionId, "workflows", `${receipt.runId}.json`), "utf8")),
	};
}
function userText(messages: unknown[]): string {
	// Pi can append a model-facing agent-listing entry after the task message.
	return (messages as Message[]).filter(message => message.role === "user").map(text).join("\n\n");
}
function launch(script: string, name = "Workflow"): Step {
	return { tools: [{ name, args: { script } }] };
}

test("Workflow launches parallel/pipeline agents in the background and notifies the root with their aggregate", { timeout: 15_000 }, async t => {
	noNetwork(t);
	const held = deferred();
	let inspectors = 0;
	const prompts: string[] = [];
	const script = source(`
		phase('Inspect');
		const findings = await parallel([()=>agent('inspect A'),()=>agent('inspect B')]);
		phase('Verify');
		return await pipeline(findings,
			(finding,original,index)=>agent('verify '+index+': '+finding),
			(verified,original,index)=>({original,verified,index}));`);
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" },
		parent: ({ index }) => index === 0 ? launch(script) : { text: "Parent continues its own work" },
		child: () => ({ messages }) => {
			const prompt = userText(messages);
			prompts.push(prompt);
			if (prompt.includes("inspect A") || prompt.includes("inspect B")) {
				inspectors++;
				return { wait: held.promise, then: { text: prompt.includes("inspect A") ? "found A" : "found B" } };
			}
			return { text: prompt.includes("verify 0:") ? "checked A" : "checked B" };
		},
	});
	t.after(async () => { held.resolve(); await harness.close(); });
	await harness.parent.prompt("Run the explicitly requested workflow", { source: "extension" });
	const receipt = receiptFrom(harness.parent.messages);
	assert.equal(receipt.status, "async_launched");
	assert.equal(receipt.taskType, "local_workflow");
	assert.match(receipt.runId, /^wf_/);
	assert.match(receipt.taskId, /^wft_/);
	assert.equal(harness.engine.workflows().has(receipt.taskId), true);
	await until(() => inspectors === 2).catch(error => { throw new Error(`${String(error)}: ${JSON.stringify({ prompts, inspectors, children: harness.children.size, receipt })}`); });
	assert.equal(workflowNotice(harness, receipt.taskId), undefined, "launch returns while the agents are still blocked");
	assert.equal(readFileSync(receipt.scriptPath, "utf8"), script);
	held.resolve();
	const { notice, snapshot } = await completion(harness, receipt);
	assert.equal(snapshot.status, "completed");
	assert.equal(snapshot.agentCount, 4);
	assert.deepEqual(snapshot.result, [{ original: "found A", verified: "checked A", index: 0 }, { original: "found B", verified: "checked B", index: 1 }]);
	assert.match(text(notice), /checked A/);
	assert.match(text(notice), /checked B/);
	assert.match(text(notice), /Workflow completed: e2e-workflow/);
	assert.equal(harness.children.size, 4);
	assert.equal([...harness.requests.children.values()].reduce((total, value) => total + value, 0), 4);
	const journal = readFileSync(join(receipt.transcriptDir, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(journal.filter(event => event.type === "result").length, 4);
});

test("schema agent returns the validated StructuredOutput tool value rather than final prose", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const script = source("return await agent('Produce facts',{schema:{type:'object',properties:{ok:{type:'boolean'},count:{type:'integer'}},required:['ok','count'],additionalProperties:false}});");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" },
		parent: ({ index }) => index === 0 ? launch(script) : { text: "Parent done" },
		child: () => ({ index }) => index === 0 ? { tools: [{ name: "StructuredOutput", args: { result: { ok: true, count: 2 } } }] } : { text: "This prose is not the structured result" },
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Run a structured workflow", { source: "extension" });
	const receipt = receiptFrom(harness.parent.messages);
	const { snapshot } = await completion(harness, receipt);
	assert.equal(snapshot.status, "completed", snapshot.error);
	assert.deepEqual(snapshot.result, { ok: true, count: 2 });
	assert.equal(harness.children.size, 1);
	const child = [...harness.children.values()][0];
	const handback = toolResults(child.messages, "StructuredOutput");
	assert.equal(handback.length, 1);
	assert.equal(handback[0].isError, false, text(handback[0]));
	assert.equal([...harness.requests.children.values()][0], 1, "the successful handback terminates its child turn");
});

for (const name of ["Workflow", "RunWorkflow"]) {
	test(`${name} syntax failure returns an error receipt without registering or launching a task`, { timeout: 10_000 }, async t => {
		noNetwork(t);
		const events: string[] = [];
		const harness = await createHarness({
			env: { PI_WORKFLOW_APPROVE: "1" },
			parent: ({ index }) => index === 0 ? launch(source("return import('node:fs');"), name) : { text: "Fix syntax instead of waiting" },
			child: () => () => ({ text: "must never launch" }),
		});
		t.after(() => harness.close());
		const off = harness.engine.subscribe(event => { if (event.type.startsWith("workflow-")) events.push(event.type); });
		t.after(off);
		await harness.parent.prompt("Run the invalid workflow", { source: "extension" });
		const receipt = receiptFrom(harness.parent.messages, name);
		assert.equal(receipt.status, "async_launched");
		assert.ok(receipt.error);
		assert.equal(receipt.taskId, "");
		assert.equal(harness.engine.workflows().has(receipt.taskId), false);
		assert.match(text(toolResults(harness.parent.messages, name)[0]), /NOT launched/i);
		await nextTurn();
		assert.equal(harness.children.size, 0);
		assert.equal(harness.engine.control.activeRuns(), 0);
		assert.deepEqual(events, []);
		assert.equal(existsSync(join(harness.root, "agent", "subagents", harness.parent.sessionId, "workflows")), false);
	});
}

test("TaskStop accepts a workflow taskId, cancels its active child and produces a stopped notice", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const childStarted = deferred(), hold = deferred();
	const script = source("return await agent('Wait until stopped');");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" },
		parent: ({ index, messages }) => {
			if (index === 0) return launch(script);
			if (index === 1) {
				const receipt = receiptFrom(messages);
				return { wait: childStarted.promise, then: { tools: [{ name: "TaskStop", args: { task_id: receipt.taskId } }] } };
			}
			return { text: "Workflow stopped" };
		},
		child: () => () => { childStarted.resolve(); return { wait: hold.promise, then: { text: "should not finish naturally" } }; },
	});
	t.after(async () => { hold.resolve(); await harness.close(); });
	await harness.parent.prompt("Start and stop this workflow", { source: "extension" });
	const receipt = receiptFrom(harness.parent.messages);
	const stopped = toolResults(harness.parent.messages, "TaskStop")[0];
	assert.ok(stopped);
	assert.equal(stopped.isError, false, text(stopped));
	assert.match(text(stopped), /Stopping workflow/);
	const { notice, snapshot } = await completion(harness, receipt);
	assert.equal(snapshot.status, "killed");
	assert.match(text(notice), /stopped/i);
	await until(() => harness.engine.control.activeRuns() === 0);
	assert.equal(harness.children.size, 1);
	assert.equal([...harness.children.values()][0].isStreaming, false);
	assert.equal([...harness.engine.control.conversations.values()][0].meta.runs[0].status, "killed");
});

test("resume keeps the run id, allocates a new task and reuses agent results while edited aggregation changes", { timeout: 15_000 }, async t => {
	noNetwork(t);
	let original: Receipt | undefined, resumed = false;
	const first = source("const value=await agent('unchanged investigation'); return {version:1,value};");
	const edited = source("const value=await agent('unchanged investigation'); return {version:2,value:value.toUpperCase()};");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" },
		parent: ({ index, messages }) => {
			if (index === 0) return launch(first);
			if (original && !resumed && (messages as Message[]).some(message => message.role === "user" && text(message).includes("RESUME_EDITED_WORKFLOW"))) {
				resumed = true;
				return { tools: [{ name: "Workflow", args: { scriptPath: original.scriptPath, resumeFromRunId: original.runId } }] };
			}
			return { text: "Parent done" };
		},
		child: () => () => ({ text: "cached fact" }),
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Run the first workflow", { source: "extension" });
	original = receiptFrom(harness.parent.messages);
	const initial = await completion(harness, original);
	assert.deepEqual(initial.snapshot.result, { version: 1, value: "cached fact" });
	assert.equal(harness.children.size, 1);
	const requestsBefore = [...harness.requests.children.values()].reduce((sum, value) => sum + value, 0);
	writeFileSync(original.scriptPath, edited);
	await nextTurn();
	await until(() => !harness.parent.isStreaming);
	await harness.parent.prompt("RESUME_EDITED_WORKFLOW", { source: "extension" });
	assert.equal(resumed, true);
	const second = receiptFrom(harness.parent.messages, "Workflow", 1);
	assert.equal(second.runId, original.runId);
	assert.notEqual(second.taskId, original.taskId);
	assert.equal(harness.engine.workflows().has(second.taskId), true);
	const completed = await completion(harness, second);
	assert.equal(completed.snapshot.status, "completed", completed.snapshot.error);
	assert.equal(completed.snapshot.taskId, second.taskId);
	assert.deepEqual(completed.snapshot.result, { version: 2, value: "CACHED FACT" });
	assert.match(text(completed.notice), /CACHED FACT/);
	assert.equal(harness.children.size, 1, "replay does not create another child");
	assert.equal([...harness.requests.children.values()].reduce((sum, value) => sum + value, 0), requestsBefore);
	const journal = readFileSync(join(second.transcriptDir, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(journal.filter(event => event.type === "result").length, 1);
});

test("resumeFromRunId refuses a still-running workflow before registering another task", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const childStarted = deferred(), hold = deferred();
	const script = source("return await agent('Running investigation');");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" },
		parent: ({ index, messages }) => {
			if (index === 0) return launch(script);
			if (index === 1) {
				const receipt = receiptFrom(messages);
				return { wait: childStarted.promise, then: { tools: [{ name: "Workflow", args: { script, resumeFromRunId: receipt.runId } }] } };
			}
			return { text: "Wait for the existing run" };
		},
		child: () => () => { childStarted.resolve(); return { wait: hold.promise, then: { text: "released" } }; },
	});
	t.after(async () => { hold.resolve(); await harness.close(); });
	await harness.parent.prompt("Try to resume a running workflow", { source: "extension" });
	const original = receiptFrom(harness.parent.messages);
	const refused = toolResults(harness.parent.messages, "Workflow")[1];
	assert.ok(refused);
	assert.equal(refused.isError, true);
	assert.match(text(refused), /still running/i);
	assert.equal(harness.engine.workflows().has(original.taskId), true);
	assert.equal(harness.children.size, 1);
	assert.equal(harness.engine.control.activeRuns(), 1);
	assert.equal(workflowNotice(harness, original.taskId), undefined);
});

test("inline Workflow without approval or an interactive UI is refused without executing agents", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({
		env: {},
		parent: ({ index }) => index === 0 ? launch(source("return await agent('Must not run');")) : { text: "Ask the user first" },
		child: () => () => ({ text: "must never launch" }),
	});
	t.after(() => harness.close());
	await harness.parent.prompt("An unapproved inline workflow", { source: "extension" });
	const refused = toolResults(harness.parent.messages, "Workflow")[0];
	assert.ok(refused);
	assert.equal(refused.isError, true);
	assert.match(text(refused), /approval.*no interactive UI/i);
	assert.equal(harness.children.size, 0);
	assert.equal(harness.engine.control.activeRuns(), 0);
	assert.equal(existsSync(join(harness.root, "agent", "subagents", harness.parent.sessionId, "workflows")), false);
});

test("workflow agents cannot execute Agent, Workflow or its RunWorkflow alias", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const script = source("return await agent('Try forbidden delegation');");
	const nested = source("return 'nested workflow must not run';", "forbidden-nested");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" },
		parent: ({ index }) => index === 0 ? launch(script) : { text: "Parent done" },
		child: () => ({ index }) => index === 0 ? { tools: [
			{ name: "Agent", args: { description: "Forbidden nested child", prompt: "Do not run", subagent_type: "general-purpose", run_in_background: false } },
			{ name: "Workflow", args: { script: nested } },
			{ name: "RunWorkflow", args: { script: nested } },
		] } : { text: "restricted report" },
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Check Workflow worker restrictions", { source: "extension" });
	const receipt = receiptFrom(harness.parent.messages);
	const { snapshot } = await completion(harness, receipt);
	assert.equal(snapshot.status, "completed", snapshot.error);
	assert.equal(snapshot.result, "restricted report");
	assert.equal(harness.children.size, 1, "forbidden Agent did not spawn a grandchild");
	const child = [...harness.children.values()][0];
	for (const name of ["Agent", "Workflow", "RunWorkflow"]) {
		assert.equal(child.getActiveToolNames().includes(name), false, `${name} is not granted`);
		const denied = toolResults(child.messages, name);
		assert.equal(denied.length, 1, name);
		assert.equal(denied[0].isError, true, `${name} execution must be refused`);
	}
});

test("workflow completion and resumed admission retain a failed child's interrupted stop-hook teardown", { timeout: 15_000 }, async t => {
	noNetwork(t);
	const script = source("return await agent('Fail before the interrupted stop hook');", "teardown-fence");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1", PI_WORKFLOW_CONCURRENCY: "1" },
		parent: ({ index }) => index === 0 ? launch(script) : { text: "Parent continues" },
		child: (_id, session) => {
			session.settingsManager.applyOverrides({ retry: { enabled: false } });
			return () => ({ error: "invalid_request_error: intentional teardown regression" });
		},
	});
	const ready = join(harness.root, "WORKFLOW_HOOK_READY"), after = join(harness.root, "WORKFLOW_HOOK_FINISHED"), release = join(harness.root, "WORKFLOW_HOOK_RELEASE");
	const releaseHook = () => writeFileSync(release, "go");
	t.after(async () => { releaseHook(); await harness.close(); });
	mkdirSync(join(harness.root, "agent"), { recursive: true });
	writeFileSync(join(harness.root, "agent", "hooks.json"), JSON.stringify({ SubagentStop: [{ hooks: [{ type: "command", command: process.execPath, args: [
		fileURLToPath(new URL("./fixtures/hooks/gated.cjs", import.meta.url)), ready, release, after, "{}",
	] }] }] }));
	await harness.parent.prompt("Run a workflow whose child must finish teardown", { source: "extension" });
	const original = receiptFrom(harness.parent.messages);
	await until(() => existsSync(ready));
	const child = [...harness.engine.control.conversations.values()][0];
	assert.equal(child.active, undefined, "the failed provider run has settled, but its hook still owns teardown");
	assert.ok(child.exiting);
	assert.equal(existsSync(after), false);
	assert.equal(workflowNotice(harness, original.taskId), undefined, "normal workflow completion cannot race past child teardown");
	let teardownFinished = false;
	const teardown = harness.engine.teardown(child.meta.agentId).then(() => { teardownFinished = true; });
	// A task stop can terminate the script promptly, but must not make its old
	// child teardown or journal obligations disappear from resume admission.
	assert.equal(harness.engine.userStopWorkflow(original.taskId), true);
	assert.equal((await completion(harness, original)).snapshot.status, "killed");
	assert.equal(existsSync(after), false);
	let admission: { accepted: boolean; hookFinished: boolean; teardownFinished: boolean } | undefined;
	const resuming = harness.engine.workflows().launch({ script: source("return 1;", "teardown-fence"), resumeFromRunId: original.runId }, harness.parent.extensionRunner.createContext()).then(result => {
		admission = { accepted: !result.isError, hookFinished: existsSync(after), teardownFinished };
		return result;
	});
	await nextTurn();
	assert.equal(admission, undefined, "resume remains pending at the real hook barrier");
	releaseHook();
	const result = await resuming;
	assert.notEqual(result.isError, true, result.text);
	assert.deepEqual(admission, { accepted: true, hookFinished: true, teardownFinished: true }, "sample teardown state after admission actually resolves, not synchronously before launching it");
	await teardown;
	assert.ok(result.details);
	const next = result.details as unknown as Receipt;
	assert.equal(next.runId, original.runId);
	assert.notEqual(next.taskId, original.taskId);
	const resumed = await completion(harness, next);
	assert.equal(resumed.snapshot.status, "completed");
	assert.equal(resumed.snapshot.result, 1);
	assert.equal(harness.children.size, 1);
});

function nestedFiles(harness: Harness) {
	const workflows = join(harness.root, "agent", "workflows");
	mkdirSync(workflows, { recursive: true });
	const name = "named-wrapper";
	writeFileSync(join(workflows, "wrapper.js"), source("return await workflow({scriptPath:args.path});", name));
	const childPath = join(harness.root, "dynamic-child.js");
	const childSource = source("return 'approved-child-result';", "dynamic-child");
	writeFileSync(childPath, childSource);
	return { name, childPath, childSource, workflows };
}

for (const approved of [false, true]) test(`nested file workflow ${approved ? "honors explicit environment approval" : "refuses headless execution without independent approval"}`, { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({ env: approved ? { PI_WORKFLOW_APPROVE: "1" } : {}, parent: () => ({ text: "done" }), child: () => () => ({ text: "unexpected" }) });
	t.after(() => harness.close());
	const files = nestedFiles(harness);
	const ctx = harness.parent.extensionRunner.createContext();
	assert.equal(ctx.hasUI, false);
	const launched = await harness.engine.workflows().launch({ name: files.name, args: { path: files.childPath } }, ctx);
	assert.notEqual(launched.isError, true, launched.text);
	const { snapshot } = await completion(harness, launched.details as unknown as Receipt);
	assert.equal(snapshot.status, approved ? "completed" : "failed");
	if (approved) assert.equal(snapshot.result, "approved-child-result");
	else { assert.match(snapshot.error ?? "", /approval.*no interactive UI/i); assert.notEqual(snapshot.result, "approved-child-result"); }
	assert.equal(harness.children.size, 0);
});

test("nested dynamic file refusal and approval both review exact bytes; replacement cannot change the approved snapshot", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({ env: {}, parent: () => ({ text: "done" }), child: () => () => ({ text: "unexpected" }) });
	t.after(() => harness.close());
	const files = nestedFiles(harness), base = harness.parent.extensionRunner.createContext();
	const confirmations: string[] = [];
	let allow = false;
	const ctx = { ...base, hasUI: true, ui: { ...base.ui, confirm: async (_title: string, message: string) => {
		confirmations.push(message);
		assert.equal(message, `${files.childPath}\n\n${files.childSource}`);
		if (allow) writeFileSync(files.childPath, source("return 'replacement-must-not-execute';", "dynamic-child"));
		return allow;
	} } };
	const input = { name: files.name, args: { path: files.childPath } };
	const refused = await harness.engine.workflows().launch(input, ctx);
	const refusedResult = await completion(harness, refused.details as unknown as Receipt);
	assert.equal(refusedResult.snapshot.status, "failed");
	assert.match(refusedResult.snapshot.error ?? "", /declined/);
	assert.equal(confirmations.length, 1, "the named wrapper itself did not prompt");
	allow = true;
	const accepted = await harness.engine.workflows().launch(input, ctx);
	const acceptedResult = await completion(harness, accepted.details as unknown as Receipt);
	assert.equal(acceptedResult.snapshot.status, "completed", acceptedResult.snapshot.error);
	assert.equal(acceptedResult.snapshot.result, "approved-child-result");
	assert.match(readFileSync(files.childPath, "utf8"), /replacement-must-not-execute/);
	assert.equal(confirmations.length, 2);
});

test("named nested workflows remain directly invocable without dynamic-file approval", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({ env: {}, parent: () => ({ text: "done" }), child: () => () => ({ text: "unexpected" }) });
	t.after(() => harness.close());
	const files = nestedFiles(harness);
	writeFileSync(join(files.workflows, "wrapper.js"), source("return await workflow('trusted-child');", files.name));
	writeFileSync(join(files.workflows, "child.js"), source("return 'named-child-result';", "trusted-child"));
	const launched = await harness.engine.workflows().launch({ name: files.name }, harness.parent.extensionRunner.createContext());
	assert.notEqual(launched.isError, true, launched.text);
	const { snapshot } = await completion(harness, launched.details as unknown as Receipt);
	assert.equal(snapshot.status, "completed", snapshot.error);
	assert.equal(snapshot.result, "named-child-result");
});

test("long inline scripts are refused before confirmation instead of approving a hidden executable tail", { timeout: 10_000 }, async t => {
	noNetwork(t);
	const harness = await createHarness({ env: {}, parent: () => ({ text: "done" }), child: () => () => ({ text: "unexpected" }) });
	t.after(() => harness.close());
	const base = harness.parent.extensionRunner.createContext();
	let confirmations = 0;
	const ctx = { ...base, hasUI: true, ui: { ...base.ui, confirm: async () => { confirmations++; return true; } } };
	const script = source(`/*${"a".repeat(21_000)}*/ return 'HIDDEN_TAIL_MARKER';`);
	const result = await harness.engine.workflows().launch({ script }, ctx);
	assert.equal(result.isError, true);
	assert.match(result.text, /too long to review completely/i);
	assert.equal(confirmations, 0, "a partial preview must never authorize the tail");
	assert.equal(existsSync(join(harness.root, "agent", "subagents", harness.parent.sessionId, "workflows")), false);
});

for (const mixed of [false, true]) test(`repeated invalid StructuredOutput ${mixed ? "with a read sibling" : "without siblings"} stops the real child at five attempts`, { timeout: 15_000 }, async t => {
	noNetwork(t);
	const script = source("return await agent('Return a count',{schema:{type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}});");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" }, parent: ({ index }) => index === 0 ? launch(script) : { text: "done" },
		child: () => ({ index }) => index < 8 ? { tools: [
			{ name: "StructuredOutput", args: index % 2 ? {} : { result: "wrong type" } },
			...(mixed ? [{ name: "read", args: { path: join(harness.root, "schema-input.txt") } }] : []),
		] } : { text: "escaped the invalid cap" },
	});
	t.after(() => harness.close());
	writeFileSync(join(harness.root, "schema-input.txt"), "Harmless sibling read");
	await harness.parent.prompt("Run the invalid schema regression", { source: "extension" });
	const receipt = receiptFrom(harness.parent.messages), { snapshot } = await completion(harness, receipt);
	assert.equal(snapshot.status, "failed");
	assert.match(snapshot.error ?? "", /5 invalid attempts/);
	assert.equal(harness.children.size, 1, "terminal invalid-output exhaustion must not spawn fresh retry children");
	const child = [...harness.children.values()][0];
	const results = toolResults(child.messages, "StructuredOutput");
	assert.equal(results.length, 5);
	assert.equal([...harness.requests.children.values()][0], 5);
	for (const result of results.slice(0, 4)) { assert.equal(result.isError, true); assert.match(text(result), /Invalid structured output/); }
	assert.match(text(results[4]), /Too many invalid attempts/);
	const reads = toolResults(child.messages, "read");
	assert.equal(reads.length, mixed ? 5 : 0);
	assert.ok(reads.every(result => result.isError === false));
	assert.match(child.getAllTools().find(tool => tool.name === "StructuredOutput")!.description, /Expected result JSON schema.*\n.*count/s);
});

test("Bash prefix clamps block compound/substitution syntax at the actual tool boundary without changing replay rules", { timeout: 15_000 }, async t => {
	noNetwork(t);
	const commands = ["printf SAFE", "pwd", "printf SAFE; printf BAD", "printf SAFE & printf BAD", "printf SAFE | cat", "printf SAFE && printf BAD", "printf SAFE || printf BAD", "printf `printf BAD`", "printf $(printf BAD)", "printf SAFE > CLAMP_TAIL", "printf SAFE < MISSING", "printf SAFE\nprintf BAD", "printf SAFE <<EOF\nBAD\nEOF", "printf (BAD)", "printf SAFE\n"];
	const rules = ["Bash(printf:*)", "Bash(pwd)"];
	const script = source(`return await agent('shell checks',{bashCommandClamp:${JSON.stringify(rules)}});`);
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" }, parent: ({ index }) => index === 0 ? launch(script) : { text: "done" },
		child: () => ({ index }) => index === 0 ? { tools: commands.map(command => ({ name: "bash", args: { command } })) } : { text: "clamp finished" },
	});
	t.after(() => harness.close());
	await harness.parent.prompt("Run the shell control syntax regression", { source: "extension" });
	const receipt = receiptFrom(harness.parent.messages), { snapshot } = await completion(harness, receipt);
	assert.equal(snapshot.status, "completed", snapshot.error);
	const results = toolResults([...harness.children.values()][0].messages, "bash");
	assert.equal(results.length, commands.length);
	for (const [index, result] of results.entries()) {
		assert.equal(result.isError, index >= 2, commands[index]);
		if (index >= 2) assert.match(text(result), /Only these commands are allowed/, commands[index]);
	}
	assert.equal(existsSync(join(harness.root, "CLAMP_TAIL")), false);
	const journal = readFileSync(join(receipt.transcriptDir, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.ok(journal.some(event => event.type === "result" && event.key === chainKey("", "shell checks", { bashCommandClamp: [...rules].sort() })));
});

test("RR05: an exhausted StructuredOutput rejects a later valid handback in the same mixed batch", { timeout: 15_000 }, async t => {
	noNetwork(t);
	const script = source("return await agent('Return a count',{schema:{type:'object',properties:{count:{type:'integer'}},required:['count']}});");
	const harness = await createHarness({
		env: { PI_WORKFLOW_APPROVE: "1" }, parent: ({ index }) => index === 0 ? launch(script) : { text: "done" },
		child: () => ({ index }) => index < 8 ? { tools: [
			{ name: "StructuredOutput", args: { result: "invalid" } },
			{ name: "read", args: { path: join(harness.root, "schema-input.txt") } },
			...(index === 4 ? [{ name: "StructuredOutput", args: { result: { count: 42 } } }] : []),
		] } : { text: "must not reach another turn" },
	});
	t.after(() => harness.close());
	writeFileSync(join(harness.root, "schema-input.txt"), "Harmless sibling read");
	await harness.parent.prompt("Verify exhausted mixed handbacks", { source: "extension" });
	const { snapshot } = await completion(harness, receiptFrom(harness.parent.messages));
	assert.equal(snapshot.status, "failed");
	assert.match(snapshot.error ?? "", /5 invalid attempts/);
	assert.equal(harness.children.size, 1);
	assert.equal([...harness.requests.children.values()][0], 5);
	const handbacks = toolResults([...harness.children.values()][0].messages, "StructuredOutput");
	assert.equal(handbacks.length, 6, "five invalid handbacks plus the explicitly rejected late valid one");
	assert.equal(handbacks[5].isError, true);
	assert.match(text(handbacks[5]), /exhausted.*no further handbacks/i);
	assert.notDeepEqual(snapshot.result, { count: 42 });
});
