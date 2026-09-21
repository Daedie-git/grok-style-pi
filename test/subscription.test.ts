import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexQuota, formatCodexQuota } from "../src/subscription.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { BUILTIN_TOOL_NAMES } from "../src/tools.ts";

const headers = {
	"X-Codex-Primary-Used-Percent": "23.4",
	"x-codex-primary-window-minutes": "300",
	"x-codex-primary-reset-at": "2000000000",
	"x-codex-secondary-used-percent": "12",
	"x-codex-secondary-window-minutes": "10080",
	"x-codex-secondary-reset-at": "2000600000",
};

test("Codex footer shows weekly quota remaining and respects reset expiry", () => {
	const quota = parseCodexQuota(headers);
	assert.equal(formatCodexQuota(quota, 0), "Weekly 88% left");
	assert.equal(formatCodexQuota(quota, 2000000000001), "Weekly 88% left");
	assert.equal(formatCodexQuota(quota, 2000600000001), "Weekly ?% left");
	assert.equal(formatCodexQuota([{ label: "7d", usedPercent: 0 }]), "Weekly 100% left");
	assert.equal(formatCodexQuota([{ label: "7d", usedPercent: 105 }]), "Weekly 0% left");
	assert.equal(formatCodexQuota([]), "Weekly ?% left");
	assert.deepEqual(parseCodexQuota({ "x-codex-primary-used-percent": "NaN" }), []);
	assert.deepEqual(parseCodexQuota({ "x-codex-primary-used-percent": "" }), []);
	assert.deepEqual(parseCodexQuota({ "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "0" }), []);
	assert.equal(formatCodexQuota(parseCodexQuota({ "x-codex-secondary-used-percent": "0", "x-codex-secondary-window-minutes": "1440" })), "Weekly ?% left");
});

test("footer refreshes from Codex response headers and clears quota on model changes", () => {
	const handlers: Record<string, Function> = {};
	let footer: { render(width: number): string[] };
	let redraws = 0;
	const ctx = { cwd: "/tmp/project", hasUI: true, model: { name: "Codex", provider: "openai-codex" }, ui: {
		setFooter(factory: Function) { footer = factory({ requestRender() { redraws++; } }, { fg: (_: string, s: string) => s }); },
	} };
	createGrokStyleExtension({
		on(event, handler) { handlers[event] = handler; }, registerTool() {}, getThinkingLevel: () => "high",
	}, {
		CustomEditor: class { render() { return []; } },
		tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map((name) => [name, () => ({ name, description: name, parameters: {}, execute() {} })])) as any,
	});
	handlers.session_start({}, ctx);
	assert.match(footer!.render(160)[0], /Context \?% used/);
	assert.match(footer!.render(160)[0], /Weekly \?% left/);
	assert.doesNotMatch(footer!.render(160)[0], /Grok|Codex Context|Codex weekly/);
	const redrawsAfterStart = redraws;
	handlers.after_provider_response({ headers }, ctx);
	assert.equal(redraws, redrawsAfterStart + 1);
	assert.equal(footer!.render(160).length, 1);
	assert.match(footer!.render(160)[0], /Weekly 88% left/);
	handlers.after_provider_response({ headers: {} }, ctx);
	assert.match(footer!.render(160)[0], /Weekly 88% left/);
	ctx.model.provider = "anthropic";
	handlers.model_select({}, ctx);
	handlers.after_provider_response({ headers }, ctx);
	assert.doesNotMatch(footer!.render(160)[0], /Weekly/);
	assert.match(footer!.render(160)[0], /Context \?% used/);
	ctx.model.provider = "openai-codex";
	assert.match(footer!.render(160)[0], /Weekly \?% left/);
	assert.doesNotMatch(footer!.render(160)[0], /Grok/);
});

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const usage = { rate_limit: { primary_window: { used_percent: 54, limit_window_seconds: 604800, reset_at: 2000600000 } } };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("usage endpoint supports a weekly primary window and sends only scoped authentication", async () => {
	const { fetchCodexUsage, parseCodexUsage } = await import("../src/subscription.ts");
	const windows = await fetchCodexUsage(token, new AbortController().signal, (async (url, options) => {
		assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
		assert.equal(new Headers(options?.headers).get("ChatGPT-Account-Id"), "test-account");
		assert.equal(options?.redirect, "error");
		return Response.json(usage);
	}) as typeof fetch);
	assert.equal(formatCodexQuota(windows, 0), "Weekly 46% left");
	assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "54", limit_window_seconds: 604800 } } }), []);
	await assert.rejects(fetchCodexUsage("not-oauth", new AbortController().signal, async () => { throw new Error("should not fetch"); }), /login required/);
});

test("quota polling does not overlap, discards disposed responses and sanitizes failures", async (t) => {
	const { startCodexUsagePolling } = await import("../src/subscription.ts");
	let calls = 0, updates = 0;
	let finish: (response: Response) => void;
	let signal: AbortSignal;
	const polling = startCodexUsagePolling(async () => token, () => { updates++; }, (async (_url, options) => {
		calls++; signal = options!.signal!;
		return new Promise<Response>((resolve) => { finish = resolve; });
	}) as typeof fetch);
	t.after(() => polling.dispose());
	await flush();
	await polling.refresh();
	assert.equal(calls, 1);
	polling.dispose();
	assert.equal(signal!.aborted, true);
	finish!(Response.json(usage));
	await flush();
	assert.equal(updates, 0);
	let error: string | undefined;
	const failed = startCodexUsagePolling(async () => token, (_windows, reason) => { error = reason; }, async () => { throw new Error(`secret ${token}`); });
	t.after(() => failed.dispose());
	await flush();
	assert.equal(error, "unavailable");
});

test("footer fetches weekly usage without response headers and stops on model switch", async (t) => {
	const handlers: Record<string, Function> = {};
	let footer: { render(width: number): string[] };
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(usage); });
	const ctx = { cwd: "/tmp/project", hasUI: true, mode: "tui", model: { name: "Codex", provider: "openai-codex" },
		modelRegistry: { getApiKeyForProvider: async () => token }, ui: {
			setFooter(factory: Function) { footer = factory({ requestRender() {} }, { fg: (_: string, s: string) => s }); },
		} };
	createGrokStyleExtension({ on(name, handler) { handlers[name] = handler; }, registerTool() {} }, {
		CustomEditor: class { render() { return []; } },
		tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map((name) => [name, () => ({ name, description: name, parameters: {}, execute() {} })])) as any,
	});
	t.after(() => handlers.session_shutdown());
	handlers.session_start({}, ctx);
	await flush();
	assert.equal(calls, 1);
	assert.match(footer!.render(160)[0], /Weekly 46% left/);
	ctx.model.provider = "anthropic";
	handlers.model_select({}, ctx);
	await flush();
	assert.equal(calls, 1);
	assert.doesNotMatch(footer!.render(160)[0], /Weekly/);
});
