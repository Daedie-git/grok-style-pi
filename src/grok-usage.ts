import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GrokCredits = { usedPercent: number; periodType?: string; periodEnd?: number };

const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

/** Credits config from `GET /v1/billing?format=credits` on the Grok CLI proxy. */
export function parseGrokCredits(value: unknown): GrokCredits | undefined {
	const config = object(object(value)?.config) ?? object(value);
	const usedPercent = config?.creditUsagePercent;
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
	const period = object(config?.currentPeriod);
	const periodType = typeof period?.type === "string" ? period.type : undefined;
	const periodEnd = typeof period?.end === "string" ? Date.parse(period.end) : undefined;
	return {
		usedPercent,
		...(periodType ? { periodType } : {}),
		...(periodEnd !== undefined && Number.isFinite(periodEnd) ? { periodEnd } : {}),
	};
}

export function formatGrokWeekly(credits: GrokCredits | undefined, now = Date.now()): string {
	const weekly = !credits?.periodType || credits.periodType.includes("WEEKLY");
	if (!credits || !weekly || (credits.periodEnd !== undefined && credits.periodEnd <= now)) return "Grok Weekly ?% left";
	const remaining = Math.round(Math.max(0, Math.min(100, 100 - credits.usedPercent)));
	return `Grok Weekly ${remaining}% left`;
}

export async function fetchGrokCredits(token: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<GrokCredits> {
	let userId: unknown;
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		userId = object(payload)?.sub;
	} catch { /* Not an xAI OAuth token. */ }
	if (typeof userId !== "string" || !userId) throw new Error("login required");
	const response = await request("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-userid": userId,
		},
		signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
		redirect: "error",
	});
	if (!response.ok) throw new Error(response.status === 401 ? "login required" : "unavailable");
	const credits = parseGrokCredits(await response.json());
	if (!credits) throw new Error("unavailable");
	return credits;
}

type ActiveSession = { session_id: string; cwd: string; opened_at?: string };

const sessionId = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);
const normalizeCwd = (cwd: string) => cwd.replace(/[\\/]+$/, "") || cwd;

function readJson(path: string): unknown | null | undefined {
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
}

function percentIn(value: unknown): number | null {
	const usage = object(value)?.contextWindowUsage;
	if (typeof usage !== "number" || !Number.isFinite(usage) || usage < 0) return null;
	return usage;
}

function signalsPercent(path: string): number | null | undefined {
	const parsed = readJson(path);
	if (parsed === undefined) return undefined;
	if (parsed === null) return null;
	return percentIn(parsed);
}

/** Context-window percent from the Grok session for this working directory. `undefined` means the read failed and the previous value should stay. */
export function readGrokContextPercent(cwd: string, grokHome = join(homedir(), ".grok")): number | null | undefined {
	const wanted = normalizeCwd(cwd);
	const active = readJson(join(grokHome, "active_sessions.json"));
	if (Array.isArray(active)) {
		const match = active
			.map((entry) => object(entry))
			.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry.session_id === "string" && typeof entry.cwd === "string" && sessionId(entry.session_id) && normalizeCwd(entry.cwd) === wanted)
			.sort((a, b) => String(b.opened_at ?? "").localeCompare(String(a.opened_at ?? "")))[0] as ActiveSession | undefined;
		if (match) {
			const percent = signalsPercent(join(grokHome, "sessions", encodeURIComponent(match.cwd), match.session_id, "signals.json"));
			if (typeof percent === "number" || percent === undefined) return percent;
		}
	} else if (active === undefined) return undefined;
	const dir = join(grokHome, "sessions", encodeURIComponent(wanted));
	let names: string[];
	try { names = readdirSync(dir); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
	const newest = names
		.filter(sessionId)
		.map((name) => {
			const path = join(dir, name, "signals.json");
			try { return { path, mtime: statSync(path).mtimeMs }; }
			catch { return undefined; }
		})
		.filter((entry): entry is { path: string; mtime: number } => !!entry)
		.sort((a, b) => b.mtime - a.mtime)[0];
	return newest ? signalsPercent(newest.path) : null;
}

export type GrokFooterStats = { contextPercent: number | null; weekly: string };

/** Poll the local Grok session and the credits endpoint off the render path. */
export function startGrokFooterPolling(
	cwd: () => string,
	getToken: () => Promise<string | undefined> | string | undefined,
	update: (stats: GrokFooterStats) => void,
	request: typeof fetch = fetch,
	grokHome?: string,
) {
	const controller = new AbortController();
	let pending = false;
	let contextPercent: number | null = null;
	let weekly = "Grok Weekly ?% left";
	function publish() { update({ contextPercent, weekly }); }
	function refreshContext() {
		const next = readGrokContextPercent(cwd(), grokHome);
		if (next !== undefined) contextPercent = next;
		publish();
	}
	async function refreshCredits() {
		if (pending || controller.signal.aborted) return;
		pending = true;
		try {
			const token = await getToken();
			if (controller.signal.aborted) return;
			if (!token) throw new Error("login required");
			const credits = await fetchGrokCredits(token, controller.signal, request);
			if (!controller.signal.aborted) weekly = formatGrokWeekly(credits);
		} catch (error) {
			if (!controller.signal.aborted) weekly = `Grok Weekly ${error instanceof Error && error.message === "login required" ? "login required" : "unavailable"}`;
		} finally {
			pending = false;
			if (!controller.signal.aborted) publish();
		}
	}
	const contextTimer = setInterval(refreshContext, 5000);
	const creditsTimer = setInterval(() => { void refreshCredits(); }, 60000);
	contextTimer.unref?.();
	creditsTimer.unref?.();
	refreshContext();
	void refreshCredits();
	return { refreshContext, refreshCredits, dispose() { clearInterval(contextTimer); clearInterval(creditsTimer); controller.abort(); } };
}
