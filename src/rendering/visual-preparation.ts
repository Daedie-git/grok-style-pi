import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { DiffPalette, RenderRow } from "./diff-render.ts";
import type { StyleColors } from "../chrome/style-colors.ts";

export type VisualRequest = {
	kind: "highlight" | "diff" | "layout";
	rows?: RenderRow[];
	fallbacks?: Array<[string, string[]]>;
	width?: number;
	background?: string;
	text: string;
	lang?: string;
	filePath?: string;
	colors: StyleColors;
	palette?: DiffPalette;
	paint?: Record<"toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", string>;
};
export type VisualResult = { lines?: string[]; rows?: RenderRow[]; retry?: boolean };
export type VisualExecutor = { run(request: VisualRequest): Promise<VisualResult>; dispose(): void };
type Job = { request: VisualRequest; bytes: number; listeners: Map<object, () => void> };
type Cached = { value: VisualResult; bytes: number; expires: number };

/** A single lazy worker per extension. Pi objects and callbacks never cross the thread boundary. */
function workerExecutor(): VisualExecutor {
	let worker: Worker | undefined;
	let rejectPending: ((error: Error) => void) | undefined;
	return {
		run(request) {
			return new Promise((resolve, reject) => {
				if (!worker) {
					worker = new Worker(new URL("./visual-worker-entry.mjs", import.meta.url), { execArgv: [] });
					worker.on("error", () => {}); // Pending jobs install their own failure handler.
					const created = worker;
					created.once("exit", () => { if (worker === created) worker = undefined; });
				}
				const current = worker;
				const cleanup = () => {
					clearTimeout(timer);
					current.removeListener("message", reply);
					current.removeListener("error", fail);
					current.removeListener("exit", exited);
					rejectPending = undefined;
				};
				const fail = (error: Error) => { cleanup(); worker = undefined; void current.terminate(); reject(error); };
				const exited = () => fail(new Error("Visual worker exited"));
				const reply = (message: { result?: VisualResult; error?: string }) => {
					cleanup(); current.unref();
					if (message.error) reject(new Error(message.error));
					else resolve(message.result ?? {});
				};
				const timer = setTimeout(() => fail(new Error("Visual preparation timed out")), 25_000);
				timer.unref();
				rejectPending = fail;
				current.once("message", reply);
				current.once("error", fail);
				current.once("exit", exited);
				current.postMessage(request);
				current.unref();
			});
		},
		dispose() {
			rejectPending?.(new Error("Visual preparation disposed"));
			if (worker) { void worker.terminate(); worker = undefined; }
		},
	};
}

/** Deduplicated, bounded work queue and byte-limited LRU. Cache misses never block a render. */
export class VisualPreparation {
	private cache = new Map<string, Cached>();
	private pending = new Map<string, Job>();
	private active?: string;
	private bytes = 0;
	private queuedBytes = 0;
	private generation = 0;
	private retryAt = 0;
	private executor: VisualExecutor;
	private limit: number;
	constructor(executor?: VisualExecutor, limit = 16 * 1024 * 1024) { this.executor = executor ?? workerExecutor(); this.limit = limit; }

	request(request: VisualRequest, owner: object, notify: () => void): VisualResult | undefined {
		if ((!request.text && request.kind !== "layout") || request.text.length + (request.rows?.reduce((sum, row) => sum + row.text.length, 0) ?? 0) > 512_000) return;
		const serialized = JSON.stringify([request.kind, request.text, request.lang, request.filePath, request.colors, request.palette, request.paint, request.rows, request.width, request.background, request.fallbacks ?? []]);
		const key = createHash("sha256").update(serialized).digest("hex");
		const cached = this.cache.get(key);
		if (cached && cached.expires > Date.now()) {
			this.cache.delete(key); this.cache.set(key, cached);
			return cached.value;
		}
		if (cached) { this.bytes -= cached.bytes; this.cache.delete(key); }
		const existing = this.pending.get(key);
		if (existing) { existing.listeners.set(owner, notify); return; }
		if (Date.now() < this.retryAt) return;
		const bytes = serialized.length * 2;
		// Old queued transcript work yields to newer output. Never interrupt the active job.
		while (this.pending.size >= 32 || this.queuedBytes + bytes > 4 * 1024 * 1024) {
			const oldest = [...this.pending.keys()].find((candidate) => candidate !== this.active);
			if (!oldest) return;
			this.queuedBytes -= this.pending.get(oldest)!.bytes;
			this.pending.delete(oldest);
		}
		this.pending.set(key, { request, bytes, listeners: new Map([[owner, notify]]) });
		this.queuedBytes += bytes;
		this.pump();
	}

	private pump() {
		if (this.active || !this.pending.size) return;
		const [key, job] = [...this.pending].at(-1)!;
		this.active = key;
		const generation = this.generation;
		void Promise.resolve().then(() => this.executor.run(job.request)).then((value) => {
			if (generation !== this.generation) return;
			let bytes = JSON.stringify(value).length * 2;
			if (bytes > this.limit) { value = {}; bytes = 4; }
			if (bytes <= this.limit) {
				while (this.cache.size && (this.bytes + bytes > this.limit || this.cache.size >= 256)) {
					const oldest = this.cache.keys().next().value!;
					this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
				}
				this.cache.set(key, { value, bytes, expires: !value.retry && (value.lines || value.rows) ? Infinity : Date.now() + 30_000 });
				this.bytes += bytes;
			}
			this.pending.delete(key); this.queuedBytes -= job.bytes;
			for (const notify of job.listeners.values()) {
				if (generation !== this.generation) break;
				try { notify(); } catch { /* A replaced UI must not stop the queue. */ }
			}
		}, () => {
			if (generation !== this.generation) return;
			this.retryAt = Date.now() + 30_000;
			this.pending.clear(); this.queuedBytes = 0;
		}).finally(() => {
			if (generation !== this.generation) return;
			this.active = undefined;
			this.pump();
		});
	}

	reset() {
		this.generation++;
		this.executor.dispose();
		this.pending.clear(); this.cache.clear();
		this.active = undefined; this.bytes = 0; this.queuedBytes = 0; this.retryAt = 0;
	}
}
