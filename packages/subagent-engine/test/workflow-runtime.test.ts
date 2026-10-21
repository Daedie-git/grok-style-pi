import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, type WorkflowRunInput } from "../src/workflow/runtime.ts";
import { runInRealm } from "../src/workflow/vm.ts";
import { chainKey, createReplayState } from "../src/workflow/replay.ts";
import type { JournalEvent } from "../src/workflow/journal.ts";
import type { WorkflowAgentRequest, WorkflowAgentResult, WorkflowHost, WorkflowProgress } from "../src/workflow/host.ts";

const source = (body: string) => `export const meta={name:'test',description:'Test',phases:[{title:'Inspect'},{title:'Verify'}]};\n${body}`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function host(run?: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult> | WorkflowAgentResult) {
	const requests: WorkflowAgentRequest[] = [], progress: WorkflowProgress[] = [], journal: JournalEvent[] = [];
	const named = new Map<string, string>();
	let tokens = 123;
	const adapter: WorkflowHost = {
		async runAgent(request) { requests.push(request); const result = run ? await run(request) : { status: "completed" as const, agentId: `a${requests.length}`, text: request.prompt, outputTokens: 2 }; tokens += result.outputTokens; return result; },
		sessionOutputTokens: () => tokens,
		async loadNamed(name) { const script = named.get(name); return script ? { source: script, path: `named:${name}` } : undefined; },
		async readScriptPath(path) { const script = named.get(path); if (!script) throw new Error("missing script"); return { source: script, canonicalPath: path }; },
		progress(event) { progress.push(event); },
	};
	const runWorkflowBody = (body: string, extra: Partial<WorkflowRunInput> = {}) => runWorkflow({ source: source(body), host: adapter, runId: "wf_test", taskId: "task_test", journal: { async append(event) { journal.push(structuredClone(event)); } }, ...extra });
	return { adapter, requests, progress, journal, named, run: runWorkflowBody };
}

test("public workflow entrypoint runs approved bytes, copies args/results and uses the injected clock", async () => {
	const h = host();
	const args = { values: [1] };
	let clock = 0;
	const result = await h.run("args.values.push(2); return await agent(JSON.stringify(args));", { args, now: () => { clock += 5; return clock; } });
	assert.equal(result.status, "completed");
	assert.equal(result.result, '{"values":[1,2]}');
	assert.deepEqual(args, { values: [1] });
	assert.equal(result.agentCount, 1);
	assert.equal(result.durationMs, 5);
	assert.deepEqual(h.requests[0].disallowedTools, ["Agent", "Workflow", "SendUserMessage"]);
});

test("VM defaults expose no host process, filesystem, network or dynamic code capabilities", async () => {
	const result = await runInRealm({ globals: {}, body: `
		const blocked=[];
		for(const attempt of [()=>eval('1'),()=>Function('return process')(),()=>Math.random(),()=>Date.now(),()=>Date(),()=>new Date(),()=>new Date.prototype.constructor()]){try{attempt();blocked.push(false);}catch{blocked.push(true);}}
		return {blocked, absent:[typeof process,typeof require,typeof Buffer,typeof fetch,typeof WebAssembly],date:new Date(0).toISOString()};` });
	assert.deepEqual(result, { blocked: Array(7).fill(true), absent: Array(5).fill("undefined"), date: "1970-01-01T00:00:00.000Z" });
	await assert.rejects(runInRealm({ globals: {}, body: "return import('node:fs')" }), /SyntaxError/);
	await assert.rejects(runInRealm({ globals: {}, body: "return () => 1" }), /function/);
});

test("realm bridge functions, async results and thrown errors cannot expose host constructors", async () => {
	const h = host(() => { throw new Error("host failure"); });
	const result = await h.run(`
		const blocked=[];
		for(const attempt of [()=>log.constructor('return process')(),()=>budget.spent.constructor('return process')(),()=>setTimeout.constructor('return process')()]){try{attempt();blocked.push(false);}catch{blocked.push(true);}}
		try{await agent('fail');}catch(error){try{error.constructor.constructor('return process')();blocked.push(false);}catch{blocked.push(true);}}
		return blocked;`);
	assert.equal(result.status, "completed");
	assert.deepEqual(result.result, [true, true, true, true]);
});

test("synchronous timeout bounds initial loops and loops reached after await", { timeout: 2_000 }, async () => {
	for (const body of ["while(true){}", "await Promise.resolve(); while(true){}"]) {
		await assert.rejects(runInRealm({ body, globals: {}, timeoutMs: 20 }), /timed out/);
	}
	assert.deepEqual(await runInRealm({ body: "return await parallel([async()=>{await Promise.resolve();while(true){}}]);", globals: {}, timeoutMs: 20 }), [null]);
});

test("asynchronous host work can wait independently of the synchronous VM timeout", async () => {
	const entered = deferred(), release = deferred();
	const h = host(async () => { entered.resolve(); await release.promise; return { status: "completed", agentId: "a", text: "after gate", outputTokens: 1 }; });
	const result = h.run("return await agent('wait')", { syncTimeoutMs: 20 });
	await entered.promise;
	release.resolve();
	assert.equal((await result).result, "after gate");
});

test("parallel validates callbacks, starts all slots, joins errors and preserves input order", async () => {
	const second = deferred(), first = deferred();
	const h = host(async request => {
		if (request.prompt === "first") await first.promise;
		else second.resolve();
		return { status: "completed", agentId: request.prompt, text: request.prompt, outputTokens: 1 };
	});
	const result = h.run("return await parallel([()=>agent('first'),()=>agent('second'),()=>{throw new Error('slot failure')}])", { concurrency: 2 });
	await second.promise;
	assert.equal(h.requests.length, 2);
	first.resolve();
	const finished = await result;
	assert.equal(finished.status, "completed");
	assert.deepEqual(finished.result, ["first", "second", null]);
	assert.ok(finished.failures.some(item => item.error === "slot failure"));
	assert.equal((await host().run("return await parallel([Promise.resolve(1)])")).status, "failed");
	assert.deepEqual((await host().run("return await parallel([])")).result, []);
});

test("pipeline passes current/original/index, stops only on null and preserves overlap/order", async () => {
	const h = host();
	const result = await h.run(`return await pipeline([1,2,3],
		(value,original,index)=> index===0 ? null : index===1 ? undefined : value*2,
		(value,original,index)=>({value,original,index}));`);
	assert.deepEqual(result.result, [null, { value: undefined, original: 2, index: 1 }, { value: 6, original: 3, index: 2 }]);
	assert.deepEqual((await h.run("return await pipeline([Promise.resolve(1),2])")).result, [1, 2]);
	assert.deepEqual((await h.run("return await pipeline([],123)")).result, []);
	assert.equal((await h.run("return await pipeline([1],123)")).status, "failed");
});

test("4096-element arrays are accepted without truncation and 4097 refuse", async () => {
	const h = host();
	assert.equal(((await h.run("return await parallel(Array.from({length:4096},(_,i)=>()=>i))")).result as unknown[]).length, 4096);
	assert.equal(((await h.run("return await pipeline(Array.from({length:4096},(_,i)=>i))")).result as unknown[]).length, 4096);
	assert.equal((await h.run("return await parallel(Array.from({length:4097},()=>()=>0))")).status, "failed");
	assert.equal((await h.run("return await pipeline(Array(4097))")).status, "failed");
});

test("phases have stable title indices, explicit overrides and no execution barrier", async () => {
	const gate = deferred(), first = deferred();
	const h = host(async request => { if (request.prompt === "first") { first.resolve(); await gate.promise; } return { status: "completed", agentId: request.prompt, text: request.prompt, outputTokens: 1 }; });
	const result = h.run("phase('Inspect'); const a=agent('first'); phase('Verify'); const b=agent('second',{phase:'Inspect'}); return await Promise.all([a,b]);", { concurrency: 2 });
	await first.promise;
	assert.ok(h.progress.some(event => event.type === "phase" && event.title === "Verify"));
	gate.resolve();
	assert.equal((await result).status, "completed");
	assert.deepEqual(h.requests.map(request => request.phase), ["Inspect", "Inspect"]);
	assert.deepEqual(h.progress.filter(event => event.type === "phase").map(event => [event.index, event.title]), [[1, "Inspect"], [2, "Verify"]]);
});

test("child workflows have fresh realms, shared counters/ledger and forced phases; second nesting refuses", async () => {
	const h = host();
	h.named.set("child", source("phase('ignored'); return {fresh:typeof parentMarker,value:await agent(args.prompt,{phase:'escape'}),spent:budget.spent()};"));
	const result = await h.run("globalThis.parentMarker=1; return await parallel([()=>workflow('child',{prompt:'a'}),()=>workflow('child',{prompt:'b'})]);", { concurrency: 1 });
	assert.equal(result.status, "completed");
	assert.equal(result.agentCount, 2);
	assert.ok((result.result as { fresh: string }[]).every(value => value.fresh === "undefined"));
	assert.deepEqual(h.requests.map(request => request.phase), ["Workflow: child", "Workflow: child #2"]);
	h.named.set("recursive", source("return await workflow('child')"));
	assert.equal((await h.run("return await workflow('recursive')")).status, "failed");
	h.named.set("./path.js", source("return args"));
	assert.deepEqual((await h.run("return await workflow({scriptPath:'./path.js'},{a:1})")).result, { a: 1 });
});

test("logical call caps include replay hits, while retries retain one index", async () => {
	const h = host();
	const replay = createReplayState();
	const key = chainKey("", "cached");
	replay.loadedResults.set(key, { type: "result", key, agentId: "old", result: "old result" });
	const result = await h.run("const first=await agent('cached'); try{await agent('extra')}catch{} return first;", { replay, maxCalls: 1 });
	assert.equal(result.result, "old result");
	assert.equal(result.agentCount, 1);
	assert.equal(h.requests.length, 0);
	assert.ok(h.progress.some(event => event.type === "agent" && event.state === "cached"));
});

test("stall retries stay within one permit and logical index, with five retries maximum", async () => {
	const h = host(request => ({ status: "failed", agentId: `a${request.attempt}`, text: "", stalled: true, outputTokens: 0 }));
	const result = await h.run("return await agent('stall')", { concurrency: 1 });
	assert.equal(result.status, "failed");
	assert.equal(result.agentCount, 1);
	assert.equal(h.requests.length, 6);
	assert.ok(h.requests.every(request => request.logicalIndex === 1));
	assert.deepEqual(h.requests.map(request => request.attempt), [1, 2, 3, 4, 5, 6]);
});

test("schema output requires a trusted attachment, caps invalid handbacks and removes reserved host keys", async () => {
	const valid = host(() => ({ status: "completed", agentId: "a", text: "not JSON", structured: { ok: true, value: { value: 1, webFetchSavedFiles: ["forged"] } }, outputTokens: 1 }));
	assert.deepEqual((await valid.run("return await agent('json',{schema:{type:'object'}})")).result, { value: 1 });
	const missing = host(() => ({ status: "completed", agentId: "a", text: '{"value":1}', outputTokens: 1 }));
	assert.equal((await missing.run("return await agent('json',{schema:{type:'object'}})")).status, "failed");
	assert.equal(missing.requests.length, 2);
	assert.match(missing.requests[1].prompt, /StructuredOutput/);
	const invalid = host(() => ({ status: "completed", agentId: "a", text: "", structured: { ok: false, error: "invalid schema value" }, outputTokens: 1 }));
	assert.equal((await invalid.run("return await agent('json',{schema:{type:'object'}})")).status, "failed");
	assert.equal(invalid.requests.length, 5);
});

test("per-call stall deadlines abort an attempt and retry only after its cleanup settles", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const entered = deferred();
	const h = host(request => {
		if (request.attempt > 1) return { status: "completed", agentId: "retry", text: "recovered", outputTokens: 1 };
		return new Promise<WorkflowAgentResult>(resolve => {
			entered.resolve();
			request.signal.addEventListener("abort", () => resolve({ status: "killed", agentId: "stalled", text: "", outputTokens: 0 }), { once: true });
		});
	});
	const result = h.run("return await agent('wait',{stallMs:10})");
	await entered.promise;
	t.mock.timers.tick(10);
	assert.equal((await result).result, "recovered");
	assert.equal(h.requests.length, 2);
	assert.equal(h.requests[0].signal.aborted, true);
	assert.equal(h.requests[1].signal.aborted, false);
	assert.equal(h.requests[0].logicalIndex, h.requests[1].logicalIndex);
});

test("API failures may be handled as null without failing the top-level workflow", async () => {
	const h = host(() => ({ status: "failed", agentId: "a", text: "partial", error: "API failed", outputTokens: 1 }));
	const result = await h.run("return {value:await agent('fail')}" );
	assert.equal(result.status, "completed");
	assert.deepEqual(result.result, { value: null });
	assert.ok(result.failures.some(item => item.error === "API failed"));
	assert.ok(h.journal.some(event => event.type === "failed"));
});

test("remote isolation refuses before launch and malformed narrowing options do not allocate calls", async () => {
	const h = host();
	const remote = await h.run("return await agent('remote',{isolation:'remote'})");
	assert.equal(remote.status, "failed");
	assert.equal(h.requests.length, 0);
	assert.equal(remote.agentCount, 1);
	for (const options of ["{disallowedTools:['']}", "{bashCommandClamp:['git status']}", "{bashCommandClamp:['bash(git status)']}"]) {
		const result = await h.run(`return await agent('bad',${options})`);
		assert.equal(result.agentCount, 0);
		assert.equal(result.status, "failed");
	}
	await h.run("return await agent('narrow',{disallowedTools:['write'],bashCommandClamp:['Bash(git status)']})");
	assert.ok(h.requests[0].disallowedTools?.includes("REPL"));
	assert.ok(h.requests[0].disallowedTools?.includes("PowerShell"));
	assert.ok(h.requests[0].disallowedTools?.includes("mcp__*"));
});

test("normal budget is unlimited and measures the host session output ledger, not a run baseline", async () => {
	const h = host();
	const result = await h.run("const before=budget.spent(); await agent('spend'); return {total:budget.total,before,after:budget.spent(),remaining:budget.remaining()};");
	assert.deepEqual(result.result, { total: null, before: 123, after: 125, remaining: Infinity });
});

test("abort propagates to active requests and queued waiters release their permits without launching", async () => {
	const controller = new AbortController(), entered = deferred(), acknowledged = deferred();
	const h = host(request => new Promise<WorkflowAgentResult>(resolve => {
		entered.resolve();
		request.signal.addEventListener("abort", () => { acknowledged.resolve(); resolve({ status: "killed", agentId: "a", text: "", outputTokens: 0 }); }, { once: true });
	}));
	const result = h.run("return await parallel([()=>agent('first'),()=>agent('queued')])", { signal: controller.signal, concurrency: 1 });
	await entered.promise;
	controller.abort();
	assert.equal((await result).status, "killed");
	await acknowledged.promise;
	await Promise.resolve();
	assert.equal(h.requests.length, 1);
});

test("early script return does not join detached agent work, but its eventual result still journals", async () => {
	const entered = deferred(), release = deferred(), wrote = deferred();
	const h = host(async () => { entered.resolve(); await release.promise; return { status: "completed", agentId: "a", text: "later", outputTokens: 1 }; });
	const result = await h.run("void agent('detached'); return 'early';", { journal: { async append(event) { h.journal.push(event); if (event.type === "result") wrote.resolve(); } } });
	assert.equal(result.result, "early");
	await entered.promise;
	assert.equal(h.journal.some(event => event.type === "result"), false);
	release.resolve();
	await wrote.promise;
	assert.ok(h.journal.some(event => event.type === "result"));
});

test("finite helper budgets allow concurrent overshoot but recheck queued admissions", async () => {
	const entered = deferred(), release = deferred();
	let started = 0;
	const h = host(async request => {
		if (++started === 2) entered.resolve();
		await release.promise;
		return { status: "completed", agentId: request.prompt, text: request.prompt, outputTokens: 3 };
	});
	const running = h.run("const values=await parallel([()=>agent('a'),()=>agent('b'),()=>agent('queued')]); return {values,spent:budget.spent(),remaining:budget.remaining()};", { budgetTotal: 125, concurrency: 2 });
	await entered.promise;
	assert.equal(h.requests.length, 2);
	release.resolve();
	const result = await running;
	assert.equal(result.status, "completed");
	assert.deepEqual(result.result, { values: ["a", "b", null], spent: 129, remaining: 0 });
	assert.equal(h.requests.length, 2, "the third queued call rechecks the spent ledger after acquiring");
});

test("the full 1000-call boundary counts cached calls without launching agents", async () => {
	const h = host(), replay = createReplayState();
	let previous = "";
	for (let index = 0; index < 1000; index++) {
		const key = chainKey(previous, "cached");
		replay.loadedResults.set(key, { type: "result", key, agentId: `a${index}`, result: index });
		previous = key;
	}
	const result = await h.run("let last; for(let i=0;i<1000;i++)last=await agent('cached'); try{await agent('extra')}catch(error){return {last,error:error.message};}", { replay });
	assert.equal(result.status, "completed");
	assert.equal(result.agentCount, 1000);
	assert.equal((result.result as { last: number }).last, 999);
	assert.match((result.result as { error: string }).error, /call limit/);
	assert.equal(h.requests.length, 0);
});

test("current failure after a started-only replay miss does not invalidate a later loaded result", async () => {
	const h = host(() => { throw new Error("new failure"); }), replay = createReplayState();
	const first = chainKey("", "interrupted"), second = chainKey(first, "later");
	replay.loadedStarted.set(first, [{ type: "started", key: first, agentId: "old" }]);
	replay.loadedResults.set(second, { type: "result", key: second, agentId: "cached", result: "cached later" });
	const result = await h.run("try{await agent('interrupted')}catch{} return await agent('later');", { replay });
	assert.equal(result.result, "cached later");
	assert.equal(h.requests.length, 1);
	assert.equal(replay.loadedFailed.size, 0);
	assert.ok(h.journal.some(event => event.type === "failed"));
});

test("journal failure warns rather than replacing a successful workflow result", async () => {
	const h = host();
	const result = await h.run("return await agent('success')", { journal: { async append() { throw new Error("disk full"); } } });
	assert.equal(result.status, "completed");
	assert.equal(result.result, "success");
	assert.ok(result.logs.some(message => message.includes("disk full")));
});

test("logs retain only their first 1000 messages and syntax failures launch no agents", async () => {
	const h = host();
	const result = await h.run("for(let i=0;i<1002;i++) log(String(i)); return 1");
	assert.equal(result.logs.length, 1000);
	assert.equal(result.logs[999], "999");
	assert.equal(h.progress.filter(event => event.type === "log").length, 1002);
	assert.equal((await h.run("return import('x')")).status, "failed");
	assert.equal(h.requests.length, 0);
});
