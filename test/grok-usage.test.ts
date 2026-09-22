import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatGrokWeekly, parseGrokCredits, readGrokContextPercent, startGrokFooterPolling } from "../src/extension/grok-usage.ts";

const credits = {
	config: {
		creditUsagePercent: 37,
		currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" },
	},
};

test("Grok weekly remaining comes from the credits config and ignores other periods", () => {
	assert.equal(formatGrokWeekly(parseGrokCredits(credits), 0), "Weekly 63% left");
	assert.equal(formatGrokWeekly(parseGrokCredits({ config: { creditUsagePercent: 0, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } })), "Weekly 100% left");
	assert.equal(formatGrokWeekly(parseGrokCredits({ config: { creditUsagePercent: 105, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } })), "Weekly 0% left");
	assert.equal(formatGrokWeekly(parseGrokCredits({ config: { creditUsagePercent: 10, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } })), "Weekly ?% left");
	assert.equal(formatGrokWeekly(parseGrokCredits({ config: { creditUsagePercent: 10, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2000-01-01T00:00:00Z" } } })), "Weekly ?% left");
	assert.equal(formatGrokWeekly(undefined), "Weekly ?% left");
	assert.equal(parseGrokCredits({ config: { creditUsagePercent: "37" } }), undefined);
});

test("Grok context percent prefers the active session for this directory", () => {
	const home = mkdtempSync(join(tmpdir(), "grok-usage-"));
	const cwd = "/tmp/demo-project";
	const encoded = encodeURIComponent(cwd);
	const older = join(home, "sessions", encoded, "older");
	const active = join(home, "sessions", encoded, "active-session");
	mkdirSync(older, { recursive: true });
	mkdirSync(active, { recursive: true });
	writeFileSync(join(older, "signals.json"), JSON.stringify({ contextWindowUsage: 80 }));
	writeFileSync(join(active, "signals.json"), JSON.stringify({ contextWindowUsage: 6 }));
	utimesSync(join(older, "signals.json"), new Date(), new Date(Date.now() + 60_000));
	writeFileSync(join(home, "active_sessions.json"), JSON.stringify([
		{ session_id: "elsewhere", cwd: "/tmp/other", opened_at: "2026-09-21T00:00:00Z" },
		{ session_id: "active-session", cwd, opened_at: "2026-09-21T01:00:00Z" },
	]));
	try {
		assert.equal(readGrokContextPercent(cwd, home), 6);
		writeFileSync(join(home, "active_sessions.json"), "[]");
		assert.equal(readGrokContextPercent(cwd, home), 80);
		assert.equal(readGrokContextPercent("/tmp/missing", home), null);
		writeFileSync(join(home, "active_sessions.json"), "{");
		assert.equal(readGrokContextPercent(cwd, home), undefined);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

const token = `test.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.signature`;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("credits polling sends the xAI login and keeps the last context when a read fails", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "grok-poll-"));
	const cwd = "/tmp/demo-project";
	const session = join(home, "sessions", encodeURIComponent(cwd), "session-1");
	mkdirSync(session, { recursive: true });
	writeFileSync(join(session, "signals.json"), JSON.stringify({ contextWindowUsage: 6 }));
	let calls = 0;
	const seen: string[] = [];
	const polling = startGrokFooterPolling(() => cwd, async () => token, (stats) => { seen.push(`${stats.contextPercent} ${stats.weekly}`); }, (async (url, options) => {
		calls++;
		assert.equal(url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
		assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
		assert.equal(new Headers(options?.headers).get("x-userid"), "user-1");
		assert.equal(new Headers(options?.headers).get("X-XAI-Token-Auth"), "xai-grok-cli");
		return Response.json(credits);
	}) as typeof fetch, home);
	t.after(() => { polling.dispose(); rmSync(home, { recursive: true, force: true }); });
	for (let i = 0; i < 5 && seen.at(-1) !== "6 Weekly 63% left"; i++) await flush();
	assert.equal(calls, 1);
	assert.equal(seen.at(-1), "6 Weekly 63% left");
	writeFileSync(join(home, "active_sessions.json"), "{");
	polling.refreshContext();
	assert.equal(seen.at(-1), "6 Weekly 63% left");
});
