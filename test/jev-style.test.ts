import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerStyledJev, renderJevMessage } from "../src/jev-style.ts";

const theme = { fg: (_: string, text: string) => text } as any;

test("Jev diamonds sanitize text, collapse, click open, and follow global expansion", () => {
	const message = { customType: "pi-warden-steer", content: "pi-warden: Verify changes\nFull intervention\x1b]52;c;attack\x07\x1b[2J", display: true } as any;
	const render = (expanded = false) => renderJevMessage(message, { expanded, outputPad: 1 }, theme)!;
	const component = render();
	assert.deepEqual(component.render(100), ["◆ Jev · Warden intervention: Verify changes"]);
	assert.ok(component.render(15).every(line => visibleWidth(line) <= 15));
	component.handleMouse!({ type: "click", button: "left", y: 0 } as any);
	assert.match(component.render(100).join("\n"), /Full intervention/);
	assert.doesNotMatch(component.render(100).join("\n"), /attack|\x1b/);
	assert.equal(render().render(100).length, 3, "open state survives renderer invalidation");
	render(true);
	assert.equal(render(false).render(100).length, 1);
});

test("Jev wrapper changes visibility only, preserving messages, hooks, tools and turn delivery", async () => {
	const sent: any[] = [], handlers = new Map<string, any>(), renderers = new Map(), tools: any[] = [];
	const pi = { sendMessage: (...args: any[]) => sent.push(args), on: (event: string, handler: any) => handlers.set(event, handler), registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer), registerTool: (tool: any) => tools.push(tool) } as any;
	const content = [{ type: "text", text: "Actual intervention" }];
	const message = { customType: "pi-warden-steer", content, display: false, details: { test: 1 } };
	const delivery = { deliverAs: "followUp", triggerTurn: true };
	const hookResult = { message: { ...message, customType: "jev-discovery-evidence" }, systemPrompt: "Unchanged" };
	const execute = async () => ({ content });
	const tool = { name: "jev_advisory_assess", parameters: {}, execute, promptGuidelines: ["Original guidance"] };
	const otherHook = () => {};
	await registerStyledJev(pi, api => {
		api.sendMessage(message as any, delivery as any);
		api.sendMessage({ ...message, customType: "other" } as any);
		api.on("before_agent_start", async () => hookResult as any);
		api.on("agent_end", otherHook);
		api.registerTool(tool as any);
	}, true);
	assert.equal(sent.length, 2);
	assert.equal(sent[0][0].display, true);
	assert.equal(sent[0][0].content, content);
	assert.equal(sent[0][0].details, message.details);
	assert.equal(sent[0][1], delivery);
	assert.equal(message.display, false);
	assert.equal(sent[1][0].display, false);
	assert.equal(handlers.get("agent_end"), otherHook);
	const result = await handlers.get("before_agent_start")({}, {});
	assert.equal(result.message.display, true);
	assert.equal(result.message.content, content);
	assert.equal(result.systemPrompt, hookResult.systemPrompt);
	assert.equal(hookResult.message.display, false);
	assert.equal(tools[0].execute, execute);
	assert.equal(tools[0].parameters, tool.parameters);
	assert.equal(tools[0].promptGuidelines, tool.promptGuidelines);
	assert.deepEqual(tools[0].renderCall({}, theme, {}).render(100), ["◆ Jev advisory assessment"]);
	assert.equal(renderers.size, 3);
	await registerStyledJev(pi, api => { assert.equal(api, pi); }, false);
});

test("discovery source evidence expands completely without changing its payload", () => {
	const message = { customType: "jev-discovery-evidence", content: "Source excerpt\n".repeat(5000), display: true } as any;
	assert.deepEqual(renderJevMessage(message, { expanded: false, outputPad: 1 }, theme)!.render(100), ["◆ Jev · Discovery guidance and source evidence"]);
	const lines = renderJevMessage(message, { expanded: true, outputPad: 1 }, theme)!.render(100);
	assert.equal(lines.filter(line => line.includes("Source excerpt")).length, 5000);
});

test("delegated discovery uses a collapsed diamond without changing execution or evidence", async () => {
	let styled: any;
	const pi = { registerMessageRenderer() {}, registerTool(tool: any) { styled = tool; } } as any;
	const result = { content: [{ type: "text", text: JSON.stringify({ status: "evidence_found", limitations: ["Selection may be incomplete."], evidence: "src/example.ts:1-2\n1: source" }) }] };
	const execute = async () => result;
	const parameters = { type: "object" };
	await registerStyledJev(pi, api => api.registerTool({ name: "jev_discover", parameters, execute } as any), true);
	assert.equal(styled.execute, execute);
	assert.equal(styled.parameters, parameters);
	assert.equal(await styled.execute(), result);
	assert.equal(styled.renderShell, "self");
	assert.deepEqual(styled.renderCall({}, theme, {}).render(100), ["◆ Jev discovery"]);
	assert.deepEqual(styled.renderResult(result, { expanded: false, isPartial: false }, theme, {}).render(100), []);
	const expanded = styled.renderResult(result, { expanded: true, isPartial: false }, theme, {}).render(100).join("\n");
	assert.match(expanded, /Source evidence found/);
	assert.match(expanded, /Note: Selection may be incomplete/);
	assert.match(expanded, /src\/example.ts:1-2\n\s*1: source/);
	assert.doesNotMatch(expanded, /"status"|\\n/);
	assert.equal(JSON.parse(result.content[0].text).status, "evidence_found", "rendering preserves the model payload");
});
