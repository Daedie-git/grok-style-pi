import { performance } from "node:perf_hooks";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapWithDiamondRenderer, type OriginalTool } from "../src/tools/renderer.ts";
import { buildDiffRows, defaultDiffPalette } from "../src/rendering/diff-render.ts";
import { defaultStyleColors } from "../src/chrome/style-colors.ts";
import { VisualPreparation, type VisualRequest, type VisualResult } from "../src/rendering/visual-preparation.ts";
import { HerdrRunner } from "../src/herdr/runner.ts";
import type { HerdrClient } from "../src/herdr/client.ts";

function measure(name: string, body: () => void, count = 50) {
	body();
	const samples: number[] = [];
	for (let index = 0; index < count; index++) { const start = performance.now(); body(); samples.push(performance.now() - start); }
	samples.sort((a, b) => a - b);
	console.log(`${name}: median ${samples[Math.floor(count / 2)].toFixed(3)} ms; p95 ${samples[Math.floor(count * 0.95)].toFixed(3)} ms`);
}

const preparation = new VisualPreparation();
const owner = {};
async function prepare(request: VisualRequest): Promise<VisualResult> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Visual worker did not finish")), 20_000);
		const finish = () => {
			clearTimeout(timer);
			resolve(preparation.request(request, owner, () => {}) ?? {});
		};
		if (preparation.request(request, owner, finish)) finish();
	});
}

try {
	console.log(`Node ${process.version}; timings are local microbenchmarks, no model requests.`);
	const line = (index: number) => `const item${index} = calculate(beforeValue, options.enabled, options.timeout);`;
	const diff = Array.from({ length: 500 }, (_, i) => "+" + line(i)).join("\n");
	const theme = { fg: (_token: string, text: string) => text };
	const job: VisualRequest = {
		kind: "diff", text: diff, lang: "typescript", filePath: "benchmark.ts", colors: defaultStyleColors,
		palette: defaultDiffPalette, paint: { toolDiffAdded: "\0", toolDiffRemoved: "\0", toolDiffContext: "\0" }, fallbacks: [],
	};
	const delay = monitorEventLoopDelay({ resolution: 5 });
	delay.enable();
	const start = performance.now();
	const prepared = await prepare(job);
	console.log(`Cold diff preparation: ${(performance.now() - start).toFixed(1)} ms elapsed; event-loop delay p95 ${(delay.percentile(95) / 1e6).toFixed(2)} ms`);
	delay.disable();
	if (!prepared.rows) throw new Error("No prepared diff");
	const layout: VisualRequest = { kind: "layout", text: "", rows: prepared.rows, width: 120, palette: defaultDiffPalette, colors: defaultStyleColors };
	await prepare(layout);
	await prepare({ ...layout, width: 80 });
	const original = { name: "edit", description: "benchmark", parameters: {}, execute: async () => ({ content: [] }) } as OriginalTool;
	const tool = wrapWithDiamondRenderer(original, { preparation });
	const components = Array.from({ length: 5 }, () => tool.renderResult({ content: [], details: { diff } }, { expanded: true }, theme, {
		args: { path: "benchmark.ts" }, state: {}, invalidate() {},
	}));
	measure("Five unchanged 500-line panels", () => { for (const component of components) component.render(120); });
	measure("Five panels alternating prepared widths", () => { for (const component of components) { component.render(80); component.render(120); } });
	for (const size of [50, 100, 101]) {
		const replacement = [...Array.from({ length: size }, (_, i) => "-" + line(i)), ...Array.from({ length: size }, (_, i) => "+" + line(i).replace("beforeValue", "afterValue"))].join("\n");
		measure(`${size}-line replacement analysis`, () => { buildDiffRows(replacement, { paint: (_token, text) => text }, () => undefined); }, 10);
	}
} finally { preparation.reset(); }

const root = mkdtempSync(join(tmpdir(), "grok-performance-"));
let listings = 0;
let individual = 0;
const client = {
	listAgents: async () => { listings++; return Array.from({ length: 3 }, (_, i) => ({ name: `agent-${i}`, paneId: `pane-${i}` })); },
	isAlive: async () => { individual++; return true; },
} as unknown as HerdrClient;
const runners = Array.from({ length: 3 }, () => new HerdrRunner({ root, client }));
try {
	const store = runners[0].store;
	for (let i = 0; i < 3; i++) {
		const task = { id: `agent-${i}`, herdrName: `agent-${i}`, paneId: `pane-${i}`, type: "test", description: "benchmark", prompt: "fixture", depth: 1, createdAt: new Date().toISOString() };
		const ref = (await store.reserveAgent(task, join(root, `session-${i}.jsonl`), "benchmark", Date.now()))!;
		await store.publish(ref, "fixture", false, Date.now());
		const binding = (await store.attach(task.paneId, join(root, `session-${i}.jsonl`), `session-${i}`))!;
		const command = (await store.claimNextCommand(task.id, binding.token, false))!;
		await store.commandDelivered(command, binding.token);
		await store.recordExecutionEvent(ref, binding.token, { type: "live" }, Date.now());
	}
	for (let tick = 0; tick < 5; tick++) await Promise.all(runners.map((runner) => runner.maintain()));
	console.log(`Three runners / three active agents / five immediate ticks: ${listings} fleet listings, ${individual} individual liveness calls`);
} finally { await Promise.all(runners.map((runner) => runner.close())); rmSync(root, { recursive: true, force: true }); }
