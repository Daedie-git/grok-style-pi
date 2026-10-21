import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { runWorkflow } from "../src/workflow/runtime.ts";
import { runInRealm } from "../src/workflow/vm.ts";
import { WorkflowObligations } from "../src/workflow/obligations.ts";
import { chainKey, createReplayState } from "../src/workflow/replay.ts";
import type { WorkflowAgentRequest, WorkflowHost } from "../src/workflow/host.ts";
import type { JournalEvent } from "../src/workflow/journal.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const source = (body: string) => `export const meta={name:'ordering',description:'Ordering fixture'}; ${body}`;
function adapter(execute?: (request: WorkflowAgentRequest) => Promise<void>): WorkflowHost {
	return {
		async runAgent(request) { await execute?.(request); return { status: "completed", agentId: request.prompt, text: request.prompt, outputTokens: 1 }; },
		sessionOutputTokens: () => 0,
		async loadNamed() { return undefined; },
		async readScriptPath() { return { source: source("return 1"), canonicalPath: "/child.js" }; },
		progress() {},
	};
}

for (const fails of [false, true]) {
	test(`permit transfer precedes the outer ${fails ? "failure" : "result"} append but follows host cleanup`, async () => {
		const cleaning = deferred(), cleanup = deferred(), writing = deferred(), write = deferred(), second = deferred();
		const obligations = new WorkflowObligations();
		const host = adapter(async request => {
			if (request.prompt === "first") { cleaning.resolve(); await cleanup.promise; if (fails) throw new Error("executor failed"); }
			else second.resolve();
		});
		const run = runWorkflow({ source: source("return await parallel([()=>agent('first'),()=>agent('second')]);"), host, runId: "wf_order", taskId: "task", concurrency: 1, obligations,
			journal: { async append(event) { if ((event.type === "result" || event.type === "failed") && event.key === chainKey("", "first")) { writing.resolve(); await write.promise; } } },
		});
		await cleaning.promise;
		assert.equal(obligations.count, 2, "both calls register before the second queues for a permit");
		let secondStarted = false; void second.promise.then(() => { secondStarted = true; });
		await nextTurn();
		assert.equal(secondStarted, false, "host cleanup still owns the first permit");
		cleanup.resolve();
		await writing.promise;
		await second.promise;
		assert.ok(obligations.count >= 1, "the outer append retains its obligation after permit transfer");
		assert.equal(await obligations.wait(0), false);
		write.resolve();
		const result = await run;
		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, [fails ? null : "first", "second"]);
		assert.equal(obligations.count, 0);
		assert.equal(obligations.isClosed, true);
	});
}

test("detached cleanup and late journal writes remain owned after the script chain completes", async () => {
	const cleaning = deferred(), cleanup = deferred(), writing = deferred(), write = deferred();
	const obligations = new WorkflowObligations();
	const result = await runWorkflow({ source: source("void agent('detached'); return 'early';"), host: adapter(async () => { cleaning.resolve(); await cleanup.promise; }), runId: "wf_detach", taskId: "task", obligations,
		journal: { async append(event) { if (event.type === "result") { writing.resolve(); await write.promise; } } },
	});
	assert.equal(result.result, "early");
	await cleaning.promise;
	assert.equal(obligations.count, 1);
	assert.equal(obligations.isClosed, true);
	assert.equal(await obligations.wait(0), false);
	assert.throws(() => obligations.register(), /closed/);
	cleanup.resolve();
	await writing.promise;
	assert.equal(obligations.count, 1);
	write.resolve();
	assert.equal(await obligations.wait(), true);
	assert.equal(obligations.count, 0);
});

test("aborted public promises do not prevent internal obligations from reaching quiescence", async () => {
	const controller = new AbortController(), entered = deferred(), obligations = new WorkflowObligations();
	const host = adapter(request => new Promise<void>(resolve => {
		entered.resolve();
		request.signal.addEventListener("abort", () => resolve(), { once: true });
	}));
	const running = runWorkflow({ source: source("return await agent('active')"), host, runId: "wf_abort", taskId: "task", signal: controller.signal, obligations });
	await entered.promise;
	controller.abort();
	assert.equal((await running).status, "killed");
	assert.equal(await obligations.wait(), true);
	assert.equal(obligations.count, 0);
	assert.equal(obligations.isClosed, true);
});

test("empty combinators bypass exhausted call/budget gates, but stage-array caps precede the fast path", async () => {
	const base = { host: adapter(), runId: "wf_empty", taskId: "task", maxCalls: 0 };
	assert.deepEqual((await runWorkflow({ ...base, source: source("return await parallel([])") })).result, []);
	assert.deepEqual((await runWorkflow({ ...base, source: source("return await pipeline([],123)") })).result, []);
	assert.equal((await runWorkflow({ ...base, source: source("return await pipeline([], ...Array(4097).fill(123))") })).status, "failed");
	const host = adapter(); host.sessionOutputTokens = () => 100;
	assert.deepEqual((await runWorkflow({ ...base, host, budgetTotal: 50, source: source("return await pipeline([],123)") })).result, []);
	assert.equal((await runWorkflow({ ...base, host, budgetTotal: 50, source: source("return await pipeline([1])") })).status, "failed");
});

for (const call of ["parallel(123)", "pipeline(null,123)"]) {
	test(`already-aborted ${call} stays pending before validating malformed intake`, async () => {
		const controller = new AbortController();
		let checks = 0, settled = false;
		// The initial execution admission sees false; helper admission sees true.
		// Real event listeners still allow us to terminate the outer realm afterward.
		const signal = {
			get aborted() { return checks++ > 0; },
			addEventListener: controller.signal.addEventListener.bind(controller.signal),
			removeEventListener: controller.signal.removeEventListener.bind(controller.signal),
		} as AbortSignal;
		const run = runInRealm({ body: `return await ${call};`, globals: {}, signal });
		void run.then(() => { settled = true; }, () => { settled = true; });
		await nextTurn();
		assert.equal(settled, false);
		controller.abort();
		await assert.rejects(run, /aborted/);
	});
}

test("path-looking child strings use name lookup; only scriptPath objects use the loader", async () => {
	const calls: string[] = [], host = adapter();
	host.loadNamed = async name => { calls.push(`name:${name}`); return undefined; };
	host.readScriptPath = async path => { calls.push(`path:${path}`); return { source: source("return 1"), canonicalPath: path }; };
	const input = { host, runId: "wf_child", taskId: "task" };
	assert.equal((await runWorkflow({ ...input, source: source("return await workflow('./child.js')") })).status, "failed");
	assert.equal((await runWorkflow({ ...input, source: source("return await workflow({scriptPath:'./child.js'})") })).result, 1);
	assert.deepEqual(calls, ["name:./child.js", "path:./child.js"]);
});

test("unpadded deny/clamp intake normalizes before hashing and forced model suppression precedes hashing", async () => {
	const events: JournalEvent[] = [];
	const run = (body: string, env = {}) => runWorkflow({ source: source(body), host: adapter(), runId: "wf_key", taskId: "task", env, journal: { async append(event) { events.push(event); } } });
	for (const options of ["{disallowedTools:[' Grep ']}", "{disallowedTools:['']}", "{bashCommandClamp:[' Bash(ls) ']}"]) {
		const result = await run(`return await agent('bad',${options})`);
		assert.equal(result.agentCount, 0);
		assert.equal(result.status, "failed");
	}
	await run("return await agent('Inspect A',{disallowedTools:['Read','Grep','Read'],bashCommandClamp:['Bash(pwd)','Bash(ls)']})");
	assert.ok(events.some(event => event.type === "result" && event.key === chainKey("", "Inspect A", { disallowedTools: ["Grep", "Read"], bashCommandClamp: ["Bash(ls)", "Bash(pwd)"] })));
	events.length = 0;
	await run("return await agent('Inspect A',{model:'haiku',effort:'high'})", { PI_SUBAGENT_MODEL_FORCE: "opus" });
	assert.ok(events.some(event => event.type === "result" && event.key === chainKey("", "Inspect A", { effort: "high" })));
});

test("loaded values including false/zero beat failed markers and remote live refusal", async () => {
	for (const value of ["", false, 0, null]) {
		const replay = createReplayState(), options = { isolation: "remote" }, key = chainKey("", "cached", options);
		replay.loadedResults.set(key, { type: "result", key, agentId: "prior", result: value });
		replay.loadedFailed.add(key);
		let launches = 0;
		const result = await runWorkflow({ source: source("return await agent('cached',{isolation:'remote'})"), host: adapter(async () => { launches++; }), runId: "wf_cached", taskId: "task", replay });
		assert.equal(result.status, "completed");
		assert.equal(result.result, value);
		assert.equal(launches, 0);
		assert.equal(replay.loadedResults.size, 1);
		assert.equal(replay.loadedFailed.size, 1);
		assert.equal(replay.liveTail, false);
	}
});
