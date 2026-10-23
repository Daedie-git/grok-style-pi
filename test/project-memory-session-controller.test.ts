import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMemorySession } from "../src/extension/project-memory-session.ts";
import type { ProjectMemoryContext } from "../src/extension/project-memory.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function memory(content: string): ProjectMemoryContext {
	return { projectRoot: "/project", directory: "/storage/project", indexPath: "/storage/project/MEMORY.md", content };
}

function fixture() {
	const requests: Array<ReturnType<typeof deferred<ProjectMemoryContext>> & {
		cwd: string;
		storageRoot: string;
		signal: AbortSignal;
		aborts: number;
	}> = [];
	const warnings: Array<{ message: string; kind: string }> = [];
	const loadMemory = (cwd: string, storageRoot: string, options?: { signal?: AbortSignal }) => {
		assert.ok(options?.signal, "every request must receive cancellation");
		const request = { ...deferred<ProjectMemoryContext>(), cwd, storageRoot, signal: options.signal, aborts: 0 };
		request.signal.addEventListener("abort", () => { request.aborts++; }, { once: true });
		requests.push(request);
		return request.promise;
	};
	const ctx = {
		cwd: "/first",
		ui: { notify(message: string, kind: "warning") { warnings.push({ message, kind }); } },
	};
	return { requests, warnings, loadMemory, ctx };
}

const block = (content: string) => `\n\n<grok_project_memory>\n${content}\n</grok_project_memory>`;

test("disabled memory withdraws only its structured section without calling the loader or validating storage", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: false, loadMemory });
	const sections = { grok_project_memory: "old", project_memory: "another owner", communication: "unchanged" };
	assert.equal(await session.beforeAgentStart({ systemPrompt: "base", systemPromptOptions: { sections } }, ctx), undefined);
	assert.deepEqual(sections, { project_memory: "another owner", communication: "unchanged" });
	assert.deepEqual(requests, []);
	assert.deepEqual(warnings, []);
});

test("caller-composed legacy guidance is compared against the original prompt and cleaned before publication", async () => {
	const { loadMemory, ctx, requests } = fixture();
	const session = createProjectMemorySession({ enabled: false, loadMemory });
	const original = "base" + block("old memory");
	const suffix = "\n\n<communication>\nkeep\n</communication>";
	assert.deepEqual(await session.beforeAgentStart({ systemPrompt: original }, ctx, original + suffix), { systemPrompt: "base" + suffix });
	assert.deepEqual(requests, []);
});

test("cancellation suppresses caller-composed legacy guidance as well as memory", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const original = "base" + block("old memory");
	const run = session.beforeAgentStart({ systemPrompt: original }, ctx, original + "\n\nother guidance");
	session.dispose();
	requests[0].resolve(memory("stale completion"));
	assert.equal(await run, undefined);
	assert.deepEqual(warnings, []);
});

test("structured memory replaces its own section and preserves unrelated sections and prompt text", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const sections = { grok_project_memory: "old", project_memory: "another owner", custom: "keep" };
	const event = { systemPrompt: "base", systemPromptOptions: { sections } };
	const run = session.beforeAgentStart(event, ctx);
	assert.deepEqual(sections, { project_memory: "another owner", custom: "keep" });
	assert.equal(requests[0].storageRoot, "/storage");
	requests[0].resolve(memory("fresh"));
	assert.equal(await run, undefined);
	assert.deepEqual(sections, { grok_project_memory: "fresh", project_memory: "another owner", custom: "keep" });
	assert.equal(event.systemPrompt, "base");
	assert.deepEqual(warnings, []);
});

test("a new run aborts the preceding request, uses its own cwd, and ignores a stale completion", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const sections: Record<string, string> = { custom: "keep" };
	const event = { systemPrompt: "base", systemPromptOptions: { sections } };
	const first = session.beforeAgentStart(event, ctx);
	const second = session.beforeAgentStart(event, { ...ctx, cwd: "/second" });
	assert.equal(requests[0].signal.aborted, true);
	assert.equal(requests[0].aborts, 1);
	assert.equal(requests[1].signal.aborted, false);
	assert.deepEqual(requests.map(({ cwd }) => cwd), ["/first", "/second"]);
	requests[1].resolve(memory("new cwd"));
	await second;
	requests[0].resolve(memory("stale cwd"));
	assert.equal(await first, undefined);
	assert.deepEqual(sections, { custom: "keep", grok_project_memory: "new cwd" });
	assert.deepEqual(warnings, []);
});

test("stale errors neither warn nor consume the current session's warning", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const event = { systemPrompt: "base" };
	const first = session.beforeAgentStart(event, ctx);
	const second = session.beforeAgentStart(event, ctx);
	requests[0].reject(new Error("stale failure"));
	assert.equal(await first, undefined);
	assert.deepEqual(warnings, []);
	requests[1].reject(new Error("current failure"));
	assert.equal(await second, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].message, /current failure/);
	assert.equal(warnings[0].kind, "warning");
});

test("completed requests are no longer pending and are not aborted by subsequent lifecycle calls", async () => {
	const { loadMemory, ctx, requests } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const run = session.beforeAgentStart({ systemPrompt: "base" }, ctx);
	requests[0].resolve(memory("ready"));
	assert.deepEqual(await run, { systemPrompt: "base" + block("ready") });
	session.startSession();
	session.dispose();
	assert.equal(requests[0].signal.aborted, false);
});

for (const lifecycle of ["dispose", "startSession"] as const) {
	test(`${lifecycle} aborts pending work before a simulated subsequent I/O and suppresses its cancellation error`, async () => {
		const { ctx, warnings } = fixture();
		const gate = deferred<void>();
		let signal: AbortSignal | undefined;
		let subsequentIo = 0;
		const session = createProjectMemorySession({
			enabled: true,
			storageRoot: "/storage",
			async loadMemory(_cwd, _root, options?: { signal?: AbortSignal }) {
				signal = options?.signal;
				assert.ok(signal);
				await gate.promise;
				signal.throwIfAborted();
				subsequentIo++;
				return memory("must not publish");
			},
		});
		const event = { systemPrompt: "base" + block("old") };
		const run = session.beforeAgentStart(event, ctx);
		session[lifecycle]();
		assert.equal(signal?.aborted, true);
		gate.resolve();
		assert.equal(await run, undefined, "canceled runs must not return even a cleaned legacy prompt");
		assert.equal(subsequentIo, 0);
		assert.deepEqual(warnings, []);
	});

	test(`${lifecycle} also suppresses a non-cooperative loader's stale successful result`, async () => {
		const { loadMemory, ctx, requests, warnings } = fixture();
		const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
		const sections: Record<string, string> = { other: "keep" };
		const run = session.beforeAgentStart({ systemPrompt: "base", systemPromptOptions: { sections } }, ctx);
		session[lifecycle]();
		requests[0].resolve(memory("stale"));
		assert.equal(await run, undefined);
		assert.deepEqual(sections, { other: "keep" });
		assert.deepEqual(warnings, []);
	});
}

test("cleanup is idempotent, prevents loads while disposed, and startSession permits reuse", async () => {
	const { loadMemory, ctx, requests } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const run = session.beforeAgentStart({ systemPrompt: "base" }, ctx);
	session.dispose();
	session.dispose();
	assert.equal(requests[0].aborts, 1);
	assert.equal(await session.beforeAgentStart({ systemPrompt: "base" }, ctx), undefined);
	assert.equal(requests.length, 1);
	session.startSession();
	const next = session.beforeAgentStart({ systemPrompt: "base" }, { ...ctx, cwd: "/resumed" });
	assert.equal(requests.length, 2);
	assert.equal(requests[1].cwd, "/resumed");
	assert.equal(requests[1].signal.aborted, false);
	requests[1].resolve(memory("resumed"));
	assert.deepEqual(await next, { systemPrompt: "base" + block("resumed") });
	requests[0].resolve(memory("old"));
	assert.equal(await run, undefined);
});

test("legacy loads replace only owned blocks and leave competing wrappers and communication unchanged", async () => {
	const { loadMemory, ctx, requests } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const preserved = "base\n\n<project_memory>\nother owner\n</project_memory>\n\n<communication>\nkeep\n</communication>";
	const run = session.beforeAgentStart({ systemPrompt: preserved + block("old") + block("duplicate") }, ctx);
	requests[0].resolve(memory("fresh"));
	assert.deepEqual(await run, { systemPrompt: preserved + block("fresh") });
});

test("disabled legacy memory removes owned blocks, including at the start, without changing other text", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: false, loadMemory });
	const preserved = "base\n\n<project_memory>\nother owner\n</project_memory>";
	assert.deepEqual(await session.beforeAgentStart({ systemPrompt: preserved + block("old") }, ctx), { systemPrompt: preserved });
	assert.deepEqual(await session.beforeAgentStart({ systemPrompt: block("first").slice(2) + "\n\nbase" }, ctx), { systemPrompt: "\n\nbase" });
	assert.equal(await session.beforeAgentStart({ systemPrompt: preserved }, ctx), undefined);
	assert.deepEqual(requests, []);
	assert.deepEqual(warnings, []);
});

test("enabled failures withdraw stale memory and emit one sanitized bounded warning per session", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: true, storageRoot: "/storage", loadMemory });
	const sections = { grok_project_memory: "old", project_memory: "keep" };
	const run = session.beforeAgentStart({ systemPrompt: "base", systemPromptOptions: { sections } }, ctx);
	requests[0].reject(new Error("\u001b[31munsafe\u001b[0m\u0000" + "x".repeat(600)));
	assert.equal(await run, undefined);
	assert.deepEqual(sections, { project_memory: "keep" });
	const prefix = "Project memory unavailable; no memory context loaded: ";
	assert.equal(warnings[0].message, prefix + "Error: unsafe" + "x".repeat(500 - "Error: unsafe".length));
	const retry = session.beforeAgentStart({ systemPrompt: "base" + block("old") }, ctx);
	requests[1].reject(new Error("second failure"));
	assert.deepEqual(await retry, { systemPrompt: "base" });
	assert.equal(warnings.length, 1);
	session.dispose();
	session.startSession();
	const nextSession = session.beforeAgentStart({ systemPrompt: "base" }, ctx);
	requests[2].reject(new Error("new session failure"));
	await nextSession;
	assert.equal(warnings.length, 2);
	assert.match(warnings[1].message, /new session failure/);
});

test("enabled memory without storage warns once per session and never calls the loader", async () => {
	const { loadMemory, ctx, requests, warnings } = fixture();
	const session = createProjectMemorySession({ enabled: true, loadMemory });
	const event = { systemPrompt: "base" + block("old") };
	assert.deepEqual(await session.beforeAgentStart(event, ctx), { systemPrompt: "base" });
	await session.beforeAgentStart(event, ctx);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].message, /No project-memory storage root was configured/);
	session.startSession();
	await session.beforeAgentStart(event, ctx);
	assert.equal(warnings.length, 2);
	assert.deepEqual(requests, []);
});

test("warning UI is optional and missing storage still removes stale memory", async () => {
	const session = createProjectMemorySession({ enabled: true });
	assert.deepEqual(await session.beforeAgentStart({ systemPrompt: "base" + block("old") }, { cwd: "/project", ui: {} }), { systemPrompt: "base" });
});
