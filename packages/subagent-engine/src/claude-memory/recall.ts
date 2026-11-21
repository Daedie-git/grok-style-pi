// Pi reads Claude Code's project memory: the startup index or selected topic files, never both for a prompt.
import { homedir } from "node:os";
import { join } from "node:path";
import { readMemoryIndex } from "./index-content.ts";
import { usesMemorySelector } from "./mode.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claudeConfig, claudeMemoryDirectory, isClaudeMemoryPath, memoryDirectory, mentionsClaudeMemory, projectBase, projectMemoryDirectories, protectedRoots, settingsRoots, toolPath, type ClaudeConfig, type ProtectedRoots } from "./location.ts";
import { claudeCodeRunner, memoryPreview, recalledMemoryText, scanClaudeMemories, selectMemories, selectorModels, type SelectorRunner } from "./selector.ts";

/** Claude Code's accumulated recall budget per conversation (61,440 JavaScript string units). */
const RECALL_BUDGET = 61_440;
const STATE_ENTRY = "claude-memory-recall";
export const RECALL_MESSAGE = "claude-memory-recall";
export const MEMORY_STATUS = "claude-memory";
export type ClaudeMemoryStatus = "off" | "on" | "recalling" | "error";

export interface ClaudeMemoryOptions {
	/** Host master switch for recall. The write guard applies regardless. */
	enabled?: () => boolean;
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Selector transport; headless Claude Code by default. */
	run?: SelectorRunner;
	/** Install only the write guard, never recall (the host's `claudeMemory: false`). */
	guardOnly?: boolean;
}

type RecallState = { directory?: string; surfaced: string[]; read: string[]; used: number };
const fresh = (): RecallState => ({ surfaced: [], read: [], used: 0 });

/** Block reason when a Pi tool call would change Claude memory; Claude Code is the only writer. */
export function claudeMemoryWriteBlock(toolName: string, input: unknown, cwd: string, roots: ProtectedRoots): string | undefined {
	const args = (input ?? {}) as Record<string, unknown>;
	const name = toolName.toLowerCase();
	if (name === "write" || name === "edit") {
		const path = args.path ?? args.file_path;
		if (typeof path === "string" && isClaudeMemoryPath(toolPath(path, cwd, roots.home), roots)) {
			return "Claude Code memory is read-only for Pi agents. Only Claude Code writes memory.";
		}
	}
	if ((name === "bash" || name === "powershell") && typeof args.command === "string" && mentionsClaudeMemory(args.command, roots)) {
		return "Shell commands may not touch Claude Code memory; Pi agents read it only, with the read tool.";
	}
	return undefined;
}

/**
 * The write guard for one engine, root or child. Claude's configuration and the working copy's settings are read on every
 * check, so a newly configured folder is protected at once; only the Git lookups are cached per working directory.
 */
export function claudeMemoryGuard(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
	const bases = new Map<string, Promise<string | undefined>>();
	const settings = new Map<string, Promise<string[]>>();
	const cached = <T>(map: Map<string, Promise<T>>, cwd: string, load: () => Promise<T>) => {
		if (!map.has(cwd)) map.set(cwd, load());
		return map.get(cwd)!;
	};
	return {
		async check(toolName: string, input: unknown, cwd: string): Promise<string | undefined> {
			const config = claudeConfig(env, home);
			const base = await cached(bases, cwd, () => projectBase(cwd).catch(() => undefined));
			const roots = await cached(settings, cwd, () => settingsRoots(cwd).catch(() => [cwd]));
			const folders = [config.configuredDirectory, base === undefined ? undefined : memoryDirectory(config, base), ...projectMemoryDirectories(roots, home)];
			return claudeMemoryWriteBlock(toolName, input, cwd, protectedRoots(config, folders));
		},
	};
}

export function installClaudeMemory(pi: ExtensionAPI, options: ClaudeMemoryOptions = {}): void {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const run = options.run ?? claudeCodeRunner({ env });
	const guard = claudeMemoryGuard(env, home);
	// `live`: a session is running. Whether recall is on is always read fresh from `enabled()`.
	let live = false;
	let state = fresh();
	let job: AbortController | undefined;
	let context: ExtensionContext | undefined;
	let index: { path: string; override?: string; content?: string } | undefined;
	let status: ClaudeMemoryStatus | undefined;
	let lastError: string | undefined;
	let last: { model?: string; files: string[]; costUsd?: number } | undefined;

	const publish = (next: ClaudeMemoryStatus) => {
		if (status === next) return;
		status = next;
		context?.ui.setStatus?.(MEMORY_STATUS, next);
	};
	const on = (config?: ClaudeConfig) => live && enabled(config);
	const stillSelecting = () => { const config = claudeConfig(env, home); return on(config) && usesMemorySelector(config); };
	const idle = () => publish(!on() ? "off" : lastError ? "error" : "on");
	const cancel = () => { job?.abort(); job = undefined; };
	const save = () => pi.appendEntry(STATE_ENTRY, structuredClone(state));
	// One read of Claude's configuration per decision; `config` lets a caller reuse a snapshot it already holds.
	const enabled = (config: ClaudeConfig = claudeConfig(env, home)) => !options.guardOnly && (options.enabled?.() ?? true) && !/^(?:1|true|yes|on)$/i.test(env.PI_DISABLE_AUTO_MEMORY ?? "") && !config.disabled;

	function restore(ctx: ExtensionContext) {
		state = fresh();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const data = entry.data as Partial<RecallState> | undefined;
			if (Array.isArray(data?.surfaced) && Array.isArray(data.read) && typeof data.used === "number") {
				state = { directory: typeof data.directory === "string" ? data.directory : undefined, surfaced: data.surfaced.filter((v) => typeof v === "string"), read: data.read.filter((v) => typeof v === "string"), used: data.used };
			}
		}
	}

	async function recall(ctx: ExtensionContext, query: string, controller: AbortController, config: ClaudeConfig) {
		const { signal } = controller;
		const current = () => job === controller && !signal.aborted && live;
		try {
			// One configuration snapshot for this selection; opt-outs are checked again before anything is delivered.
			const directory = await claudeMemoryDirectory(ctx.cwd, config);
			if (!current()) return;
			if (state.directory !== directory) { state = { ...fresh(), directory }; save(); }
			if (state.used >= RECALL_BUDGET) return;
			publish("recalling");
			const seen = new Set([...state.surfaced, ...state.read]);
			const files = (await scanClaudeMemories(directory, signal)).filter((file) => !seen.has(file.filePath));
			if (!files.length || !current()) return;
			const catalog = ctx.modelRegistry.getAll().filter((model) => model.provider === "anthropic")
				.map((model) => ({ id: model.id, price: model.cost ? model.cost.input + model.cost.output : undefined }));
			const models = selectorModels(config.sonnet, catalog, config.noModelFallback);
			// Sending the query and note list is its own decision: Claude Code's opt-outs are checked right before each request,
			// fallbacks included, and an opt-out ends this selection.
			const send: SelectorRunner = (request) => {
				if (!stillSelecting()) { controller.abort(); return Promise.resolve({ ok: false, refused: false, message: "Claude Code memory was turned off" }); }
				return run(request);
			};
			const selection = await selectMemories({ query, files, models, run: send, signal });
			if (!current()) return;
			last = { model: selection.model, files: selection.filenames, costUsd: selection.costUsd };
			lastError = selection.error;
			const byName = new Map(files.map((file) => [file.filename, file]));
			const memories: Parameters<typeof recalledMemoryText>[0] = [];
			for (const name of selection.filenames) {
				const file = byName.get(name)!;
				if (state.read.includes(file.filePath)) continue;
				const preview = await memoryPreview(file.filePath);
				if (!preview || !current()) continue;
				const memory = { path: file.filePath, mtimeMs: file.mtimeMs, ...preview };
				// Charge the exact text that will be delivered, measured as a batch.
				if (state.used + recalledMemoryText([...memories, memory]).length > RECALL_BUDGET) continue;
				memories.push(memory);
			}
			// Claude Code's opt-outs may change while the selector runs; a change takes effect before delivery.
			if (!memories.length || !current() || !stillSelecting()) return;
			const content = recalledMemoryText(memories);
			state.used += content.length;
			state.surfaced.push(...memories.map((memory) => memory.path));
			save();
			// A hidden reference queued for the next model request: never steer, interrupt, or start a turn for recall.
			pi.sendMessage({ customType: RECALL_MESSAGE, content, display: false, details: { paths: memories.map((memory) => memory.path), model: selection.model } }, { triggerTurn: false });
		} catch (error) {
			if (current()) lastError = String(error).slice(0, 400);
		} finally {
			if (job === controller) { job = undefined; idle(); }
		}
	}

	pi.on("session_start", (_event, ctx) => {
		cancel();
		context = ctx;
		index = undefined;
		status = undefined;
		lastError = undefined;
		last = undefined;
		live = true;
		restore(ctx);
		idle();
	});
	pi.on("session_tree", (_event, ctx) => { cancel(); last = undefined; restore(ctx); idle(); });
	// Compaction drops recalled notes from context, so they may be selected again.
	pi.on("session_compact", () => { cancel(); state = { ...fresh(), directory: state.directory }; if (live) save(); idle(); });
	pi.on("session_shutdown", () => { live = false; cancel(); context?.ui.setStatus?.(MEMORY_STATUS, undefined); context = undefined; status = undefined; });
	pi.on("before_agent_start", async (event, ctx) => {
		cancel();
		const config = claudeConfig(env, home);
		if (!on(config)) { index = undefined; idle(); return; }
		if (!usesMemorySelector(config)) {
			if (/^(?:1|true|yes|on)$/i.test(config.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS?.trim() ?? "")) {
				index = undefined;
			} else {
				const path = join(await claudeMemoryDirectory(ctx.cwd, config), "MEMORY.md");
				const override = config.env.CLAUDE_COWORK_MEMORY_INDEX_CONTENT;
				if (index?.path !== path || index.override !== override) index = { path, override, content: await readMemoryIndex(path, config.env) };
			}
			lastError = undefined;
			idle();
			return;
		}
		index = undefined;
		if (typeof event.prompt !== "string" || !event.prompt.trim()) return;
		const controller = new AbortController();
		job = controller;
		// Submission never waits for the scan or the selector.
		void recall(ctx, event.prompt, controller, config);
	});
	// A user-role startup reminder, not system policy or an extra entry each time Pi submits a prompt.
	pi.on("context_with_system", (event) => {
		if (!index?.content || !on()) return;
		return { messages: [event.messages[0], { role: "user", content: index.content, timestamp: 0 }, ...event.messages.slice(1)] };
	});
	// Claude Code discards a selection that is not ready when the turn ends.
	pi.on("agent_settled", () => { if (job) { cancel(); idle(); } });

	pi.on("tool_call", async (event, ctx) => {
		const reason = await guard.check(event.toolName, event.input, ctx.cwd);
		return reason ? { block: true, reason } : undefined;
	});
	pi.on("tool_result", (event, ctx) => {
		if (!live || event.isError || event.toolName !== "read" || !state.directory) return;
		const path = (event.input as { path?: string }).path;
		if (typeof path !== "string") return;
		const target = toolPath(path, ctx.cwd, home);
		if (!isClaudeMemoryPath(target, protectedRoots(claudeConfig(env, home), [state.directory])) || state.read.includes(target)) return;
		state.read.push(target);
		save();
	});

	pi.registerCommand("memory", {
		description: "Show Claude Code memory recall status (Pi reads Claude Code's memory; only Claude Code writes it)",
		handler: async (_args, ctx) => {
			const config = claudeConfig(env, home);
			const directory = await claudeMemoryDirectory(ctx.cwd, config).catch((error) => `unavailable (${String(error)})`);
			const enabledNow = on(config);
			const selecting = enabledNow && usesMemorySelector(config);
			const files = selecting && !directory.startsWith("unavailable") ? (await scanClaudeMemories(directory).catch(() => [])).length : 0;
			const selector = selectorModels(config.sonnet, ctx.modelRegistry.getAll().filter((model) => model.provider === "anthropic")
				.map((model) => ({ id: model.id, price: model.cost ? model.cost.input + model.cost.output : undefined })), config.noModelFallback);
			ctx.ui.notify([
				`Claude memory recall ${enabledNow ? "on" : "off"}. Pi never writes memory; Claude Code does.`,
				`Directory: ${directory}${selecting ? ` (${files} notes)` : ""}`,
				...(enabledNow && !selecting ? [`Mode: startup index (${join(directory, "MEMORY.md")}); no retrieval model.`] : []),
				...(selecting ? [`Mode: topic selector (headless Claude Code), models ${selector.join(" → ")}`,
				last ? `Last recall: ${last.files.length ? last.files.join(", ") : "nothing relevant"}${last.model ? ` via ${last.model}` : ""}${last.costUsd !== undefined ? ` ($${last.costUsd.toFixed(4)})` : ""}` : "No recall yet this session.",
				`Recalled this conversation: ${state.surfaced.length} notes, ${state.used} of ${RECALL_BUDGET} units.`] : []),
				...(lastError ? [`Last issue: ${lastError}`] : []),
			].join("\n"), lastError ? "warning" : "info");
		},
	});
}
