import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { open, lstat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { loadProjectMemory } from "./project-memory.ts";
import { MemoryStore, type MutationQueue } from "./memory-store.ts";
import { createRecallState, recallMemory, runMemoryPass, type MemoryCompletion, type MemoryRecallState } from "./memory-worker.ts";
import { loadFeatures, saveFeatures } from "./features.ts";
import { readSettingsObject, writeSettingsObject, featureSettingsPath } from "../chrome/style-colors.ts";
import { sanitizeToolText } from "../tools/diamond.ts";

export type MemoryOptions = { recall: boolean; extraction: boolean; consolidation: boolean; everyTurns: number; idleMs: number; minHours: number; minSessions: number };
export const defaultMemoryOptions: MemoryOptions = { recall: true, extraction: true, consolidation: true, everyTurns: 5, idleMs: 120_000, minHours: 24, minSessions: 5 };
export type RecentMemorySession = { id: string; modified: number; text: string };
import { readMemoryProgress, writeMemoryProgress } from "./memory-progress.ts";
import { consolidationChunks, memoryChunk, type MemoryCursor } from "./memory-context.ts";
export { memoryConversation } from "./memory-context.ts";

function loadOptions(path: string): MemoryOptions {
	const saved = readSettingsObject(path).automaticMemory;
	const result = { ...defaultMemoryOptions };
	if (!saved || typeof saved !== "object" || Array.isArray(saved)) return result;
	for (const key of ["recall", "extraction", "consolidation"] as const) {
		const value = (saved as Record<string, unknown>)[key];
		if (typeof value === "boolean") result[key] = value;
	}
	return result;
}

/** Full entrypoints supply real Pi adapters; tests exercise the same lifecycle without a provider. */
export function installAutomaticMemory(pi: ExtensionAPI, deps: {
	enabled: boolean; storageRoot: string; queue: MutationQueue; settingsPath?: string;
	options?: Partial<MemoryOptions>; complete?: (ctx: ExtensionContext) => MemoryCompletion;
	/** Trusted host authorization adapter; absent means a separate user-confirmed directory grant is required. */
	authorize?: (ctx: ExtensionContext, directory: string) => Promise<boolean>;
	recentSessions?: (ctx: ExtensionContext, since: number, signal: AbortSignal, processed?: Readonly<Record<string, number>>) => Promise<RecentMemorySession[]>;
}) {
	const settingsPath = deps.settingsPath ?? featureSettingsPath();
	let options = { ...loadOptions(settingsPath), ...deps.options };
	let active = false;
	let generation = 0;
	let job: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let turns = 0;
	let cursor: MemoryCursor = {};
	let pendingProse = false;
	let recall = createRecallState();
	let recallDirectory: string | undefined;
	let warned = false;
	let lastError: string | undefined;
	let lastWrites = 0;

	function savedMemorySettings(): Record<string, unknown> {
		const saved = readSettingsObject(settingsPath).automaticMemory;
		return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
	}
	function saveMemorySettings(patch: Record<string, unknown>) {
		writeSettingsObject({ ...readSettingsObject(settingsPath), automaticMemory: { ...savedMemorySettings(), ...patch } }, settingsPath);
	}
	async function authorized(ctx: ExtensionContext, directory: string): Promise<boolean> {
		if (!active) return false;
		if (deps.authorize) return deps.authorize(ctx, directory);
		const directories = savedMemorySettings().authorizedDirectories;
		return Array.isArray(directories) && directories.includes(directory);
	}
	function guardedStore(ctx: ExtensionContext, directory: string): MemoryStore {
		return new MemoryStore(directory, deps.queue, async () => {
			if (!await authorized(ctx, directory)) throw new Error("Background memory access is not authorized; use /memory authorize for this directory");
		});
	}
	function cancel() { generation++; job?.abort(); job = undefined; if (timer) clearTimeout(timer); timer = undefined; }
	function warn(ctx: ExtensionContext, error: unknown) {
		lastError = sanitizeToolText(String(error)).slice(0, 400);
		if (!warned) { warned = true; ctx.ui.notify(`Automatic memory unavailable: ${lastError}`, "warning"); }
	}
	function completion(ctx: ExtensionContext): MemoryCompletion {
		if (deps.complete) return deps.complete(ctx);
		const model = ctx.model;
		if (!model) throw new Error("No active model for memory requests");
		return request => ctx.modelRegistry.complete(model, { systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools }, { signal: request.signal, maxTokens: request.maxTokens });
	}
	function usage(ctx: ExtensionContext, kind: string) {
		return (value: Usage) => {
			if (active && !job?.signal.aborted) pi.appendEntry("grok-memory-usage", { kind, model: ctx.model?.id, usage: value });
		};
	}
	function restore(ctx: ExtensionContext) {
		cursor = {};
		recall = createRecallState();
		recallDirectory = undefined;
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "grok-memory-cursor") {
				const data = entry.data as MemoryCursor;
				if (typeof data?.entryId === "string" && (data.offset === undefined || Number.isSafeInteger(data.offset) && data.offset >= 0)) cursor = data;
			}
			if (entry.customType === "grok-memory-recall") {
				const data = entry.data as { directory?: string; state?: MemoryRecallState };
				const state = data?.state;
				if (state && Array.isArray(state.surfaced) && Array.isArray(state.read) && Array.isArray(state.topics) && Array.isArray(state.history)
					&& [...state.surfaced, ...state.read, ...state.topics].every(value => typeof value === "string")
					&& Number.isFinite(state.bytes) && state.bytes >= 0 && state.bytes <= 61_440
					&& Buffer.byteLength(state.topics.join("")) <= 61_440 && JSON.stringify(state).length < 600_000) {
					recall = structuredClone(state);
					recallDirectory = data.directory;
				}
			}
		}
		const index = cursor.entryId ? entries.findIndex(entry => entry.id === cursor.entryId) : -1;
		turns = entries.slice(index + (cursor.offset === undefined ? 1 : 0)).filter(entry => entry.type === "message" && entry.message.role === "user").length;
		pendingProse = Boolean(memoryChunk(entries, cursor).text);
	}
	function saveRecall() { pi.appendEntry("grok-memory-recall", { directory: recallDirectory, state: structuredClone(recall) }); }
	function resetRecall() { recall = createRecallState(); recallDirectory = undefined; if (active) saveRecall(); }
	async function background(ctx: ExtensionContext, force = false, dreamOnly = false): Promise<void> {
		if (!active || job || !pi.getActiveTools().includes("read") || (!force && !ctx.isIdle())) return;
		const controller = new AbortController();
		job = controller;
		const token = generation;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
		const current = () => active && generation === token && !signal.aborted;
		lastError = undefined;
		lastWrites = 0;
		let lock: Awaited<ReturnType<typeof open>> | undefined;
		let lockPath: string | undefined;
		try {
			const memory = await loadProjectMemory(ctx.cwd, deps.storageRoot, { signal });
			if (!current()) return;
			if (!await authorized(ctx, memory.directory)) { lastError = "Background memory access requires /memory authorize for this directory."; return; }
			// Exclusive coordination across sessions. A crash leaves a conservative lock;
			// /memory status explains it rather than stealing an unknown writer's lock.
			lockPath = join(memory.directory, ".consolidate-lock");
			try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { lastError = `Memory worker lock exists: ${lockPath}. If no Pi memory worker is running, remove this stale lock.`; return; } throw error; }
			await lock.writeFile(JSON.stringify({ pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), started: Date.now() }));
			const store = guardedStore(ctx, memory.directory);
			const chunk = memoryChunk(ctx.sessionManager.getBranch(), cursor);
			const conversation = chunk.text;
			if (!dreamOnly && options.extraction && conversation && (force || turns >= options.everyTurns)) {
				const result = await runMemoryPass({ store, complete: completion(ctx), signal, policy: `${ctx.getSystemPrompt()}\n\n${memory.content}`, conversation, mode: "extract", onUsage: usage(ctx, "extract"), allowedTools: () => pi.getActiveTools() });
				if (!current()) return;
				lastWrites = result.writes;
				if (result.exhausted) throw new Error("Memory extraction reached its five-turn budget; cursor retained for retry");
				cursor = chunk.cursor;
				pi.appendEntry("grok-memory-cursor", cursor);
				restore(ctx);
				if (pendingProse && options.extraction) {
					timer = setTimeout(() => { timer = undefined; void background(ctx, true); }, options.idleMs);
					timer.unref();
				}
			}
			if (!options.consolidation || !deps.recentSessions || !current()) return;
			let since = 0;
			const stampPath = join(memory.directory, ".last-consolidated");
			try {
				const stat = await lstat(stampPath);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100) throw new Error("Invalid memory consolidation timestamp");
				const file = await open(stampPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const opened = await file.stat();
					if (!opened.isFile() || opened.size > 100) throw new Error("Invalid memory consolidation timestamp");
					const bytes = Buffer.alloc(101);
					const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
					if (bytesRead > 100) throw new Error("Invalid memory consolidation timestamp");
					since = Number(bytes.subarray(0, bytesRead).toString("utf8"));
				} finally { await file.close(); }
				if (!Number.isFinite(since) || since < 0) throw new Error("Invalid memory consolidation timestamp");
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (!dreamOnly && Date.now() - since < options.minHours * 3_600_000) return;
			const scanStarted = Date.now();
			const progressPath = join(memory.directory, ".consolidation-progress");
			const processed = await readMemoryProgress(progressPath, signal);
			const sessions = (await deps.recentSessions(ctx, 0, signal, processed)).filter(session => session.id !== ctx.sessionManager.getSessionId() && session.modified > (processed[session.id] ?? 0)).sort((a, b) => b.modified - a.modified);
			if (!dreamOnly && sessions.length < options.minSessions) return;
			let dreamWrites = 0;
			for (const session of sessions.slice(0, 10)) {
				for (const conversation of consolidationChunks([session])) {
					const result = await runMemoryPass({ store, complete: completion(ctx), signal, policy: `${ctx.getSystemPrompt()}\n\n${memory.content}`, conversation, mode: "consolidate", onUsage: usage(ctx, "consolidate"), allowedTools: () => pi.getActiveTools() });
					if (!current() || !await authorized(ctx, memory.directory)) return;
					if (result.exhausted) throw new Error("Memory consolidation reached its five-turn budget");
					dreamWrites += result.writes;
				}
				processed[session.id] = Math.min(session.modified, scanStarted);
				await writeMemoryProgress(progressPath, processed, deps.queue, signal);
			}
			lastWrites += dreamWrites;
			await deps.queue(stampPath, async () => {
				signal.throwIfAborted();
				const file = await open(stampPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
				try { if (!(await file.stat()).isFile()) throw new Error("Invalid consolidation timestamp"); signal.throwIfAborted(); await file.writeFile(String(scanStarted)); } finally { await file.close(); }
			});
			if (current()) pi.appendEntry("grok-memory-consolidated", { at: scanStarted, writes: dreamWrites });
		} catch (error) { if (current()) warn(ctx, error); }
		finally {
			if (lock) { await lock.close().catch(() => {}); await unlink(lockPath!).catch(() => {}); }
			if (job === controller) job = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		cancel();
		active = deps.enabled && !/^(?:1|true|yes|on)$/i.test(process.env.PI_DISABLE_AUTO_MEMORY ?? "");
		warned = false;
		if (active) restore(ctx);
	});
	pi.on("session_shutdown", () => { active = false; cancel(); });
	pi.on("session_tree", (_event, ctx) => { cancel(); if (active) restore(ctx); });
	pi.on("session_before_compact", () => { cancel(); });
	pi.on("session_compact", () => { cancel(); resetRecall(); });
	pi.on("before_agent_start", async (event, ctx) => {
		cancel();
		const sections = event.systemPromptOptions.sections ?? (event.systemPromptOptions.sections = {});
		delete sections.grok_recalled_memory;
		if (!active || typeof event.prompt !== "string" || !event.prompt.trim() || !options.recall || !pi.getActiveTools().includes("read")) return;
		const controller = new AbortController();
		job = controller;
		const token = generation;
		try {
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
			const memory = await loadProjectMemory(ctx.cwd, deps.storageRoot, { signal });
			if (!await authorized(ctx, memory.directory)) { lastError = "Background memory access requires /memory authorize for this directory."; return; }
			if (recallDirectory !== memory.directory) { recall = createRecallState(); recallDirectory = memory.directory; }
			const before = JSON.stringify(recall);
			const recalled = await recallMemory(guardedStore(ctx, memory.directory), event.prompt ?? "", completion(ctx), signal, usage(ctx, "recall"), recall);
			if (active && generation === token && !signal.aborted) {
				if (recalled) sections.grok_recalled_memory = recalled;
				if (JSON.stringify(recall) !== before) saveRecall();
			}
		} catch (error) { if (active && generation === token && !controller.signal.aborted) warn(ctx, error); }
		finally { if (job === controller) job = undefined; }
	});
	pi.on("agent_settled", (event, ctx) => {
		if (!active || event.aborted) return;
		restore(ctx);
		if (turns >= options.everyTurns) void background(ctx);
		else if (pendingProse && options.extraction) {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => { timer = undefined; void background(ctx, true); }, options.idleMs);
			timer.unref();
		} else if (options.consolidation) void background(ctx);
	});
	pi.on("tool_result", async (event, ctx) => {
		if (!active || event.isError || !["read", "write", "edit"].includes(event.toolName)) return;
		const path = (event.input as { path?: string }).path;
		if (!path) return;
		if (event.toolName === "read") {
			// Foreground authorization is already satisfied by this successful tool
			// result. Track it even before proactive recall is enabled/authorized.
			if (!recallDirectory) {
				try { recallDirectory = (await loadProjectMemory(ctx.cwd, deps.storageRoot, { signal: ctx.signal })).directory; }
				catch (error) { if (!ctx.signal?.aborted) warn(ctx, error); return; }
			}
			const name = relative(recallDirectory, resolve(ctx.cwd, path.replace(/^@/, "")));
			if (!name || name === ".." || name.startsWith(`..${sep}`) || !name.endsWith(".md") || basename(name) === "MEMORY.md") return;
			const topic = name.split(sep).join("/");
			if (!recall.read.includes(topic)) {
				recall.read.push(topic);
				while (recall.read.length > 5000 || JSON.stringify(recall.read).length > 50_000) recall.read.shift();
				saveRecall();
			}
			return;
		}
		if (basename(path) !== "MEMORY.md") return;
		try {
			const memory = await loadProjectMemory(ctx.cwd, deps.storageRoot, { signal: ctx.signal });
			if (resolve(ctx.cwd, path.replace(/^@/, "")) !== memory.indexPath) return;
			const { indexWarning } = await import("./memory-store.ts");
			const warning = indexWarning(await new MemoryStore(memory.directory, deps.queue).read("MEMORY.md", ctx.signal) ?? "");
			if (warning) return { content: [...event.content, { type: "text" as const, text: warning }] };
		} catch (error) { if (!ctx.signal?.aborted) warn(ctx, error); }
	});
	pi.registerCommand("memory", {
		description: "Memory status; on/off; authorize/revoke background access; recall|extraction|dream on/off; extract; consolidate",
		handler: async (args, ctx) => {
			const [action = "status", value] = args.trim().split(/\s+/).filter(Boolean);
			if (action === "on" || action === "off") {
				if (action === "off") { active = false; cancel(); }
				const features = loadFeatures(settingsPath);
				features.memory = action === "on";
				saveFeatures(features, settingsPath);
				ctx.ui.notify(`Memory ${action} saved; reloading. Saved files are preserved.`, "info");
				await ctx.reload(); return;
			}
			if (action === "authorize" || action === "revoke") {
				if (!active) { ctx.ui.notify("Enable memory with /memory on first.", "warning"); return; }
				const memory = await loadProjectMemory(ctx.cwd, deps.storageRoot);
				const saved = savedMemorySettings().authorizedDirectories;
				const directories = Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : [];
				if (action === "authorize") {
					if (!ctx.hasUI || !await ctx.ui.confirm("Authorize background memory access?", `Allow the private background runner to read, create, edit and delete Markdown notes in ${memory.directory}, and inspect recent session prose for consolidation? This separate capability does NOT invoke ordinary tool_call approval hooks. It grants no shell or repository access. No access is granted if you decline.`)) {
						ctx.ui.notify("No background memory access granted.", "warning"); return;
					}
					saveMemorySettings({ authorizedDirectories: [...new Set([...directories, memory.directory])] });
					ctx.ui.notify("Background memory access authorized for this directory only.", "info");
				} else {
					cancel(); resetRecall();
					saveMemorySettings({ authorizedDirectories: directories.filter(directory => directory !== memory.directory) });
					ctx.ui.notify("Background memory access revoked. Previously seen context and saved files remain; start a new session to discard prior context.", "info");
				}
				return;
			}
			const key = action === "dream" ? "consolidation" : action;
			if (["recall", "extraction", "consolidation"].includes(key) && ["on", "off"].includes(value)) {
				cancel(); options = { ...options, [key]: value === "on" };
				saveMemorySettings(options);
				ctx.ui.notify(`Memory ${action} ${value}.`, "info"); return;
			}
			if (action === "extract" || action === "consolidate") {
				if (!active) { ctx.ui.notify("Memory is disabled. Enable it with /memory on first.", "warning"); return; }
				if (action === "extract" ? !options.extraction : !options.consolidation) { ctx.ui.notify(`This memory mode is disabled; enable /memory ${action === "extract" ? "extraction" : "dream"} on first.`, "warning"); return; }
				await ctx.waitForIdle(); cancel(); restore(ctx);
				await background(ctx, true, action === "consolidate");
				ctx.ui.notify(lastError ?? `Memory pass finished (${lastWrites} mutations).`, lastError ? "warning" : "info"); return;
			}
			if (action !== "status") { ctx.ui.notify("Usage: /memory [status|on|off|authorize|revoke|recall on/off|extraction on/off|dream on/off|extract|consolidate]", "warning"); return; }
			const memory = active ? await loadProjectMemory(ctx.cwd, deps.storageRoot) : undefined;
			const costs = ctx.sessionManager.getBranch().reduce((total, entry) => {
				if (entry.type !== "custom" || entry.customType !== "grok-memory-usage") return total;
				const usage = (entry.data as { usage?: Usage })?.usage;
				return total + (usage?.cost?.total ?? 0);
			}, 0);
			ctx.ui.notify(`Memory ${active ? "on" : "off"}; recall ${options.recall ? "on" : "off"}, extraction ${options.extraction ? "on" : "off"}, dream ${options.consolidation ? "on" : "off"}. ${memory?.directory ?? "No store accessed."} Background access: ${memory && await authorized(ctx, memory.directory) ? "authorized" : "not authorized; use /memory authorize"}.${lastError ? ` Last issue: ${lastError}` : ""} Background requests use the active model and may incur costs (recorded branch cost: $${costs.toFixed(4)}).`, "info");
		},
	});
}
