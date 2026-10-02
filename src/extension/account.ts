const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

/** Display claims only; this does not validate a token or authorize requests. */
export function accountFromToken(token: string | undefined, provider: string): string | undefined {
	if (!token || !["openai-codex", "xai"].includes(provider)) return undefined;
	try {
		const payload = object(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
		const profile = object(payload?.["https://api.openai.com/profile"]);
		const auth = object(payload?.["https://api.openai.com/auth"]);
		const claims = [profile?.email, payload?.email, profile?.name, payload?.name,
			provider === "openai-codex" ? auth?.chatgpt_account_id : payload?.sub];
		for (const claim of claims) {
			if (typeof claim !== "string") continue;
			// Claims are untrusted terminal text: exclude controls, escapes, and row separators.
			const label = claim.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029│]/g, "").trim();
			if (label) return label.slice(0, 200);
		}
	} catch { /* Opaque API keys and malformed tokens have no display identity. */ }
	return undefined;
}

/** Refresh login identity off the render path, without any account endpoint requests. */
export function startAccountPolling(
	provider: string,
	getToken: () => Promise<string | undefined>,
	update: (account: string | undefined) => void,
) {
	let disposed = false;
	let pending = false;
	async function refresh() {
		if (disposed || pending) return;
		pending = true;
		try {
			const token = await getToken();
			if (!disposed) update(accountFromToken(token, provider));
		} catch {
			if (!disposed) update(undefined);
		} finally { pending = false; }
	}
	const timer = setInterval(() => { void refresh(); }, 60000);
	timer.unref?.();
	void refresh();
	return { refresh, dispose() { disposed = true; clearInterval(timer); } };
}
