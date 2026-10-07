import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadSubagentExtension } from "../integrations/subagents.ts";

const theme = { fg: (_token: string, text: string) => text } as any;
const content = "Background agent completed: Review SRT fix correctness\nAgent ID: sol-review\nRun ID: run-1\nPane: w4S:p4\n\nThe P1 finding is addressed.\n\nUse get_subagent_result for full output.";

async function host(enabled = true, env = { HERDR_ENV: "1" }) {
	const renderers = new Map<string, MessageRenderer>();
	const sent: unknown[][] = [];
	const message = { customType: "herdr-subagent-notification", content, display: true, details: { noticeId: "notice-1", agentId: "sol-review", runId: "run-1" } };
	const delivery = { deliverAs: "followUp" as const, triggerTurn: true };
	const pi = {
		registerTool() {},
		registerMessageRenderer(type: string, renderer: MessageRenderer) { renderers.set(type, renderer); },
		sendMessage(...args: unknown[]) { sent.push(args); },
	} as unknown as ExtensionAPI;
	const factory = (api: ExtensionAPI) => { api.sendMessage(message, delivery); };
	await loadSubagentExtension(pi, env, { herdr: factory, current: factory }, enabled);
	return { renderers, sent, message, delivery };
}

test("Herdr completion notices register a collapsed diamond without changing delivery", async () => {
	const h = await host();
	const renderer = h.renderers.get("herdr-subagent-notification");
	assert.ok(renderer, "Herdr completion notices need a diamond renderer");
	assert.equal(h.sent[0][0], h.message);
	assert.equal(h.sent[0][1], h.delivery);
	const component = renderer(h.message as any, { expanded: false, outputPad: 1 }, theme)!;
	const lines = component.render(160);
	assert.deepEqual(lines, ["◆ Background agent completed: Review SRT fix correctness"]);
	component.handleMouse!({ type: "click", button: "left", y: 0 } as any);
	const opened = component.render(160).join("\n");
	assert.match(opened, /Agent ID: sol-review/);
	assert.match(opened, /The P1 finding is addressed/);
	assert.match(opened, /Use get_subagent_result/);
	assert.doesNotMatch(lines.join("\n"), /\[herdr-subagent-notification\]/);
});

test("completion diamonds preserve click state through rerenders and follow global expansion changes", async () => {
	const h = await host();
	const renderer = h.renderers.get("herdr-subagent-notification")!;
	const render = (expanded = false) => renderer(h.message as any, { expanded, outputPad: 1 }, theme)!;
	const component = render();
	assert.equal(component.handleMouse!({ type: "click", button: "left", y: 0 } as any)?.handled, true);
	assert.ok(component.render(100).length > 1);
	component.invalidate();
	assert.ok(render().render(100).length > 1, "click state survives renderer recreation");
	assert.ok(render(true).render(100).length > 1);
	assert.equal(render(false).render(100).length, 1);
	const collapsed = render();
	assert.deepEqual(collapsed.handleMouse!({ type: "click", button: "left", y: 1 } as any), { handled: true });
	assert.equal(collapsed.handleMouse!({ type: "click", button: "right", y: 0 } as any), undefined);
	assert.deepEqual(collapsed.handleMouse!({ type: "click", button: "left", ctrl: true, y: 0 } as any), { handled: true });
	collapsed.handleMouse!({ type: "click", button: "left", y: 0 } as any);
	assert.ok(collapsed.render(100).length > 1);
	const other = renderer({ ...h.message, details: { runId: "run-2" } } as any, { expanded: false, outputPad: 1 }, theme)!;
	assert.equal(other.render(100).length, 1, "new notices start collapsed independently");
});

test("completion diamonds sanitize content, fit narrow widths, and use the current theme", async () => {
	const h = await host();
	const renderer = h.renderers.get("herdr-subagent-notification")!;
	const message = { ...h.message, content: [{ type: "text", text: "Background agent failed: 界 review\nUnsafe\x1b]52;c;attack\x07\x1b[2J\toutput\n" + "Details\n".repeat(50) }] };
	const component = renderer(message as any, { expanded: true, outputPad: 1 }, theme)!;
	assert.doesNotMatch(component.render(100).join("\n"), /attack|\x1b|\t/);
	assert.equal(component.render(100).filter(line => line.includes("Details")).length, 50);
	for (const width of [0, 1, 2, 3, 12, 80]) {
		assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
	}
	const colored = renderer(h.message as any, { expanded: false, outputPad: 1 }, { fg: (_token: string, text: string) => `new:${text}` } as any)!;
	assert.match(colored.render(100)[0], /^new:◆/);
});

test("native notifications remain untouched outside styled Herdr integration", async () => {
	for (const [enabled, env] of [[false, { HERDR_ENV: "1" }], [true, {}]] as const) {
		const h = await host(enabled, env);
		assert.equal(h.renderers.size, 0);
		assert.equal(h.sent[0][0], h.message);
		assert.equal(h.sent[0][1], h.delivery);
	}
});
