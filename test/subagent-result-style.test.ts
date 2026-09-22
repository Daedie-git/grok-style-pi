import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerStyledSubagents } from "../src/subagent-result-style.ts";

test("subagent result styling preserves execution and metadata, collapsing only its display", async () => {
	const result = { content: [{ type: "text" as const, text: "Agent: abc\nType: Explore | Status: completed\nDescription: Find launch procedure\n\n" + "Complete output\n".repeat(80) }] };
	const original = {
		name: "get_subagent_result", label: "Get Agent Result", description: "Retrieve results",
		parameters: {}, promptSnippet: "Result guidance", promptGuidelines: ["Keep the original guidance"],
		execute: async () => result,
	} as ToolDefinition;
	const other = { ...original, name: "steer_subagent" };
	const registered: ToolDefinition[] = [];
	const pi = { registerTool: (tool: ToolDefinition) => registered.push(tool) } as unknown as ExtensionAPI;
	for (const enabled of [true, false]) {
		registered.length = 0;
		await registerStyledSubagents(pi, (api) => { api.registerTool(original); api.registerTool(other); }, enabled);
		const styled = registered[0];
		assert.equal(registered[1], other);
		assert.equal(styled.execute, original.execute);
		assert.equal(styled.parameters, original.parameters);
		assert.equal(styled.promptSnippet, original.promptSnippet);
		assert.equal(styled.promptGuidelines, original.promptGuidelines);
		if (!enabled) { assert.equal(styled, original); continue; }
		const theme = { fg: (_: string, value: string) => value } as any;
		assert.equal(styled.renderShell, "self");
		const call = styled.renderCall!({ agent_id: "abc" }, theme, {} as any).render(80);
		assert.deepEqual(call, ["◆ Read agent result abc"]);
		assert.deepEqual(styled.renderResult!(result, { expanded: false }, theme, {} as any).render(80), []);
		const expanded = styled.renderResult!(result, { expanded: true }, theme, {} as any).render(80).join("\n");
		assert.equal(expanded.match(/Complete output/g)?.length, 80);
		assert.match(expanded, /Status: completed/);
	}
});

test("agent launches collapse to a sanitized purpose summary without changing execution", async () => {
	const original = {
		name: "Agent", label: "Agent", description: "Launch agent", parameters: {},
		execute: async () => ({ content: [{ type: "text" as const, text: "Running in background (ID: abc)" }], details: { status: "running" } }),
		renderCall: () => ({ render: () => ["native call"], invalidate() {} }),
	} as ToolDefinition;
	let registered: ToolDefinition;
	const pi = { registerTool: (tool: ToolDefinition) => { registered = tool; } } as unknown as ExtensionAPI;
	for (const enabled of [true, false]) {
		await registerStyledSubagents(pi, (api) => { api.registerTool(original); }, enabled);
		assert.equal(registered!.execute, original.execute);
		assert.equal(registered!.promptSnippet, undefined);
		assert.equal(registered!.promptGuidelines, undefined);
		assert.match(registered!.description, /explicitly asked/);
		if (!enabled) {
			assert.equal(registered!.renderCall, original.renderCall);
			continue;
		}
		const theme = { fg: (_: string, value: string) => value } as any;
		const args = { subagent_type: "Explore", description: "Inspect semantic\ncontrol loop\x1b]52;c;attack\x07" };
		assert.deepEqual(registered!.renderCall!(args, theme, {} as any).render(100), ["◆ Explore: Inspect semantic control loop"]);
		const result = await registered!.execute("call", args, undefined, undefined, {} as any);
		assert.deepEqual(registered!.renderResult!(result, { expanded: false }, theme, {} as any).render(100), []);
		assert.match(registered!.renderResult!(result, { expanded: true }, theme, {} as any).render(100).join("\n"), /Running in background \(ID: abc\)/);
	}
});
