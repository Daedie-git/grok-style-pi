import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream, getModel, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createGrokStyleExtension } from "../src/extension.ts";
import { WORKFLOW } from "../src/extension/workflow.ts";
import { defaultFeatures } from "../src/extension/features.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function promptHandler(communication: boolean): Function {
	let handler: Function | undefined;
	createGrokStyleExtension({
		on(name, fn) { if (name === "before_agent_start") handler = fn; },
		registerTool() {},
	}, {
		CustomEditor: class {} as any,
		tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map(name => [name, () => ({ name, parameters: {}, execute() {} })])) as any,
		features: { ...Object.fromEntries(Object.keys(defaultFeatures).map(key => [key, false])), communication },
	});
	return handler!;
}

test("workflow loads independently of chrome and communication, preserving other sections", () => {
	for (const communication of [false, true]) {
		const handler = promptHandler(communication);
		const sections: Record<string, string> = { custom: "keep user instructions" };
		const event = { systemPrompt: "original", systemPromptOptions: { sections } };
		assert.equal(handler(event, {}), undefined);
		assert.equal(sections.workflow, WORKFLOW);
		assert.equal(sections.custom, "keep user instructions");
		assert.equal(Boolean(sections.communication), communication);
		handler(event, {});
		assert.equal(sections.workflow, WORKFLOW, "repeated runs do not duplicate guidance");
	}
});

test("existing workflow content survives composition and repeated application", () => {
	for (const communication of [false, true]) {
		for (const existing of ["", "Other extension's workflow.", `${WORKFLOW}\n\nLater extension's workflow.`]) {
			const handler = promptHandler(communication);
			const sections = { workflow: existing, custom: "keep unrelated instructions" };
			const event = { systemPrompt: "original", systemPromptOptions: { sections } };
			const expected = existing.includes(WORKFLOW) ? existing : existing ? `${existing}\n\n${WORKFLOW}` : WORKFLOW;
			handler(event, {});
			assert.equal(sections.workflow, expected);
			handler(event, {});
			assert.equal(sections.workflow, expected);
			sections.workflow += "\n\nNew instructions after first application.";
			const updated = sections.workflow;
			handler(event, {});
			assert.equal(sections.workflow, updated);
			assert.equal(sections.workflow.split(WORKFLOW).length - 1, 1);
			assert.equal(sections.custom, "keep unrelated instructions");
		}
	}
});

test("legacy prompt fallback appends workflow without replacing original instructions", () => {
	for (const communication of [false, true]) {
		for (const systemPromptOptions of [undefined, {}]) {
			const result = promptHandler(communication)({ systemPrompt: "original", systemPromptOptions }, {});
			assert.ok(result.systemPrompt.startsWith("original\n\n<workflow>\n"));
			assert.ok(result.systemPrompt.includes(WORKFLOW));
			assert.equal(result.systemPrompt.includes("<communication>"), communication);
		}
	}
});

test("normal local package discovery loads workflow outside the checkout without changing explicit reasoning", async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in workflow test"); });
	const root = mkdtempSync(join(tmpdir(), "grok-workflow-"));
	try {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
		assert.ok(manifest.files.includes("src"), "published package must include workflow source");
		const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
		await modelRuntime.setRuntimeApiKey("anthropic", "local-test-only");
		const settingsManager = SettingsManager.inMemory({ packages: [ROOT], retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: root, settingsManager,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getExtensions().extensions.length, 1);
		for (const thinkingLevel of ["medium", "high"] as const) {
			const { session } = await createAgentSession({
				cwd: root, agentDir: root, settingsManager, resourceLoader: loader, modelRuntime,
				sessionManager: SessionManager.inMemory(root), thinkingLevel,
				model: getModel("anthropic", "claude-sonnet-4-5"),
			});
			try {
				for (const existing of [undefined, "Workflow supplied before package hooks."]) {
					const sections: Record<string, string> = { custom: "preserved" };
					if (existing !== undefined) sections.workflow = existing;
					const expected = existing ? `${existing}\n\n${WORKFLOW}` : WORKFLOW;
					for (let application = 0; application < 2; application++) {
						await session.extensionRunner.emitBeforeAgentStart("task", undefined, "original", { sections });
						assert.equal(sections.workflow, expected);
						assert.equal(sections.custom, "preserved");
					}
				}
				session.agent.streamFunction = (model) => {
					const stream = createAssistantMessageEventStream();
					const message: AssistantMessage = {
						role: "assistant", content: [{ type: "text", text: "local response" }],
						api: model.api, provider: model.provider, model: model.id,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "stop", timestamp: Date.now(),
					};
					queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
					return stream;
				};
				await session.prompt("Confirm workflow loading locally.");
				assert.ok(session.systemPrompt.includes(`<workflow>\n${WORKFLOW}\n</workflow>`));
				assert.equal(session.thinkingLevel, thinkingLevel);
			} finally {
				session.dispose();
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workflow preserves the requested execution rules and portable permission boundaries", () => {
	for (const rule of [/ONE lead Pi or Claude per branch\/topic/, /explicitly transfer responsibility/, /MEDIUM/, /preserve explicit user choices such as HIGH/, /current remote HEAD/, /submitted, received, acted on, and completed/, /clear them on evidence/, /resource contention/, /smallest useful end-to-end task/, /one performance measurement workload per machine/, /material limits/, /still require their own authorization/]) {
		assert.match(WORKFLOW, rule);
	}
	assert.doesNotMatch(WORKFLOW, /\/home\/|[A-Z]:\\|w\d+:p\d+|Daedie|Bjorn/);
});
