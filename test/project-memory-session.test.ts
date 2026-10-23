import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	createAgentSession, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
	createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition,
	createWriteToolDefinition, CustomEditor, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools, getModel } from "@earendil-works/pi-ai/compat";
import { createGrokStyleExtension } from "../src/extension.ts";
import { defaultFeatures } from "../src/extension/features.ts";
import { loadProjectMemory } from "../src/extension/project-memory.ts";
import { scripted, type Script } from "../packages/subagent-engine/test/fixtures/harness.ts";

const BUILTINS = ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"];
const TOPIC_BODY = "Durable-topic-body-7c82: release handoffs use an explicit owner.";
const UPDATED_TOPIC_BODY = "Durable-topic-body-9d14: release handoffs use an explicitly confirmed owner.\n";

type Request = { systemPrompt?: string; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };

function systemText(request: Request): string {
	return [request.systemPrompt ?? "", getCurrentSystemPrompt(request.messages)].join("\n");
}

function toolNames(request: Request): string[] {
	return (request.tools ?? getCurrentTools(request.messages)).map((tool) => tool.name).sort();
}

async function fixture(t: TestContext) {
	let networkRequests = 0;
	t.mock.method(globalThis, "fetch", async () => { networkRequests++; throw new Error("Network access forbidden in project-memory session tests"); });
	const root = mkdtempSync(join(tmpdir(), "grok-memory-session-"));
	const project = join(root, "project");
	const cwd = join(project, "src", "nested");
	const storageRoot = join(root, "private-memory");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(project, ".git"));
	const sessions: AgentSession[] = [];
	t.after(async () => {
		try {
			for (const session of sessions) {
				try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
				finally { session.dispose(); }
			}
			assert.equal(networkRequests, 0, "all provider responses must come from the offline script");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	return {
		project, cwd, storageRoot,
		async session(memory: boolean, script: Script) {
			// Every session gets fresh auth, model storage, settings, resource discovery, and history.
			// No user/project resources or credentials are discovered from the real machine.
			const agentDir = join(root, `agent-${sessions.length}`);
			mkdirSync(agentDir);
			const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models"), refreshOnCreate: false });
			await runtime.setRuntimeApiKey("anthropic", "offline-project-memory-test");
			const settings = SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false } });
			const features = { ...Object.fromEntries(Object.keys(defaultFeatures).map((key) => [key, false])), memory } as typeof defaultFeatures;
			const loader = new DefaultResourceLoader({
				cwd, agentDir, settingsManager: settings,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => {
					createGrokStyleExtension(pi, {
						CustomEditor, features, projectMemoryRoot: storageRoot,
						tools: {
							read: createReadToolDefinition, bash: createBashToolDefinition, powershell: createPowerShellToolDefinition,
							edit: createEditToolDefinition, write: createWriteToolDefinition, grep: createGrepToolDefinition,
							find: createFindToolDefinition, ls: createLsToolDefinition,
						},
					});
				}],
			});
			await loader.reload();
			const { session, extensionsResult } = await createAgentSession({
				cwd, agentDir, modelRuntime: runtime, model: getModel("anthropic", "claude-sonnet-4-5"),
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			});
			sessions.push(session);
			assert.deepEqual(extensionsResult.errors, []);
			const requests: Request[] = [];
			const transport = scripted(script, () => {});
			session.agent.streamFunction = ((model, context, options) => {
				requests.push(JSON.parse(JSON.stringify(context)) as Request);
				return transport(model, context, options);
			}) as typeof session.agent.streamFunction;
			const errors: unknown[] = [];
			await session.bindExtensions({ mode: "json", onError(error) { errors.push(error); } });
			assert.deepEqual(session.getAllTools().map((tool) => tool.name).sort(), BUILTINS, "memory must not register feature-specific tools");
			return { session, requests, errors, features };
		},
	};
}

test("real offline Pi sessions recall only a fresh index, use ordinary file tools, and leave saved memory inert when disabled", { timeout: 15000 }, async (t) => {
	const h = await fixture(t);
	const memory = await loadProjectMemory(h.cwd, h.storageRoot);
	assert.equal(memory.projectRoot, realpathSync(h.project), "nested ctx.cwd resolves to the canonical project root");
	const topicPath = join(memory.directory, "handoffs.md");
	writeFileSync(topicPath, TOPIC_BODY);
	writeFileSync(memory.indexPath, "- Recall-index-original-v1: [Handoffs](handoffs.md)\n");
	const enabled = await h.session(true, ({ index }) => {
		if (index === 0) return { tools: [{ name: "read", args: { path: topicPath } }] };
		if (index === 1) return { tools: [{ name: "write", args: { path: topicPath, content: UPDATED_TOPIC_BODY } }] };
		if (index === 2) return { tools: [{ name: "edit", args: { path: memory.indexPath, oldText: "Recall-index-fresh-v2", newText: "Recall-index-updated-v3" } }] };
		return { text: "Done." };
	});
	assert.equal(enabled.requests.length, 0, "loading memory must not start a model call");
	// Change the index after session startup: the next run must read disk, not a startup cache.
	writeFileSync(memory.indexPath, "- Recall-index-fresh-v2: [Handoffs](handoffs.md)\n");
	await enabled.session.prompt("Consult the relevant saved reference, then record the confirmed correction.");
	assert.equal(enabled.requests.length, 4, "one scripted tool loop executes read, write, and edit without extra model work");
	const firstSystem = systemText(enabled.requests[0]);
	assert.match(firstSystem, /Recall-index-fresh-v2/);
	assert.doesNotMatch(firstSystem, /Recall-index-original-v1/);
	assert.ok(firstSystem.includes(memory.directory));
	assert.ok(firstSystem.includes(memory.indexPath));
	assert.match(firstSystem, /Read only topic Markdown files relevant to the current request/);
	assert.match(firstSystem, /Save information likely to remain useful/);
	assert.match(firstSystem, /Do not store secrets/);
	assert.match(firstSystem, /Apply relevant saved user preferences and collaboration feedback attributable to the user/);
	assert.match(firstSystem, /fallible historical reference/);
	assert.match(firstSystem, /does not authorize arbitrary command execution/);
	assert.match(firstSystem, /corrections and positive confirmations/);
	assert.ok(firstSystem.includes("**Why:**"));
	assert.ok(firstSystem.includes("**How to apply:**"));
	assert.match(firstSystem, /Convert relative dates to absolute dates/);
	assert.match(firstSystem, /maintain MEMORY\.md as a compact index/);
	assert.ok(!JSON.stringify(enabled.requests[0]).includes(TOPIC_BODY), "topic bodies must not be included before an ordinary read");
	assert.deepEqual(toolNames(enabled.requests[0]), BUILTINS);
	const results = enabled.session.messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(results.map((message) => message.toolName), ["read", "write", "edit"]);
	assert.ok(results.every((message) => !message.isError), "the real built-in file tools must all succeed");
	assert.ok(JSON.stringify(results[0].content).includes(TOPIC_BODY), "ordinary read retrieves the lazily selected topic");
	assert.equal(readFileSync(topicPath, "utf8"), UPDATED_TOPIC_BODY);
	assert.match(readFileSync(memory.indexPath, "utf8"), /Recall-index-updated-v3/);
	await enabled.session.prompt("Answer briefly using the latest index.");
	assert.equal(enabled.requests.length, 5);
	assert.match(systemText(enabled.requests[4]), /Recall-index-updated-v3/);
	assert.deepEqual(enabled.errors, []);

	// Pi retains historical system messages, but replaying its public prompt deltas
	// must remove the current memory section after a real reload turns the feature off.
	enabled.features.memory = false;
	await enabled.session.reload();
	await enabled.session.prompt("Answer briefly after reloading.");
	assert.equal(enabled.requests.length, 6);
	assert.doesNotMatch(systemText(enabled.requests[5]), /Recall-index|Project memory is enabled|fallible historical reference/);
	assert.deepEqual(toolNames(enabled.requests[5]), BUILTINS);
	assert.deepEqual(enabled.errors, []);

	const savedIndex = readFileSync(memory.indexPath, "utf8");
	const savedTopic = readFileSync(topicPath, "utf8");
	const savedFiles = readdirSync(memory.directory).sort();
	// A fresh disabled session additionally proves that no automatic memory content or
	// policy enters any part of the outgoing context, rather than just its current prompt.
	const disabled = await h.session(false, () => ({ text: "Done." }));
	assert.equal(disabled.requests.length, 0);
	await disabled.session.prompt("Answer briefly.");
	assert.equal(disabled.requests.length, 1);
	const disabledInput = JSON.stringify(disabled.requests[0]);
	for (const forbidden of ["Recall-index", "Project memory is enabled", "fallible historical reference", "Save information likely", memory.directory, TOPIC_BODY, UPDATED_TOPIC_BODY.trim()]) {
		assert.ok(!disabledInput.includes(forbidden), `disabled sessions must not auto-load memory content or policy: ${forbidden}`);
	}
	assert.deepEqual(toolNames(disabled.requests[0]), BUILTINS);
	assert.deepEqual(disabled.errors, []);
	assert.deepEqual(readdirSync(memory.directory).sort(), savedFiles);
	assert.equal(readFileSync(memory.indexPath, "utf8"), savedIndex);
	assert.equal(readFileSync(topicPath, "utf8"), savedTopic);
});
