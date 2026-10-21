import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { parseWorkflowSource } from "../src/workflow/meta.ts";
import { compileBody } from "../src/workflow/compile.ts";
import { canonicalOptions, chainKey, chooseReplay, createReplayState } from "../src/workflow/replay.ts";
import { WorkflowJournal, readJournalTail, MAX_JOURNAL_TAIL_BYTES } from "../src/workflow/journal.ts";
import { readFile as readFileAsync } from "node:fs/promises";
import { matchesBashRule } from "../src/workflow-host.ts";
import { defaultConcurrency, FifoPermits } from "../src/workflow/permits.ts";
import { discoverWorkflows } from "../src/workflow/discovery.ts";

const source = (body: string, name = "sample") => `export const meta={name:${JSON.stringify(name)},description:'Test workflow'};\n${body}`;
function fixture(t: TestContext) {
	const captures = resolve(import.meta.dirname, "../../../captures");
	mkdirSync(captures, { recursive: true });
	const root = mkdtempSync(join(captures, "workflow-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
	return root;
}

test("workflow metadata accepts recursive literal values and normalizes display fields", () => {
	const parsed = parseWorkflowSource("/* first comment */ export const meta={name:'x',description:`description`,unknown:{a:[null,true,-3]},phases:[{title:'',detail:'d'},4,{title:'Two',model:'m'}]}; return 1;");
	assert.equal(parsed.error, undefined);
	assert.deepEqual(parsed.meta, { name: "x", description: "description", phases: [{ title: "", detail: "d" }, { title: "Two", model: "m" }] });
	assert.match(parsed.body, /return 1/);
});

test("metadata refuses alternate entrypoints, nonliteral expressions, unsafe keys and malformed declarations", () => {
	for (const script of ["export default function main(){}", "const x=1;" + source("return x"), "export let meta={name:'x',description:'d'};", "export const meta={name:'x',description:'d'},other=1;", "export const meta={name:'x',description:'d',...other};", "export const meta={name:'x',description:'d',[key]:1};", "export const meta={name:'x',description:'d',method(){}};", "export const meta={name:'x',description:'d',get value(){return 1}};", "export const meta={name:'x',description:'d',deep:{constructor:1}};", "export const meta={name:'x',description:'d',a:[,]};", "export const meta={name:'x',description:`${Date.now()}`};", "export const meta={name:'',description:'d'};"]) {
		assert.ok(parseWorkflowSource(script).error, script);
	}
	assert.ok(parseWorkflowSource("x".repeat(524_289)).error);
});

test("workflow compiler rejects imports, body exports, with, reserved identifiers and unsupported syntax", () => {
	assert.deepEqual(compileBody("return await Promise.resolve(1)"), { ok: true });
	for (const body of ["return import('node:fs')", "with({}){}", "export const x=1", "import x from 'x'", "const __wRg$private=1", "const __workflow$private=1", "await using x = y", "return ; broken("]) assert.equal(compileBody(body).ok, false, body);
});

test("replay key sorting preserves arrays, ignores label/phase/stall and distinguishes positional calls", () => {
	assert.equal(canonicalOptions({ schema: { b: 2, a: 1 }, label: "x", phase: "p", stallMs: 2 }), canonicalOptions({ schema: { a: 1, b: 2 } }));
	assert.notEqual(chainKey("", "prompt", { schema: { enum: [1, 2] } }), chainKey("", "prompt", { schema: { enum: [2, 1] } }));
	const first = chainKey("", "same");
	assert.notEqual(chainKey(first, "same"), first);
	assert.equal(canonicalOptions({ model: undefined, schema: { a: () => 1, b: [undefined, () => 1] } }), '{"schema":{"b":[null,null]}}');
});

test("all 14 finalized replay vectors match canonical bytes, preimages and SHA256 keys", () => {
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/workflow/replay-vectors.json", import.meta.url), "utf8")) as { vectors: { name: string; previousKey: string; prompt: string; canonical: string; canonicalUtf8Hex: string; preimageUtf8Hex: string; key: string }[] };
	const options: Record<string, Record<string, unknown>> = {
		"empty-options": {}, "positional-repeat": {},
		"nested-key-order-A": { schema: { type: "object", properties: { z: { type: "number" }, a: { type: "string" } }, required: ["z", "a"] }, model: "sonnet" },
		"nested-key-order-B": { model: "sonnet", schema: { required: ["z", "a"], properties: { a: { type: "string" }, z: { type: "number" } }, type: "object" } },
		"array-order-changes-key": { model: "sonnet", schema: { type: "object", properties: { a: { type: "string" }, z: { type: "number" } }, required: ["a", "z"] } },
		"omitted-members": { model: undefined, effort: () => 1, label: "ignored", phase: "ignored", stallMs: 1, schema: { type: "object", ignored: undefined, fn: () => 1, values: [, undefined, () => 1, null] } },
		"integer-like-object-keys": { schema: JSON.parse('{"10":"ten","2":"two","01":"leading","__proto__":"drop","a":"last"}') },
		"raw-effort-med": { effort: "med" }, "raw-effort-medium": { effort: "medium" },
		"unicode-utf8": { agentType: "Explore", schema: { type: "object", description: "é" } },
		"label-phase-timeout-not-key": { label: "another", phase: "Other", stallMs: 999 },
		"normalized-denies-clamps-A": { disallowedTools: ["Grep", "Read"], bashCommandClamp: ["Bash(ls)", "Bash(pwd)"] },
		"normalized-denies-clamps-B": { bashCommandClamp: ["Bash(ls)", "Bash(pwd)"], disallowedTools: ["Grep", "Read"] },
		"force-suppressed-model": { effort: "high" },
	};
	assert.equal(fixture.vectors.length, 14);
	for (const vector of fixture.vectors) {
		assert.ok(Object.hasOwn(options, vector.name));
		const canonical = canonicalOptions(options[vector.name]);
		assert.equal(canonical, vector.canonical, vector.name);
		assert.equal(Buffer.from(canonical).toString("hex"), vector.canonicalUtf8Hex, vector.name);
		assert.equal(Buffer.from(`${vector.previousKey}\0${vector.prompt}\0${canonical}`).toString("hex"), vector.preimageUtf8Hex, vector.name);
		assert.equal(chainKey(vector.previousKey, vector.prompt, options[vector.name]), vector.key, vector.name);
	}
});

test("replay returns independent cached empty and null values", () => {
	const state = createReplayState();
	let previous = "";
	for (const value of ["", false, 0, null, [], { mutable: [1] }]) {
		const key = chainKey(previous, "same");
		state.loadedResults.set(key, { type: "result", key, agentId: "a", result: value });
		previous = key;
	}
	assert.deepEqual(Array.from({ length: 5 }, () => chooseReplay("same", {}, state)).map(item => "cached" in item ? item.cached : "MISS"), ["", false, 0, null, []]);
	const last = chooseReplay("same", {}, state);
	assert.ok("cached" in last);
	(last.cached as { mutable: number[] }).mutable.push(2);
	assert.deepEqual(state.loadedResults.get(last.key)!.result, { mutable: [1] });
});

test("new and prior-failed misses fence the suffix; started-only misses preserve later eligibility", () => {
	for (const mode of ["new", "failed", "interrupted"] as const) {
		const first = chainKey("", "first"), second = chainKey(first, "second");
		const state = createReplayState();
		state.loadedResults.set(second, { type: "result", key: second, agentId: "second", result: "cached" });
		if (mode !== "new") state.loadedStarted.set(first, [{ type: "started", key: first, agentId: "first" }]);
		if (mode === "failed") state.loadedFailed.add(first);
		assert.ok("executeLive" in chooseReplay("first", {}, state));
		const choice = chooseReplay("second", {}, state);
		assert.equal("cached" in choice, mode === "interrupted");
	}
});

test("loaded results win over old failure markers and current writes are not an intra-run cache", () => {
	const state = createReplayState(), key = chainKey("", "first");
	state.loadedResults.set(key, { type: "result", key, agentId: "a", result: "old" });
	state.loadedFailed.add(key);
	assert.ok("cached" in chooseReplay("first", {}, state));
	const fresh = createReplayState();
	chooseReplay("first", {}, fresh);
	assert.equal(fresh.loadedResults.size, 0);
	assert.equal(fresh.loadedFailed.size, 0);
});

test("journal persists ordered attempts, last result and first digest across reopen", async t => {
	const file = join(fixture(t), "run", "journal.jsonl");
	const journal = new WorkflowJournal(file), key = chainKey("", "first");
	assert.equal(await journal.restoreState(), "missing");
	await journal.append({ type: "launched", scriptSha256: "a".repeat(64) });
	await Promise.all([journal.append({ type: "started", key, agentId: "a" }), journal.append({ type: "started", key, agentId: "b" }), journal.append({ type: "failed", key, agentId: "a" }), journal.append({ type: "result", key, agentId: "b", result: "" }), journal.append({ type: "result", key, agentId: "b", result: null })]);
	await journal.append({ type: "launched", scriptSha256: "b".repeat(64) });
	const loaded = await new WorkflowJournal(file).load();
	assert.equal(loaded.results.get(key)!.result, null);
	assert.equal(loaded.started.get(key)!.length, 2);
	assert.ok(loaded.failed.has(key));
	assert.equal(loaded.scriptSha256, "a".repeat(64));
	assert.equal(loaded.hasUnreadLine, false);
	assert.equal(await journal.restoreState(), "complete");
});

test("journal tolerates a torn final data line but not concealed script identity", async t => {
	const file = join(fixture(t), "journal.jsonl");
	writeFileSync(file, '{"type":"started"');
	const journal = new WorkflowJournal(file);
	assert.equal((await journal.load()).hasUnreadLine, false);
	await journal.append({ type: "launched", scriptSha256: "a".repeat(64) });
	assert.equal((await journal.load()).hasUnreadLine, false);
	writeFileSync(file, '{"type":"launched","scriptSha256":');
	assert.equal((await journal.load()).hasUnreadLine, true);
	writeFileSync(file, '{"type":"restoring"}\n');
	assert.equal(await journal.restoreState(), "partial");
	await journal.append({ type: "restored" });
	assert.equal(await journal.restoreState(), "complete");
});

test("journal crash window preserves started-only history rather than inventing an exactly-once result", async t => {
	const journal = new WorkflowJournal(join(fixture(t), "journal.jsonl"));
	const key = chainKey("", "side effect");
	await journal.append({ type: "started", key, agentId: "a" });
	const loaded = await journal.load();
	assert.equal(loaded.results.size, 0);
	const state = createReplayState(loaded);
	assert.ok("executeLive" in chooseReplay("side effect", {}, state));
	assert.equal(state.liveTail, false);
});

test("FIFO permits transfer after failure and aborted waiters still acquire then release", async () => {
	const permits = new FifoPermits(1), release = await permits.acquire();
	const order: number[] = [];
	const controller = new AbortController();
	const first = permits.run(async () => { order.push(1); assert.equal(controller.signal.aborted, true); throw new Error("aborted after acquire"); });
	const second = permits.run(async () => { order.push(2); return "done"; });
	controller.abort(); release(); release();
	await assert.rejects(first, /aborted/);
	assert.equal(await second, "done");
	assert.deepEqual(order, [1, 2]);
	assert.equal(await permits.run(async () => "available"), "available");
});

test("concurrency overrides accept only integer 1..256; malformed values use CPU default", () => {
	const fallback = defaultConcurrency({});
	assert.ok(fallback >= 2 && fallback <= 16);
	for (const value of ["1", "256", " +3 "]) assert.equal(defaultConcurrency({ PI_WORKFLOW_CONCURRENCY: value }), Number(value));
	for (const value of ["0", "-1", "257", "1.5", "2x", ""]) assert.equal(defaultConcurrency({ PI_WORKFLOW_CONCURRENCY: value }), fallback);
});

test("discovery is immediate .js, metadata-named, trusted and nearest-project-first", t => {
	const root = fixture(t), agentDir = join(root, "agent"), cwd = join(root, "repo", "child");
	function put(dir: string, filename: string, script: string) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, filename), script); }
	put(join(agentDir, "workflows"), "filename.js", source("return 'user'", "winner"));
	put(join(root, "repo", ".pi", "workflows"), "ancestor.js", source("return 'ancestor'", "winner"));
	put(join(cwd, ".claude", "workflows"), "nearest.js", source("return 'nearest'", "winner"));
	put(join(cwd, ".claude", "workflows", "nested"), "hidden.js", source("return 1", "hidden"));
	put(join(cwd, ".pi", "workflows"), "ignored.ts", source("return 1", "typescript"));
	const options = { agentDir, cwd, homeDir: root, bundled: [{ source: source("return 'bundled'", "winner") }] };
	const trusted = discoverWorkflows({ ...options, projectTrusted: true });
	assert.equal(trusted.size, 1);
	assert.equal(trusted.get("winner")!.origin, "project");
	assert.match(trusted.get("winner")!.source, /nearest/);
	assert.match(discoverWorkflows({ ...options, projectTrusted: false }).get("winner")!.source, /user/);
	put(join(cwd, ".claude", "workflows"), "nearest.js", source("return import('x')", "winner"));
	assert.match(discoverWorkflows({ ...options, projectTrusted: true }).get("winner")!.source, /ancestor/);
});

test("journal append inspects one bounded suffix per exclusive writer, not historical contents per event", async t => {
	const file = join(fixture(t), "journal.jsonl"), seed = chainKey("", "seed");
	writeFileSync(file, `${JSON.stringify({ type: "result", key: seed, agentId: "seed", result: "x".repeat(100_000) })}\n`);
	let wholeReads = 0, tailReads = 0, tailBytes = 0;
	const journal = new WorkflowJournal(file, {
		async readFile(path) { wholeReads++; return readFileAsync(path, "utf8"); },
		async readTail(path, limit) {
			tailReads++;
			const tail = await readJournalTail(path, limit);
			tailBytes += tail?.bytesRead ?? 0;
			return tail;
		},
	});
	const events = [];
	for (let index = 0; index < 100; index++) {
		const key = chainKey("", `request ${index}`);
		events.push(journal.append({ type: "started", key, agentId: `a${index}` }));
		events.push(journal.append({ type: "result", key, agentId: `a${index}`, result: "r".repeat(32_768) }));
	}
	await Promise.all(events);
	assert.equal(wholeReads, 0, "append must never use the full-history reader");
	assert.equal(tailReads, 1);
	assert.equal(tailBytes, MAX_JOURNAL_TAIL_BYTES);
	const loaded = await journal.load();
	assert.equal(wholeReads, 1, "full history is read only for explicit replay loading");
	assert.equal(loaded.results.size, 101);
	assert.equal(loaded.started.size, 100);
	assert.equal(loaded.hasUnreadLine, false);
});

for (const torn of [false, true]) test(`bounded journal-tail repair preserves a ${torn ? "torn" : "complete"} oversized final line without a newline`, async t => {
	const file = join(fixture(t), "journal.jsonl"), first = chainKey("", "first"), second = chainKey(first, "second");
	const line = JSON.stringify({ type: "result", key: first, agentId: "first", result: "x".repeat(MAX_JOURNAL_TAIL_BYTES * 2) });
	writeFileSync(file, torn ? line.slice(0, -1) : line);
	const journal = new WorkflowJournal(file);
	await journal.append({ type: "result", key: second, agentId: "second", result: "new result" });
	await journal.append({ type: "failed", key: second, agentId: "second" });
	const loaded = await journal.load();
	assert.equal(loaded.results.has(first), !torn);
	assert.equal(loaded.results.get(second)?.result, "new result");
	assert.equal(loaded.hasUnreadLine, false);
	assert.equal(loaded.failed.has(second), true);
});

test("Bash clamp exact/prefix matching refuses all shell control and substitution syntax", () => {
	assert.equal(matchesBashRule("Bash(pwd)", "pwd"), true);
	assert.equal(matchesBashRule("Bash(pwd)", "pwd -P"), false);
	assert.equal(matchesBashRule("Bash(git status:*)", "git status"), true);
	assert.equal(matchesBashRule("Bash(git status:*)", "git status --short"), true);
	assert.equal(matchesBashRule("Bash(git status:*)", "git status-other"), false);
	for (const suffix of ["; pwd", " & pwd", " | cat", " && pwd", " || pwd", " `pwd`", " $(pwd)", " (pwd)", " > out", " < input", "\npwd", "\r\npwd", " <<EOF\ndata\nEOF", "\n"]) {
		assert.equal(matchesBashRule("Bash(git status:*)", `git status ${suffix}`), false, suffix);
		assert.equal(matchesBashRule("Bash(*)", `git status ${suffix}`), false, `wildcard: ${suffix}`);
	}
});
