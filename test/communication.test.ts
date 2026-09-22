import assert from "node:assert/strict";
import test from "node:test";
import { COMMUNICATION, installCommunication } from "../src/communication.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools.ts";

test("communication rules lead with the answer and describe file references", () => {
	assert.match(COMMUNICATION, /Lead with the answer/);
	assert.match(COMMUNICATION, /final message must stand alone/);
	assert.match(COMMUNICATION, /read naturally, like an update from a concise teammate/);
	assert.match(COMMUNICATION, /src\/app\.ts:42/);
	assert.doesNotMatch(COMMUNICATION, /apply_patch/);
	const sections: Record<string, string> = {};
	installCommunication(sections, false);
	assert.equal(sections.communication, undefined);
	installCommunication(sections, true);
	assert.equal(sections.communication, COMMUNICATION);
});

test("the extension installs the communication section and clickable file references", () => {
	const handlers = new Map<string, Function>();
	let transformer: Function | undefined;
	createGrokStyleExtension({
		on(name, handler) { handlers.set(name, handler); },
		registerTool() {},
		registerMarkdownTransformer(fn) { transformer = fn; },
	}, {
		CustomEditor: class {} as any,
		tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map((name) => [name, () => ({ name, parameters: {}, execute() {} })])) as any,
		hyperlinks: () => true,
	});
	const sections: Record<string, string> = {};
	handlers.get("before_agent_start")!({ systemPromptOptions: { sections } }, {});
	assert.match(sections.communication, /Do not invent metaphors/);
	const linked = transformer!("See `src/app.ts:9`.", { messageType: "assistant", isStreaming: false, availableWidth: 80 });
	assert.match(linked, process.platform === "linux" ? /grok-pi-file:\/\/open\// : /cursor:\/\/file\//);
	assert.equal(transformer!("`src/app.ts:9`", { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 }), "`src/app.ts:9`");
});
