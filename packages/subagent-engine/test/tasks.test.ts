import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lockDirectory } from "../src/tasks/lock.ts";
import { resolveTaskListId, sanitizeListId, TaskStore } from "../src/tasks/store.ts";

function fixture(t: { after(fn: () => void): void }): { root: string; listId: string } {
	const root = mkdtempSync(join(tmpdir(), "shared-tasks-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, listId: "list" };
}
async function create(store: TaskStore, subject = "task"): Promise<string> {
	const result = await store.create({ subject, description: "details" });
	assert.ok(result.task, result.error);
	return result.task.id;
}

/** Real independent public-API callers, released together after both finish importing. */
async function race(input: { root: string; listId: string }, scripts: string[]): Promise<any[]> {
	const url = new URL("../src/tasks/store.ts", import.meta.url).href;
	const jobs = scripts.map(script => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", `
			import { TaskStore } from ${JSON.stringify(url)};
			const store = new TaskStore(${JSON.stringify(input)});
			console.log("READY");
			await new Promise(resolve => process.stdin.once("data", resolve));
			process.stdin.pause();
			const result = await (async () => { ${script} })();
			console.log(JSON.stringify(result));
		`], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		let readyResolve!: () => void;
		let readyReject!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
		child.stdout.on("data", data => { stdout += data; if (stdout.includes("READY\n") || stdout.includes("READY\r\n")) readyResolve(); });
		child.stderr.on("data", data => { stderr += data; });
		const done = new Promise<any>((resolve, reject) => {
			child.on("error", error => { readyReject(error); reject(error); });
			child.on("close", code => {
				if (code !== 0) { const error = new Error(stderr || `Child exited ${code}`); readyReject(error); reject(error); }
				else { try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)); } catch (error) { reject(error); } }
			});
		});
		// Observe early rejection even while waiting for the ready barrier.
		done.catch(() => {});
		return { child, ready, done };
	});
	try {
		await Promise.all(jobs.map(job => job.ready));
		for (const job of jobs) job.child.stdin.end("go\n");
		return await Promise.all(jobs.map(job => job.done));
	} finally { for (const job of jobs) job.child.kill(); }
}

test("list identifiers use the explicit override and are safe path components", () => {
	assert.equal(resolveTaskListId({}, "root-session"), "root-session");
	assert.equal(resolveTaskListId({ PI_TASK_LIST_ID: "shared" }, "root"), "shared");
	assert.equal(sanitizeListId("../a/b:c"), "___a_b_c");
	assert.equal(sanitizeListId(""), "default");
	assert.equal(sanitizeListId("CON"), "_CON");
});

test("allocation persists a watermark across deletion and creation veto", async t => {
	const input = fixture(t);
	const store = new TaskStore(input);
	const first = await create(store);
	assert.equal(first, "1");
	await store.update(first, { status: "deleted" });
	assert.equal(await create(new TaskStore(input)), "2");
	let hookTask: string | undefined;
	const blocked = new TaskStore({ ...input, hooks: { created: async task => {
		hookTask = task.id;
		// Hooks are outside both list and task locks.
		assert.equal((await store.update(task.id, { description: "hook edit" })).task!.description, "hook edit");
		return { block: "creation denied" };
	} } });
	assert.deepEqual(await blocked.create({ subject: "veto", description: "details" }), { error: "creation denied" });
	assert.equal(hookTask, "3");
	assert.equal(await store.get("3"), null);
	assert.equal(await create(store), "4");
	assert.equal(readFileSync(join(input.root, input.listId, ".highwatermark"), "utf8").trim(), "4");
	assert.ok(!readdirSync(join(input.root, input.listId)).some(name => name.endsWith(".lock") || name === ".lock"));
});

test("completion veto sees stored fields and commits none of a multifield update", async t => {
	const input = fixture(t);
	const other = new TaskStore(input);
	const endpoint = await create(other, "blocker");
	let calls = 0;
	const store = new TaskStore({ ...input, hooks: { completed: async task => {
		calls++;
		assert.equal(task.subject, "original");
		assert.equal(task.description, "details");
		assert.equal(task.status, "pending");
		assert.ok(await other.get(task.id));
		// Also prove an unrelated mutation can acquire locks during the hook.
		await other.update(endpoint, { activeForm: "hook" });
		return { block: "not finished" };
	} } });
	const id = await create(store, "original");
	const before = await store.get(id);
	assert.deepEqual(await store.update(id, { subject: "new", description: "new", owner: "worker", metadata: { added: true }, status: "completed", addBlockedBy: [endpoint] }), { error: "not finished", updatedFields: [] });
	assert.equal(calls, 1);
	assert.deepEqual(await store.get(id), before);
	assert.deepEqual((await store.get(endpoint))!.blocks, []);
});

test("completion admission retries when the hook's stored snapshot changes", async t => {
	const input = fixture(t);
	const other = new TaskStore(input);
	const seen: string[] = [];
	const store = new TaskStore({ ...input, hooks: { completed: async task => {
		seen.push(task.subject);
		if (seen.length === 1) await other.update(task.id, { subject: "changed during hook" });
		return {};
	} } });
	const id = await create(store, "old");
	assert.equal((await store.update(id, { status: "completed" })).task!.status, "completed");
	assert.deepEqual(seen, ["old", "changed during hook"]);
	await store.update(id, { status: "completed", description: "already complete" });
	assert.equal(seen.length, 2);
});

test("list projects summaries, filters internal/completed blockers, and sorts numerically", async t => {
	const store = new TaskStore(fixture(t));
	for (let i = 1; i <= 11; i++) await create(store, `task ${i}`);
	await store.update("1", { metadata: { _internal: true } });
	await store.update("2", { addBlockedBy: ["3", "4", "3", "999"], owner: "owner", activeForm: "doing" });
	await store.update("3", { status: "completed" });
	const list = await store.list();
	assert.deepEqual(list.map(task => task.id), ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
	assert.deepEqual(list[0], { id: "2", subject: "task 2", status: "pending", owner: "owner", blockedBy: ["4"] });
	assert.deepEqual((await store.get("2"))!.blockedBy, ["3", "4"]);
	assert.deepEqual((await store.get("3"))!.blocks, ["2"]);
	assert.equal(await store.get("999"), null);
});

test("metadata null deletes keys; owner assignment and cycles remain compatible", async t => {
	const store = new TaskStore(fixture(t));
	const a = await create(store), b = await create(store);
	await store.update(a, { metadata: { remove: 1, keep: 2 }, owner: "old", addBlocks: [b] });
	await store.update(a, { metadata: { remove: null, new: 3 }, owner: "new", addBlockedBy: [b] });
	assert.deepEqual((await store.get(a))!.metadata, { keep: 2, new: 3 });
	assert.equal((await store.get(a))!.owner, "new");
	assert.deepEqual((await store.get(b))!.blocks, [a]);
	assert.deepEqual((await store.get(b))!.blockedBy, [a]);
	await store.update(b, { status: "deleted" });
	assert.deepEqual((await store.get(a))!.blocks, []);
	assert.deepEqual((await store.get(a))!.blockedBy, []);
});

test("claim rejects open blockers, foreign owners, completion and busy owners", async t => {
	const input = fixture(t);
	const store = new TaskStore(input);
	const a = await create(store), b = await create(store), c = await create(store);
	await store.update(b, { addBlockedBy: [a] });
	assert.equal((await store.claim(b, "worker")).ok, false);
	await store.update(a, { status: "completed" });
	assert.deepEqual(await store.claim(b, "worker"), { ok: true });
	assert.deepEqual(await store.claim(b, "worker"), { ok: true });
	assert.equal((await store.claim(b, "other")).ok, false);
	assert.equal((await store.claim(c, "worker", { busyCheck: true })).ok, false);
	assert.equal((await store.claim(a, "worker")).ok, false);
	// A missing blocker is ignored even if a legacy record retains its id.
	const task = (await store.get(c))!;
	task.blockedBy = ["999"];
	writeFileSync(join(input.root, input.listId, `${c}.json`), JSON.stringify(task));
	assert.deepEqual(await store.claim(c, "worker"), { ok: true });
});

test("two independent processes claim one task: exactly one wins", async t => {
	const input = fixture(t);
	const store = new TaskStore(input);
	const id = await create(store);
	const results = await race(input, [
		`return await store.claim(${JSON.stringify(id)}, "alpha");`,
		`return await store.claim(${JSON.stringify(id)}, "beta");`,
	]);
	assert.equal(results.filter(result => result.ok).length, 1);
	assert.equal((await store.get(id))!.owner, results[0].ok ? "alpha" : "beta");
});

test("independent busy claims cannot give one owner two unfinished tasks", async t => {
	const input = fixture(t);
	const store = new TaskStore(input);
	const a = await create(store), b = await create(store);
	const results = await race(input, [
		`return await store.claim(${JSON.stringify(a)}, "worker", { busyCheck: true });`,
		`return await store.claim(${JSON.stringify(b)}, "worker", { busyCheck: true });`,
	]);
	assert.equal(results.filter(result => result.ok).length, 1);
});

test("independent claim versus public update shares the task lock", async t => {
	const input = fixture(t);
	const store = new TaskStore(input);
	const id = await create(store);
	await race(input, [
		`return await store.claim(${JSON.stringify(id)}, "claimant");`,
		`return await store.update(${JSON.stringify(id)}, { owner: "assigned", subject: "edited" });`,
	]);
	const task = (await store.get(id))!;
	assert.equal(task.owner, "assigned");
	assert.equal(task.subject, "edited");
});

test("independent deletion versus reciprocal edge addition cannot resurrect references", async t => {
	const input = fixture(t);
	const store = new TaskStore(input);
	const a = await create(store), b = await create(store);
	await race(input, [
		`return await store.update(${JSON.stringify(a)}, { status: "deleted" });`,
		`return await store.update(${JSON.stringify(b)}, { addBlocks: [${JSON.stringify(a)}] });`,
	]);
	assert.equal(await store.get(a), null);
	assert.deepEqual((await store.get(b))!.blocks, []);
});

test("independent allocators never reuse ids", async t => {
	const input = fixture(t);
	const results = await race(input, Array.from({ length: 3 }, (_, i) => `
		const ids = [];
		for (let j = 0; j < 5; j++) ids.push((await store.create({subject: "worker ${i}", description: "test"})).task.id);
		return ids;`));
	assert.deepEqual(results.flat().map(Number).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
});

test("independent stale reapers preserve single-winner claim semantics", async t => {
	const input = fixture(t);
	const store = new TaskStore(input);
	const id = await create(store);
	const lock = join(input.root, input.listId, ".lock");
	mkdirSync(lock);
	writeFileSync(join(lock, "owner"), "exited process");
	const old = new Date(Date.now() - 20_000);
	utimesSync(join(lock, "owner"), old, old);
	const results = await race(input, [
		`return await store.claim(${JSON.stringify(id)}, "alpha");`,
		`return await store.claim(${JSON.stringify(id)}, "beta");`,
	]);
	assert.equal(results.filter(result => result.ok).length, 1);
});

test("stale mkdir leases recover and held leases release on exceptions", async t => {
	const input = fixture(t);
	const dir = join(input.root, input.listId);
	mkdirSync(dir);
	const path = join(dir, ".lock");
	mkdirSync(path);
	writeFileSync(join(path, "owner"), "dead owner");
	const old = new Date(Date.now() - 20_000);
	utimesSync(path, old, old);
	utimesSync(join(path, "owner"), old, old);
	const release = await lockDirectory(path);
	release();
	const store = new TaskStore(input);
	const id = await create(store);
	writeFileSync(join(dir, `${id}.json`), "{corrupt");
	await assert.rejects(store.claim(id, "worker"));
	assert.ok(!readdirSync(dir).some(name => name.endsWith(".lock")));
});
