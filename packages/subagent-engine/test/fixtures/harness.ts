// End-to-end harness: a real parent AgentSession with the engine loaded, and scripted fake models for parent and children.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getModel, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createSubagentEngine } from "../../src/extension.ts";
import type { Engine } from "../../src/engine.ts";

export type Step =
	| { text: string }
	| { tools: { name: string; args: Record<string, unknown>; id?: string }[]; text?: string }
	| { error: string }
	| { wait: Promise<void>; then: Step };

export type Script = (request: { index: number; messages: unknown[]; system?: string }) => Step | Promise<Step>;

export interface Harness {
	root: string;
	parent: AgentSession;
	engine: Engine;
	children: Map<string, AgentSession>;
	requests: { parent: number; children: Map<string, number> };
	close(): Promise<void>;
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function scripted(script: Script, counter: (count: number) => void) {
	let index = 0;
	return (model: { api: string; provider: string; id: string }, context: { messages: unknown[]; systemPrompt?: string }, options?: { signal?: AbortSignal }) => {
		const stream = createAssistantMessageEventStream();
		const current = index++;
		counter(index);
		const signal = options?.signal;
		const aborted = new Promise<"aborted">((resolve) => {
			if (signal?.aborted) resolve("aborted");
			signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
		});
		void (async () => {
			let step: Step | "aborted" = await script({ index: current, messages: context.messages, system: context.systemPrompt });
			while (step !== "aborted" && "wait" in step) {
				const next: Step = step.then;
				step = await Promise.race([step.wait.then(() => next), aborted]);
			}
			const base = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { ...ZERO, input: 10, output: 1, totalTokens: 11 } };
			let message: AssistantMessage;
			if (step === "aborted" || signal?.aborted) message = { ...base, role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" } as AssistantMessage;
			else if ("error" in step) message = { ...base, role: "assistant", content: [], stopReason: "error", errorMessage: step.error } as AssistantMessage;
			else if ("tools" in step) message = { ...base, role: "assistant", stopReason: "toolUse",
				content: [...(step.text === undefined ? [] : [{ type: "text", text: step.text }]), ...step.tools.map((tool, i) => ({ type: "toolCall", id: tool.id ?? `call-${current}-${i}`, name: tool.name, arguments: tool.args }))] } as AssistantMessage;
			else message = { ...base, role: "assistant", stopReason: "stop", content: [{ type: "text", text: step.text }] } as AssistantMessage;
			if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message } as never);
			else stream.push({ type: "done", reason: message.stopReason as "stop", message } as never);
			stream.end();
		})();
		return stream;
	};
}

export async function createHarness(input: { parent: Script; child: (agentId: string, session: AgentSession) => Script; env?: Record<string, string>; agentFiles?: Record<string, string>; now?: () => number; panes?: boolean; paneDefault?: boolean }): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "subagent-engine-"));
	const agentDir = join(root, "agent");
	if (input.agentFiles) {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		for (const [name, text] of Object.entries(input.agentFiles)) writeFileSync(join(agentDir, "agents", name), text);
	}
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "local-test-only");
	const children = new Map<string, AgentSession>();
	const requests = { parent: 0, children: new Map<string, number>() };
	let engine!: Engine;
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createSubagentEngine({
			env: input.env ?? {}, agentDir, homeDir: root, now: input.now, panes: input.panes, paneDefault: input.paneDefault, modelRuntime: async () => runtime,
			onEngine: (created) => { engine = created; },
			onSessionCreated: (session, agentId) => {
				children.set(agentId, session);
				session.agent.streamFunction = scripted(input.child(agentId, session), (count) => requests.children.set(agentId, count)) as never;
			},
		})],
	});
	await loader.reload();
	const { session: parent } = await createAgentSession({
		cwd: root, agentDir, modelRuntime: runtime, model: getModel("anthropic", "claude-sonnet-4-5"), settingsManager: settings,
		sessionManager: SessionManager.inMemory(root), resourceLoader: loader,
	});
	parent.agent.streamFunction = scripted(input.parent, (count) => { requests.parent = count; }) as never;
	await parent.bindExtensions({ mode: "json" });
	return {
		root, parent, engine, children, requests,
		async close() {
			await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			parent.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export function toolResultText(session: AgentSession, toolName: string): string[] {
	return session.messages
		.filter((message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === toolName)
		.map((message) => JSON.stringify((message as { content: unknown }).content));
}
