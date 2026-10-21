import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatStatus, qualifiedAgentId, type HerdrRunner, type SpawnRequest } from "./runner.ts";
import type { CompletionNotice } from "./store.ts";
import type { RunPhase } from "./state.ts";
export type HerdrTerminalPhase = "completed" | "failed" | "stopped";

export type HerdrBackendRequest = Omit<SpawnRequest, "paneId" | "tabId" | "workspaceId" | "sessionFile" | "agentDir"> & { machine?: string; machineCwd?: string };
export interface HerdrBackendNotice { noticeId: string; agentId: string; runId: string; phase: HerdrTerminalPhase; content: string; machine?: string }
export interface HerdrBackendHandle {
	spawn(request: HerdrBackendRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ agentId: string; runId: string; text: string }>;
	read(agentId: string, options: { runId?: string; wait?: boolean; signal?: AbortSignal }): Promise<{ status: string; phase: RunPhase; resultText: string; text: string; runId?: string }>;
	steer(agentId: string, message: string, options?: { runId?: string }): Promise<{ ok: boolean; message: string }>;
	resume(agentId: string, prompt: string, ctx: ExtensionContext): Promise<{ runId: string; text: string }>;
	cancel(agentId: string, options?: { runId?: string }): Promise<{ acknowledged: boolean; message: string }>;
	capabilities(agentId: string): { liveDelivery: boolean; maxTurns: boolean; fork: false; sharedTasks: boolean };
	onNotice(listener: (notice: HerdrBackendNotice) => void): () => void;
	acknowledge(noticeId: string): Promise<void>;
	/** This Pi runs as a Herdr pane child. */
	paneChild?(): boolean;
}

interface BackendHost {
	route(agentId: string): Promise<{ id: string; runner: HerdrRunner }>;
	spawn(request: HerdrBackendRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ runner: HerdrRunner; agentId: string; runId: string }>;
	content(notice: CompletionNotice, machine?: string): string;
	assertActive(): void;
	paneChild(): boolean;
}

/** The store remains the outbox. Reading, waiting and listener delivery never acknowledge it. */
export function createBackendController(host: BackendHost) {
	const listeners = new Set<(notice: HerdrBackendNotice) => void>();
	const queued = new Set<string>();
	const sources = new Map<string, string>();
	const acknowledged = new Set<string>();
	const capabilities = new Map<string, ReturnType<HerdrBackendHandle["capabilities"]>>();
	async function resolve(agentId: string) {
		host.assertActive();
		const routed = await host.route(agentId);
		const record = await routed.runner.resolve(routed.id);
		const id = qualifiedAgentId(record.id, routed.runner.machine);
		const pi = record.runtime !== "claude-code";
		const value = { liveDelivery: pi, maxTurns: pi, fork: false as const, sharedTasks: pi && !routed.runner.machine };
		capabilities.set(id, value);
		capabilities.set(agentId, value);
		return { ...routed, id: record.id, record };
	}
	const handle: HerdrBackendHandle = {
		paneChild: () => host.paneChild(),
		async spawn(request, ctx, signal) {
			host.assertActive();
			const launched = await host.spawn(request, ctx, signal);
			const agentId = qualifiedAgentId(launched.agentId, launched.runner.machine);
			await resolve(agentId);
			const record = await launched.runner.resolve(launched.agentId);
			const snapshot = await launched.runner.read({ agentId: launched.agentId, runId: launched.runId });
			return { agentId, runId: launched.runId, text: formatStatus(record, snapshot, launched.runner.machine) };
		},
		async read(agentId, options) {
			const { id, runner, record } = await resolve(agentId);
			const ref = { agentId: id, runId: options.runId ?? record.currentRunId };
			const snapshot = options.wait ? await runner.wait(ref, options.signal) : await runner.read(ref);
			return { status: snapshot.phase, phase: snapshot.phase, resultText: snapshot.result ?? snapshot.error ?? "", runId: snapshot.runId, text: formatStatus(record, snapshot, runner.machine) };
		},
		async steer(agentId, message, options) {
			const { id, runner, record } = await resolve(agentId);
			if (record.runtime === "claude-code") return { ok: false, message: "Live delivery is unsupported for Claude Code panes; wait for completion and resume instead." };
			try { await runner.steer({ agentId: id, runId: options?.runId ?? record.currentRunId }, message); return { ok: true, message: "Queued for the agent's next tool round." }; }
			catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
		},
		async resume(agentId, prompt, _ctx) {
			const { id, runner } = await resolve(agentId);
			const ref = await runner.resume(id, prompt);
			return { runId: ref.runId, text: formatStatus(await runner.resolve(id), await runner.read(ref), runner.machine) };
		},
		async cancel(agentId, options) {
			const { id, runner, record } = await resolve(agentId);
			const snapshot = await runner.cancel({ agentId: id, runId: options?.runId ?? record.currentRunId });
			// An unaccepted timeout can terminalize as failed while the pane is
			// still live. Only the store's stopped phase proves cancellation.
			return { acknowledged: snapshot.phase === "stopped", message: formatStatus(record, snapshot, runner.machine) };
		},
		capabilities(agentId) {
			// Unknown/restored identities fail closed until read/resume resolves
			// their runtime. Never accidentally grant Claude live delivery.
			return { ...(capabilities.get(agentId) ?? { liveDelivery: false, maxTurns: false, fork: false, sharedTasks: false }) };
		},
		onNotice(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		async acknowledge(noticeId) {
			host.assertActive();
			if (acknowledged.has(noticeId)) return;
			const agentId = sources.get(noticeId);
			if (!agentId) throw new Error(`Unknown Herdr notice: ${noticeId}`);
			// Resolve again: the machine may have reconnected since delivery.
			// Retaining its old runner here would make acknowledgement fail
			// forever even though the durable outbox is reachable again.
			const { runner } = await host.route(agentId);
			await runner.store.acknowledgeNotice(noticeId);
			acknowledged.add(noticeId);
			sources.delete(noticeId);
			queued.delete(noticeId);
		},
	};
	return {
		handle,
		reset() { queued.clear(); sources.clear(); },
		async deliver(source: HerdrRunner, parentPaneId: string) {
			for (const notice of await source.store.notices(parentPaneId)) {
				if (!listeners.size || queued.has(notice.id)) continue;
				const phase = notice.run.phase;
				if (phase !== "completed" && phase !== "failed" && phase !== "stopped") continue;
				host.assertActive();
				sources.set(notice.id, qualifiedAgentId(notice.agentId, source.machine));
				const pi = notice.agent.runtime !== "claude-code";
				capabilities.set(qualifiedAgentId(notice.agentId, source.machine), { liveDelivery: pi, maxTurns: pi, fork: false, sharedTasks: pi && !source.machine });
				const value = { noticeId: notice.id, agentId: qualifiedAgentId(notice.agentId, source.machine), runId: notice.runId, phase,
					content: host.content(notice, source.machine), ...(source.machine ? { machine: source.machine } : {}) };
				// If a listener throws, do not mark it delivered: the durable
				// unacknowledged notice remains eligible on the next poll.
				for (const listener of listeners) listener(value);
				queued.add(notice.id);
			}
		},
	};
}
