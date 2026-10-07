import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installGrokStyle } from "../extensions/install.ts";
import { loadSubagentExtension } from "../integrations/subagents.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";
import { registerToolExtension } from "../src/tools/register-extension.ts";
import { defaultFeatures } from "../src/extension/features.ts";

const paint = { fg: (_token: string, value: string) => value };
const allOff = Object.fromEntries(Object.keys(defaultFeatures).map(key => [key, false])) as typeof defaultFeatures;
const fixture = (name: string) => ({ name, description: name, parameters: {}, execute: async () => ({ content: [] }), renderCall: () => ({ render: () => ["native"], invalidate() {} }) }) as ToolDefinition;

function host() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const commands: string[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerCommand(name: string) { commands.push(name); },
		registerMessageRenderer() {},
		on(event: string, handler: Function) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers, commands };
}

test("factory forwarding retains non-tool registrations and original exceptions", async () => {
	const h = host();
	const original = fixture("read");
	let events = 0;
	await registerToolExtension(h.pi, async (pi) => {
		pi.registerCommand("own-command", { description: "own", handler: async () => {} });
		pi.on("session_tree", () => { events++; });
		await Promise.resolve();
		pi.registerTool(original);
	}, (tool) => ({ ...tool, label: "decorated" }));
	assert.deepEqual(h.commands, ["own-command"]);
	h.handlers.get("session_tree")![0]();
	assert.equal(events, 1);
	assert.equal(h.tools.get("read").execute, original.execute);
	assert.equal(h.tools.get("read").label, "decorated");
	const error = new Error("owner failure");
	await assert.rejects(registerToolExtension(h.pi, () => { throw error; }, tool => tool), caught => caught === error);
});

test("the core runtime uses injected adapters and disabled styling returns the original", () => {
	for (const enabled of [true, false]) {
		const h = host();
		const runtime = createGrokStyleExtension(h.pi, {
			features: { ...allOff, toolStyling: enabled }, CustomEditor: class {} as any,
			tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map(name => [name, () => fixture(name)])) as any,
			sections: { fixture: { summary: () => ({ title: "Injected" }), body: () => [{ kind: "text", text: "adapter output" }] } },
		});
		const original = fixture("fixture");
		const styled = runtime.styleTool(original);
		assert.equal(styled.execute, original.execute);
		assert.equal(styled.parameters, original.parameters);
		if (!enabled) assert.equal(styled, original);
		else {
			assert.deepEqual(styled.renderCall!({}, paint as any, {} as any).render(100), ["◆ Injected"]);
			assert.match(styled.renderResult!({ content: [], details: undefined }, { expanded: true }, paint as any, {} as any).render(100).join("\n"), /adapter output/);
		}
		for (const handler of h.handlers.get("session_shutdown") ?? []) handler();
	}
});

test("either runner shares the installed core, with one chrome lifecycle and optional codemode", async () => {
	const agent = await import("@earendil-works/pi-coding-agent");
	for (const enabled of [true, false]) {
		for (const env of [{}, { HERDR_ENV: "1" }]) {
			const h = host();
			let constructed = 0, executed = 0;
			const codemode = fixture("codemode");
			const { runtime, features } = await installGrokStyle(h.pi, {
				features: { ...allOff, toolStyling: enabled },
				loadAgent: async () => ({ ...agent, createCodemodeExtension() {
					constructed++;
					return (pi) => { executed++; pi.registerTool(codemode); };
				} }),
			});
			const runners: string[] = [];
			const factory = (name: string): ExtensionFactory => (pi) => {
				runners.push(name);
				pi.registerTool(fixture("Agent"));
				pi.registerTool(fixture("get_subagent_result"));
				pi.registerTool(fixture("steer_subagent"));
			};
			await loadSubagentExtension(h.pi, env, { current: factory("current"), herdr: factory("herdr") }, features.toolStyling, runtime.styleTool);
			assert.deepEqual(runners, [env.HERDR_ENV ? "herdr" : "current"]);
			assert.equal(h.handlers.get("session_start")!.length, enabled ? 3 : 2); // chrome + steering, plus shared media when styled
			assert.equal(h.commands.filter(name => name === "grok-style").length, 1);
			assert.equal(constructed, enabled ? 1 : 0);
			assert.equal(executed, enabled ? 1 : 0);
			assert.equal(h.tools.has("codemode"), enabled);
			assert.equal(h.tools.get("Agent").renderShell, enabled ? "self" : undefined);
			assert.equal(h.tools.get("steer_subagent").renderShell, enabled ? "self" : undefined);
			assert.match(h.tools.get("Agent").description, /explicitly asked/);
			if (enabled) assert.equal(h.tools.get("codemode").execute, codemode.execute);
			for (const handler of h.handlers.get("session_shutdown") ?? []) handler();
		}
	}
});
