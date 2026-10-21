import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdrBackendHandle, HerdrBackendNotice, HerdrBackendRequest } from "../../../herdr-subagents/src/herdr/backend.ts";
import type { AgentMeta, BackendCapabilities, DeliveryResult, Envelope } from "../types.ts";

export interface HerdrProxyNotice {
	noticeId: string;
	agentId: string;
	runId: string;
	phase: "completed" | "failed" | "stopped";
	text: string;
	herdrAgentId: string;
	machine?: string;
}

/** Thin proxy only: Herdr owns identities, execution, cancellation and the outbox. */
export class HerdrBackendAdapter {
	private readonly proxies = new Map<string, string>();
	private readonly handle: HerdrBackendHandle;

	constructor(handle: HerdrBackendHandle) { this.handle = handle; }

	/** Also registers restored proxy metadata for notice routing. */
	proxy(meta: AgentMeta, ref: { agentId: string; runId: string; machine?: string }): AgentMeta {
		const machine = ref.machine ?? (ref.agentId.split("@").slice(1).join("@") || undefined);
		this.proxies.set(ref.agentId, meta.agentId);
		return { ...structuredClone(meta), backend: "herdr", herdr: { agentId: ref.agentId, runId: ref.runId, ...(machine ? { machine } : {}) } };
	}

	async spawn(request: HerdrBackendRequest, ctx: ExtensionContext, meta: AgentMeta, signal?: AbortSignal) {
		const launched = await this.handle.spawn(request, ctx, signal);
		return { ...launched, meta: this.proxy(meta, launched) };
	}

	async resume(meta: AgentMeta, prompt: string, ctx: ExtensionContext) {
		const agentId = this.identity(meta);
		const resumed = await this.handle.resume(agentId, prompt, ctx);
		return { ...resumed, meta: this.proxy(meta, { agentId, runId: resumed.runId, machine: meta.herdr?.machine }) };
	}

	read(meta: AgentMeta, options: { runId?: string; wait?: boolean; signal?: AbortSignal } = {}) {
		return this.handle.read(this.identity(meta), { ...options, runId: options.runId ?? meta.herdr?.runId });
	}

	capabilities(meta: AgentMeta): BackendCapabilities {
		const capabilities = this.handle.capabilities(this.identity(meta));
		return { ...capabilities, continuation: true, blockedState: true, worktree: false };
	}

	async deliver(meta: AgentMeta, envelope: Envelope): Promise<DeliveryResult> {
		const id = this.identity(meta);
		if (!this.handle.capabilities(id).liveDelivery) return { ok: false, reason: "unsupported", message: "This Herdr runtime does not support live delivery; resume it after completion." };
		const result = await this.handle.steer(id, envelope.text, { runId: meta.herdr?.runId });
		return result.ok ? { ok: true, state: "submitted" } : { ok: false, reason: "failed", message: result.message };
	}

	cancel(meta: AgentMeta) { return this.handle.cancel(this.identity(meta), { runId: meta.herdr?.runId }); }

	onNotice(listener: (notice: HerdrProxyNotice) => void): () => void {
		return this.handle.onNotice((notice: HerdrBackendNotice) => listener({
			noticeId: notice.noticeId, agentId: this.proxies.get(notice.agentId) ?? notice.agentId,
			herdrAgentId: notice.agentId, runId: notice.runId, phase: notice.phase, text: notice.content,
			...(notice.machine ? { machine: notice.machine } : {}),
		}));
	}

	/** Call only after committing the original Herdr notice to its destination. */
	acknowledge(noticeId: string): Promise<void> { return this.handle.acknowledge(noticeId); }

	private identity(meta: AgentMeta): string {
		if (meta.backend !== "herdr" || !meta.herdr) throw new Error("Expected Herdr proxy metadata");
		this.proxies.set(meta.herdr.agentId, meta.agentId);
		return meta.herdr.agentId;
	}
}
