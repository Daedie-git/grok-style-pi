import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActivityPanel, ActivityViewer, isActive, plainText, type Activity } from "./activity-ui.ts";
import { extractResultText, type ToolResult } from "./diamond.ts";
import type { OriginalTool } from "./tools.ts";

import { SubagentAdapter, agentRecord } from "./subagent-adapter.ts";

/** Preserve distinct diagnostics without repeating output embedded in shell errors. */
export function mergeActivityOutput(output: string, diagnostic: string): string {
	if (!diagnostic || output.includes(diagnostic)) return output.slice(-64000);
	if (!output || diagnostic.includes(output)) return diagnostic.slice(-64000);
	return `${output}\n${diagnostic}`.slice(-64000);
}

export function installActivityPanel(pi: ExtensionAPI, getAgentRecord = agentRecord) {
	const entries = new Map<string, Activity>();
	const hidden = new Set<string>();
	let adapter: SubagentAdapter | undefined;
	let ctx: ExtensionContext | undefined;
	let redraw: (() => void) | undefined;
	let viewerRedraw: (() => void) | undefined;
	let closeViewer: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;
	const list = () => [...entries.values()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt);
	const report = (error: unknown) => ctx?.ui.notify(plainText(error instanceof Error ? error.message : String(error)), "error");
	const safely = (action: () => void | Promise<void>) => { void Promise.resolve().then(action).catch(report); };
	function remove(id: string) {
		hidden.delete(id);
		adapter?.forget(id);
		entries.delete(id);
	}
	function changed() {
		const finished = list().filter((entry) => !isActive(entry));
		for (const entry of finished.slice(12)) remove(entry.id);
		redraw?.();
		viewerRedraw?.();
		const needsPolling = list().some((entry) => isActive(entry) || entry.kind === "agent");
		if (!timer && needsPolling) {
			timer = setInterval(() => {
				const wasActive = list().some(isActive);
				const updated = adapter?.poll();
				// Check retained records for resumes without repainting an idle UI.
				if (updated || wasActive || list().some(isActive)) changed();
			}, 500);
			timer.unref?.();
		} else if (timer && !needsPolling) {
			clearInterval(timer);
			timer = undefined;
		}
	}
	async function act(entry: Activity) {
		if (!isActive(entry)) { remove(entry.id); changed(); return; }
		if (entry.status === "stopping") return;
		if (!entry.stop) throw new Error("This activity cannot be stopped individually.");
		if (entry.kind === "agent") { await entry.stop(); return; }
		const previous = entry.status;
		entry.status = "stopping";
		changed();
		try { await entry.stop(); }
		catch (error) { if (entry.status === "stopping") entry.status = previous; changed(); throw error; }
	}
	function dismiss(entry: Activity) {
		if (isActive(entry)) hidden.add(entry.id);
		else remove(entry.id);
		changed();
	}
	async function view(entry: Activity) {
		if (!ctx || closeViewer) return;
		const version = generation;
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				closeViewer = () => done();
				viewerRedraw = () => tui.requestRender();
				return new ActivityViewer(entry, theme, () => tui.terminal.rows, viewerRedraw, closeViewer, () => safely(() => act(entry)));
			}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
		} finally {
			if (version === generation) { closeViewer = undefined; viewerRedraw = undefined; }
		}
	}
	async function choose() {
		if (!ctx) return;
		const current = list();
		if (!current.length) { ctx.ui.notify("No command or subagent activity yet.", "info"); return; }
		const version = generation;
		const labels = current.map((entry, i) => `${i + 1}. ${plainText(entry.title).replace(/\s+/g, " ")} · ${plainText(entry.status).replace(/\s+/g, " ")}`);
		const selected = await ctx.ui.select("Activity", labels);
		if (version !== generation) return;
		const index = selected === undefined ? -1 : labels.indexOf(selected);
		if (index >= 0) await view(current[index]);
	}
	function cleanup() {
		generation++;
		closeViewer?.(); closeViewer = undefined; viewerRedraw = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		adapter?.dispose(); adapter = undefined;
		entries.clear(); hidden.clear();
		ctx?.ui.setWidget("grok-activity", undefined);
		ctx = undefined; redraw = undefined;
	}
	pi.on("session_start", (_event, context) => {
		cleanup();
		if (context.mode !== "tui" || typeof context.ui.setWidget !== "function") return;
		ctx = context;
		ctx.ui.setWidget("grok-activity", (tui, theme) => {
			redraw = () => tui.requestRender();
			const visibleEntries = () => list().filter((entry) => !hidden.has(entry.id));
			return new ActivityPanel(visibleEntries, theme,
				(entry) => safely(() => view(entry)), (entry) => safely(() => act(entry)), () => safely(choose), dismiss);
		}, { placement: "aboveEditor" });
		if (pi.events) adapter = new SubagentAdapter(pi.events, getAgentRecord, (entry, newRun) => {
			if (newRun) hidden.delete(entry.id);
			entries.set(entry.id, entry);
			changed();
		});
	});
	pi.on("session_shutdown", cleanup);
	pi.registerCommand?.("activity", { description: "View or stop active commands and subagents", handler: async () => { await choose(); } });

	return {
		list,
		wrapTool<T extends OriginalTool>(tool: T): T {
			if (!["bash", "powershell"].includes(tool.name)) return tool;
			return { ...tool, async execute(id, args, signal, onUpdate, context) {
				if (!ctx) return tool.execute(id, args, signal, onUpdate, context);
				const controller = new AbortController();
				const entry: Activity = {
					id: `command:${id}`, kind: "command", title: String((args as Record<string, unknown> | undefined)?.command ?? tool.name),
					status: "running", startedAt: Date.now(), output: "", stop: () => controller.abort(),
				};
				entries.set(entry.id, entry); changed();
				const version = generation;
				try {
					const result = await tool.execute(id, args, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, (partial) => {
						entry.output = extractResultText(partial).slice(-64000);
						if (version === generation) changed();
						onUpdate?.(partial);
					}, context);
					entry.output = extractResultText(result as ToolResult).slice(-64000);
					entry.status = controller.signal.aborted ? "stopped" : "completed";
					return result;
				} catch (error) {
					entry.status = controller.signal.aborted || signal?.aborted ? "stopped" : "error";
					entry.output = mergeActivityOutput(entry.output, error instanceof Error ? error.message : String(error));
					throw error;
				} finally {
					entry.endedAt = Date.now();
					if (version === generation) changed();
				}
			} };
		},
	};
}
