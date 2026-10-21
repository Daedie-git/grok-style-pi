import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import { Check } from "typebox/value";
import { TaskStore } from "../src/tasks/store.ts";
import { registerTaskTools, TASK_TOOL_NAMES } from "../src/tasks/tools.ts";
import { scripted } from "./fixtures/harness.ts";

interface RegisteredTool {
	name: string;
	parameters: TObject;
	execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: ExtensionToolContext): Promise<{ content: { type: string; text?: string }[]; details: unknown }>;
}
function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "task-tools-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function registrations(store: TaskStore | (() => TaskStore), selected?: (typeof TASK_TOOL_NAMES)[number][]) {
	const tools = new Map<string, RegisteredTool>();
	const pi = { registerTool: (tool: RegisteredTool) => { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
	registerTaskTools(pi, { store: typeof store === "function" ? store : () => store, caller: {}, tools: selected });
	const call = async (name: string, input: Record<string, unknown>) => {
		const tool = tools.get(name)!;
		assert.ok(Check(tool.parameters, input), `Invalid test input for ${name}`);
		return tool.execute(`call-${name}`, input, undefined, undefined, {} as ExtensionToolContext);
	};
	return { tools, call };
}

test("four registered schemas match SDK task input field names, types and optionality", t => {
	const { tools } = registrations(new TaskStore({ root: fixture(t), listId: "list" }));
	assert.deepEqual([...tools.keys()], [...TASK_TOOL_NAMES]);
	const expected = {
		TaskCreate: { required: ["subject", "description"], fields: ["subject", "description", "activeForm", "metadata"] },
		TaskGet: { required: ["taskId"], fields: ["taskId"] },
		TaskList: { required: [], fields: [] },
		TaskUpdate: { required: ["taskId"], fields: ["taskId", "subject", "description", "activeForm", "status", "addBlocks", "addBlockedBy", "owner", "metadata"] },
	};
	for (const [name, shape] of Object.entries(expected)) {
		const schema = tools.get(name)!.parameters;
		assert.equal(schema.type, "object");
		assert.deepEqual(schema.required ?? [], shape.required);
		assert.deepEqual(Object.keys(schema.properties), shape.fields);
		for (const field of shape.fields) {
			if (["metadata", "status", "addBlocks", "addBlockedBy"].includes(field)) continue;
			assert.equal((schema.properties[field] as { type?: string }).type, "string");
		}
	}
	const create = tools.get("TaskCreate")!.parameters;
	const update = tools.get("TaskUpdate")!.parameters;
	assert.ok(Check(create, { subject: "", description: "", activeForm: "", metadata: { arbitrary: { nested: [null, true, 1, "text"] } } }));
	assert.equal(Check(create, { subject: "missing description" }), false);
	assert.equal(Check(create, { subject: 3, description: "text" }), false);
	assert.equal(Check(create, { subject: "text", description: "text", metadata: [] }), false);
	assert.ok(Check(update, { taskId: "1", metadata: { removed: null } }));
	for (const status of ["pending", "in_progress", "completed", "deleted"]) assert.ok(Check(update, { taskId: "1", status }));
	for (const status of ["running", "failed", null, 3]) assert.equal(Check(update, { taskId: "1", status }), false);
	assert.ok(Check(update, { taskId: "1", addBlocks: ["2"], addBlockedBy: ["3"], owner: "worker" }));
	assert.equal(Check(update, { taskId: "1", addBlocks: [2] }), false);
	assert.equal(Check(update, { taskId: "1", addBlockedBy: "2" }), false);
	assert.equal(Check(tools.get("TaskGet")!.parameters, {}), false);
	assert.ok(Check(tools.get("TaskList")!.parameters, {}));
});

test("the tools option limits registrations, including an explicit empty surface", t => {
	const store = new TaskStore({ root: fixture(t), listId: "list" });
	assert.deepEqual([...registrations(store, []).tools.keys()], []);
	assert.deepEqual([...registrations(store, ["TaskList", "TaskGet"]).tools.keys()], ["TaskGet", "TaskList"]);
	assert.deepEqual([...registrations(store, ["TaskUpdate", "TaskUpdate"]).tools.keys()], ["TaskUpdate"]);
});

test("registered execute handlers forward all fields and return JSON text plus durable details", async t => {
	const store = new TaskStore({ root: fixture(t), listId: "list" });
	const { call } = registrations(store);
	const created = await call("TaskCreate", { subject: "Implement", description: "Build feature", activeForm: "Building", metadata: { keep: true, remove: 1 } });
	assert.deepEqual(JSON.parse(created.content[0].type === "text" ? created.content[0].text! : ""), created.details);
	assert.deepEqual(created.details, { task: await store.get("1") });
	await call("TaskCreate", { subject: "Review", description: "Check it" });
	const updated = await call("TaskUpdate", { taskId: "1", subject: "Updated", description: "More detail", activeForm: "Updating", status: "in_progress", owner: "worker", addBlocks: ["2"], metadata: { remove: null, added: [1, 2] } });
	assert.deepEqual(updated.details, { task: await store.get("1"), updatedFields: ["subject", "description", "activeForm", "owner", "status", "metadata", "addBlocks"] });
	assert.deepEqual((await store.get("1"))!.metadata, { keep: true, added: [1, 2] });
	assert.deepEqual((await store.get("2"))!.blockedBy, ["1"]);
	await call("TaskUpdate", { taskId: "1", status: "completed" });
	assert.deepEqual((await call("TaskGet", { taskId: "1" })).details, { task: await store.get("1") });
	assert.deepEqual((await call("TaskList", {})).details, { tasks: await store.list() });
	assert.deepEqual((await call("TaskGet", { taskId: "999" })).details, { task: null });
	assert.deepEqual((await call("TaskUpdate", { taskId: "2", status: "deleted" })).details, { task: null, updatedFields: ["status"] });
});

test("hook vetoes, missing updates and store exceptions become failed tool executions", async t => {
	const root = fixture(t);
	const deniedCreate = registrations(new TaskStore({ root, listId: "created", hooks: { created: async () => ({ block: "creation blocked" }) } }));
	await assert.rejects(deniedCreate.call("TaskCreate", { subject: "test", description: "details" }), /creation blocked/);
	const store = new TaskStore({ root, listId: "completed", hooks: { completed: async () => ({ block: "completion blocked" }) } });
	const { call } = registrations(store);
	await call("TaskCreate", { subject: "before", description: "details" });
	await assert.rejects(call("TaskUpdate", { taskId: "1", subject: "after", status: "completed" }), /completion blocked/);
	assert.equal((await store.get("1"))!.subject, "before");
	await assert.rejects(call("TaskUpdate", { taskId: "999", status: "completed" }), /Task not found/);
	await assert.rejects(call("TaskGet", { taskId: "../outside" }), /Invalid task id/);
});

test("a store getter binds tool calls to the current session list rather than the registration-time list", async t => {
	const root = fixture(t);
	const old = new TaskStore({ root, listId: "old" });
	let current = old;
	const { call } = registrations(() => current);
	await call("TaskCreate", { subject: "old", description: "details" });
	current = new TaskStore({ root, listId: "new" });
	await call("TaskCreate", { subject: "new", description: "details" });
	assert.equal((await old.get("1"))!.subject, "old");
	assert.equal((await current.get("1"))!.subject, "new");
});

test("real Pi AgentSession dispatches the registered task tools through a model tool loop", { timeout: 20_000 }, async t => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access forbidden"); });
	const root = fixture(t);
	const store = new TaskStore({ root: join(root, "tasks"), listId: "shared" });
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [pi => registerTaskTools(pi, { store: () => store, caller: {} })],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: root, agentDir: join(root, "agent"), modelRuntime: runtime, model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager: settings,
		sessionManager: SessionManager.inMemory(root), resourceLoader: loader,
	});
	t.after(() => session.dispose());
	session.agent.streamFunction = scripted(({ index }) => {
		const calls = [
			{ name: "TaskCreate", args: { subject: "SDK task", description: "Exercise real dispatch", metadata: { source: "test" } } },
			{ name: "TaskUpdate", args: { taskId: "1", owner: "worker", status: "completed" } },
			{ name: "TaskGet", args: { taskId: "1" } },
			{ name: "TaskList", args: {} },
			{ name: "TaskUpdate", args: { taskId: "999", subject: "missing" } },
			{ name: "TaskCreate", args: { subject: "invalid missing description" } },
		];
		return index < calls.length ? { tools: [calls[index]] } : { text: "Task workflow complete" };
	}, () => {}) as never;
	await session.bindExtensions({ mode: "json" });
	await session.prompt("Exercise the task workflow", { source: "extension" });
	const results = session.messages.filter(message => message.role === "toolResult");
	assert.equal(results.length, 6);
	assert.deepEqual(results.map(message => message.isError), [false, false, false, false, true, true], JSON.stringify(results.map(message => message.content)));
	assert.equal((await store.get("1"))!.status, "completed");
	assert.equal((await store.list()).length, 1, "schema-invalid TaskCreate never reaches the store");
	assert.deepEqual(results[2].details, { task: await store.get("1") });
	assert.deepEqual(results[3].details, { tasks: await store.list() });
});
