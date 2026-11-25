/**
 * Two ChatGPT accounts for OpenAI Codex, with automatic failover.
 *
 * - `openai-codex` is account 1 (Pi's built-in login).
 * - `openai-codex-2` is account 2: the same provider under its own id, so
 *   `/login` keeps a separate credential for it in auth.json.
 * - `codex-auto/<model>` is a virtual model per Codex model. It stays on the
 *   account that answered last (prompt cache), and moves to the other account
 *   when one hits its ChatGPT usage limit. The failed request is retried there.
 *
 * A spent account is recorded under `<agent dir>/codex-accounts/`, shared by
 * every Pi process, until its reset time. A quota error is held until the
 * reset time it reports, or 15 minutes; a bare 429 is held for 2 minutes.
 *
 * Not covered: compaction summaries bypass the agent loop, so a usage limit
 * hit by one neither fails over nor marks the account. A later agent turn that
 * hits the limit does both.
 *
 * `/codex-accounts` shows the state; `/codex-accounts reset` clears it.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export interface AccountPoolOptions {
	/** Provider ids, in preference order. Each one is one account. */
	accounts: readonly string[];
	/** Provider whose models the virtual models mirror. */
	sourceProvider: string;
	/** Provider id the virtual models are listed under. */
	virtualProvider: string;
	/** Directory of per-account spent-until files. */
	stateDir: string;
	/** Display names for messages, keyed by provider id. */
	labels?: Record<string, string>;
	now?: () => number;
}

/** Codex errors that may mean the account is out of quota. */
const LIMIT_TEXT = /usage.?limit|usage_not_included|rate_limit_exceeded|(?<![a-z0-9])429(?![a-z0-9])|too many requests/i;
/** Codes that positively mean quota, not throttling. */
const QUOTA_CODE = /usage_limit_reached|usage_not_included|subscription_sharing(?:_workplace_individual)?_usage_limit_exceeded/i;
const SWITCH_MARK = "[codex-accounts]";
const QUOTA_COOLDOWN_MS = 15 * 60_000;
const THROTTLE_COOLDOWN_MS = 2 * 60_000;

interface StreamQuota {
	code?: string;
	resetsAt?: number;
	at: number;
}

/** Quota code and reset time from a raw Codex `error` or `response.failed` event. */
export function streamQuota(data: unknown, at: number): StreamQuota | undefined {
	if (!data || typeof data !== "object") return undefined;
	const event = data as Record<string, any>;
	if (event.type !== "error" && event.type !== "response.failed") return undefined;
	// Same precedence as Pi: response.error.code for response.failed; top-level, then nested code for error.
	const error = event.type === "response.failed" ? event.response?.error : event.error;
	const codes = event.type === "response.failed" ? [error?.code, error?.type] : [event.code, error?.code, event.type === "error" ? error?.type : undefined];
	const code = codes.find((c) => typeof c === "string") as string | undefined;
	const resets = Number(error?.resets_at ?? event.resets_at);
	if (!code || !(QUOTA_CODE.test(code) || LIMIT_TEXT.test(code))) return undefined;
	return { code, resetsAt: Number.isFinite(resets) && resets > 0 ? resets * 1000 : undefined, at };
}

/**
 * When the account can be used again, or undefined if this is not a limit error.
 * `reported` says whether ChatGPT gave the time, or it is this extension's cooldown.
 */
export function limitUntil(
	message: Pick<AssistantMessage, "stopReason" | "errorMessage">,
	stream: StreamQuota | undefined,
	now: number,
): { until: number; reported: boolean } | undefined {
	if (message.stopReason !== "error") return undefined;
	const text = message.errorMessage ?? "";
	if (!stream && !LIMIT_TEXT.test(text)) return undefined;
	if (stream?.resetsAt) return { until: Math.max(now + 60_000, stream.resetsAt), reported: true };
	const minutes = /try again in ~?\s*(\d+)\s*min/i.exec(text);
	if (minutes) return { until: now + Math.max(1, Number(minutes[1])) * 60_000, reported: true };
	const quota = (stream?.code && QUOTA_CODE.test(stream.code)) || QUOTA_CODE.test(text);
	return { until: now + (quota ? QUOTA_COOLDOWN_MS : THROTTLE_COOLDOWN_MS), reported: false };
}

/**
 * Each mark is its own file, `<account>~<until>.json`, and an account's deadline is
 * the latest one. Writers never read-modify-write, so concurrent processes cannot
 * shorten or drop each other's deadlines.
 */
class LimitStore {
	constructor(
		private readonly dir: string,
		private readonly now: () => number,
	) {}

	private entries(): { name: string; id: string; until: number }[] {
		let names: string[] = [];
		try {
			names = readdirSync(this.dir);
		} catch {
			return [];
		}
		return names.flatMap((name) => {
			const match = /^(.+)~(\d+)\.json$/.exec(name);
			return match ? [{ name, id: decodeURIComponent(match[1]), until: Number(match[2]) }] : [];
		});
	}

	until(id: string): number {
		let latest = 0;
		const now = this.now();
		for (const entry of this.entries()) {
			if (entry.id === id) latest = Math.max(latest, entry.until);
			// Expired marks are no longer needed by anyone.
			if (entry.until < now - 60_000) rmSync(join(this.dir, entry.name), { force: true });
		}
		return latest;
	}

	mark(id: string, until: number): void {
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, `${encodeURIComponent(id)}~${Math.round(until)}.json`), "{}\n");
	}

	clear(): void {
		for (const entry of this.entries()) rmSync(join(this.dir, entry.name), { force: true });
	}
}

/** Registers the router, failover and command; returns a function that syncs the virtual models. */
export function accountPool(pi: ExtensionAPI, options: AccountPoolOptions): (models: readonly Model<Api>[]) => void {
	const now = options.now ?? Date.now;
	const label = (id: string) => options.labels?.[id] ?? id;
	const store = new LimitStore(options.stateDir, now);
	const registered = new Map<string, string>();
	const streamErrors = new Map<string, StreamQuota>();

	const usable = (id: string, t: number) => !(store.until(id) > t);

	/** Accounts that are logged in and have this model, with their physical model. */
	const candidates = (ctx: ExtensionContext, modelId: string) =>
		options.accounts.flatMap((id) => {
			const model = ctx.modelRegistry.find(id, modelId);
			return model && ctx.modelRegistry.hasConfiguredAuth(model) ? [{ id, model }] : [];
		});

	const pick = (ctx: ExtensionContext, modelId: string, prefer?: string, avoid?: string): Model<Api> => {
		const all = candidates(ctx, modelId);
		if (all.length === 0) {
			throw new Error(`No logged-in account has ${modelId}. Run /login for ${options.accounts.map(label).join(" or ")}.`);
		}
		const t = now();
		const open = all.filter((c) => usable(c.id, t));
		const choice =
			open.find((c) => c.id === prefer && c.id !== avoid) ??
			open.find((c) => c.id !== avoid) ??
			open[0] ??
			// Every account is spent: use the one that resets first.
			[...all].sort((a, b) => store.until(a.id) - store.until(b.id))[0];
		return choice.model;
	};

	const registerVirtual = (source: Model<Api>) => {
		pi.registerVirtualModel({
			provider: options.virtualProvider,
			id: source.id,
			name: `${source.name} (auto account)`,
			thinkingLevels: getSupportedThinkingLevels(source),
			contextWindow: source.contextWindow,
			maxTokens: source.maxTokens,
			input: source.input,
			route(request, ctx) {
				const modelId = request.model.id;
				const thinkingLevel = request.thinkingLevel;
				if (request.reason === "retry" && request.failed) {
					const failed = request.failed.model.provider;
					// Only a limit moves accounts; other failures retry where they were.
					const moved = request.failed.message.errorMessage?.includes(SWITCH_MARK);
					return { model: moved ? pick(ctx, modelId, undefined, failed) : pick(ctx, modelId, failed), thinkingLevel };
				}
				// Stay on the account that answered last, so its prompt cache stays warm.
				return { model: pick(ctx, modelId, request.previous?.model.provider), thinkingLevel };
			},
		});
	};

	const syncVirtualModels = (models: readonly Model<Api>[]) => {
		const live = new Map(models.filter((m) => m.provider === options.sourceProvider).map((m) => [m.id, m]));
		for (const id of registered.keys()) {
			if (live.has(id)) continue;
			pi.unregisterVirtualModel(options.virtualProvider, id);
			registered.delete(id);
		}
		for (const [id, model] of live) {
			const key = JSON.stringify([model.name, getSupportedThinkingLevels(model), model.contextWindow, model.maxTokens, model.input]);
			if (registered.get(id) === key) continue;
			registerVirtual(model);
			registered.set(id, key);
		}
	};

	pi.on("provider_stream_event", (event) => {
		if (!options.accounts.includes(event.provider)) return;
		const quota = streamQuota(event.data, now());
		if (quota) streamErrors.set(event.provider, quota);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !options.accounts.includes(message.provider)) return;
		const t = now();
		let stream = streamErrors.get(message.provider);
		streamErrors.delete(message.provider);
		if (stream && t - stream.at > 60_000) stream = undefined;
		if (message.errorMessage?.includes(SWITCH_MARK)) return;
		const limit = limitUntil(message, stream, t);
		if (limit === undefined) return;
		store.mark(message.provider, limit.until);
		// Only the virtual models can move to another account.
		if (ctx.model?.provider !== options.virtualProvider) return;
		const next = candidates(ctx, message.model).find((c) => c.id !== message.provider && usable(c.id, t));
		if (!next) return;
		const minutes = Math.max(1, Math.round((limit.until - t) / 60_000));
		const when = limit.reported ? `resets in ~${minutes} min` : `will be tried again in ~${minutes} min`;
		// The text must read as a retryable rate limit to Pi; the router then sends the retry to `next`.
		return {
			message: {
				...message,
				errorMessage: `${SWITCH_MARK} ${label(message.provider)} hit its ChatGPT usage limit (rate limit; ${when}); ${label(next.id)} is available for a retry.`,
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		syncVirtualModels(ctx.modelRegistry.getAll());
	});

	pi.registerCommand("codex-accounts", {
		description: "Show ChatGPT account usage-limit state (`reset` clears it)",
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				store.clear();
				ctx.ui.notify("Cleared usage-limit state for all accounts.", "info");
				return;
			}
			const t = now();
			const lines = options.accounts.map((id) => {
				const probe = ctx.modelRegistry.getAll().find((m) => m.provider === id);
				const loggedIn = probe ? ctx.modelRegistry.hasConfiguredAuth(probe) : false;
				const until = store.until(id);
				const state = !loggedIn
					? "not logged in"
					: until > t
						? `on cooldown until ~${new Date(until).toLocaleTimeString()}`
						: "available";
				return `${label(id)} (${id}): ${state}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	return syncVirtualModels;
}

/** Pi's built-in Codex provider under another id, so it keeps its own login. */
export function cloneProvider(base: Provider, id: string, name: string, source: () => readonly Model<Api>[]): Provider {
	const models = () => source().map((m) => ({ ...m, provider: id }));
	const oauth = base.auth.oauth;
	return {
		...base,
		id,
		name,
		auth: { ...base.auth, ...(oauth ? { oauth: { ...oauth, name: `${oauth.name} — ${name}` } } : {}) },
		getModels: models,
		getAllModels: models,
		refreshModels: undefined,
	};
}

export default function (pi: ExtensionAPI) {
	const codex = builtinProviders().find((p) => p.id === "openai-codex");
	if (!codex) return;
	// Account 2 mirrors account 1's catalog, including models.json and refreshed entries.
	let catalog: readonly Model<Api>[] = codex.getModels();
	const account2 = cloneProvider(codex, "openai-codex-2", "OpenAI Codex (account 2)", () => catalog);
	pi.registerProvider(account2);
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const syncVirtualModels = accountPool(pi, {
		accounts: ["openai-codex", "openai-codex-2"],
		sourceProvider: "openai-codex",
		virtualProvider: "codex-auto",
		stateDir: join(agentDir, "codex-accounts"),
		labels: { "openai-codex": "ChatGPT account 1", "openai-codex-2": "ChatGPT account 2" },
	});
	// Registered now so `codex-auto/...` works for startup model selection.
	syncVirtualModels(catalog);
	pi.on("session_start", (_event, ctx) => {
		const live = ctx.modelRegistry.getAll().filter((m) => m.provider === "openai-codex");
		if (JSON.stringify(live) === JSON.stringify(catalog)) return;
		catalog = live;
		pi.registerProvider(account2);
	});
}
