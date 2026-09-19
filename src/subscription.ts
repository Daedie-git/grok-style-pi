export type QuotaWindow = { label: string; usedPercent: number; resetsAt?: number };

/** Codex's x-codex-{primary,secondary}-* response header families. */
export function parseCodexQuota(headers: Record<string, string>): QuotaWindow[] {
	const values = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const number = (name: string) => {
		const raw = values.get(name)?.trim();
		if (!raw) return undefined;
		const value = Number(raw);
		return Number.isFinite(value) ? value : undefined;
	};
	const windows: QuotaWindow[] = [];
	for (const key of ["primary", "secondary"]) {
		const prefix = `x-codex-${key}`;
		const usedPercent = number(`${prefix}-used-percent`);
		const minutes = number(`${prefix}-window-minutes`);
		const resetsAt = number(`${prefix}-reset-at`);
		if (usedPercent === undefined || usedPercent < 0) continue;
		if (usedPercent === 0 && !minutes && !resetsAt) continue;
		const label = minutes && minutes > 0
			? minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
			: key;
		windows.push({ label, usedPercent, resetsAt });
	}
	return windows;
}

export function formatCodexQuota(windows: QuotaWindow[], now = Date.now()): string {
	const weekly = windows.find((window) => window.label === "7d");
	if (!weekly || (weekly.resetsAt !== undefined && weekly.resetsAt * 1000 <= now)) return "Codex weekly ? left";
	const remaining = Math.round(Math.max(0, Math.min(100, 100 - weekly.usedPercent)));
	return `Codex weekly ${remaining}% left`;
}

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

/** Read the usage response used by Codex's own account-limit client. */
export function parseCodexUsage(value: unknown): QuotaWindow[] {
	const limits = object(object(value)?.rate_limit);
	const windows: QuotaWindow[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const window = object(limits?.[key]);
		if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent) || window.used_percent < 0) continue;
		const seconds = window.limit_window_seconds;
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) continue;
		const label = seconds % 86400 === 0 ? `${seconds / 86400}d` : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${seconds / 60}m`;
		windows.push({ label, usedPercent: window.used_percent,
			...(typeof window.reset_at === "number" && Number.isFinite(window.reset_at) ? { resetsAt: window.reset_at } : {}),
		});
	}
	return windows;
}

export async function fetchCodexUsage(token: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<QuotaWindow[]> {
	let accountId: unknown;
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		accountId = object(object(payload)?.["https://api.openai.com/auth"])?.chatgpt_account_id;
	} catch { /* Not a ChatGPT OAuth token. */ }
	if (typeof accountId !== "string" || !accountId) throw new Error("login required");
	const response = await request("https://chatgpt.com/backend-api/wham/usage", {
		headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json" },
		signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: "error",
	});
	if (!response.ok) throw new Error(response.status === 401 ? "login required" : "unavailable");
	return parseCodexUsage(await response.json());
}

/** Poll off the input/render path, with one request at a time and disposal guards. */
export function startCodexUsagePolling(
	getToken: () => Promise<string | undefined>,
	update: (windows: QuotaWindow[] | undefined, error?: "login required" | "unavailable") => void,
	request: typeof fetch = fetch,
) {
	const controller = new AbortController();
	let pending = false;
	async function refresh() {
		if (pending || controller.signal.aborted) return;
		pending = true;
		try {
			const token = await getToken();
			if (controller.signal.aborted) return;
			if (!token) throw new Error("login required");
			const windows = await fetchCodexUsage(token, controller.signal, request);
			if (!controller.signal.aborted) update(windows, windows.some((window) => window.label === "7d") ? undefined : "unavailable");
		} catch (error) {
			if (!controller.signal.aborted) update(undefined, error instanceof Error && error.message === "login required" ? "login required" : "unavailable");
		} finally { pending = false; }
	}
	const timer = setInterval(() => { void refresh(); }, 60000); timer.unref?.();
	void refresh();
	return { refresh, dispose() { clearInterval(timer); controller.abort(); } };
}
