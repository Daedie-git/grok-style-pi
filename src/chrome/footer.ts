import { homedir } from "node:os";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function slashPath(path: string): string {
	return path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
}

function comparablePath(path: string): string {
	const normalized = slashPath(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function displaySeparator(...paths: string[]): string {
	const path = paths.find((value) => value.includes("\\") || value.includes("/")) ?? "";
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** A snapshot of everything the footer shows; collected by the session, never fetched while rendering. */
export type FooterInput = {
	cwd: string;
	model: string;
	percent: number | null | undefined;
	thinkingLevel?: string;
	branch?: string | null;
	provider?: string | null;
	subscription?: string;
	account?: string;
	grokPercent?: number | null;
	grokWeekly?: string;
};

export type FooterContext = {
	cwd: string;
	model?: { name?: string; id?: string; provider?: string } | null;
	getContextUsage?: () => { percent: number | null } | undefined;
	thinkingLevel?: string;
	branch?: string | null;
};

export type FooterPaint = (token: ThemeColor, text: string) => string;

type FooterItem = { text: string; tone?: ThemeColor };

const SEPARATOR = " │ ";
const SEPARATOR_WIDTH = visibleWidth(SEPARATOR);

/** Below this, a clipped account says nothing useful, so it is dropped instead. */
const ACCOUNT_MIN_WIDTH = 12;

export function cwdBasename(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || cwd || ".";
}

export function cwdDisplayPath(cwd: string, home = homedir()): string {
	if (!cwd) return ".";
	const cwdSlash = slashPath(cwd);
	const homeSlash = slashPath(home);
	const comparableCwd = comparablePath(cwd);
	const comparableHome = comparablePath(home);
	if (comparableCwd === comparableHome) return "~";
	if (comparableCwd.startsWith(comparableHome + "/")) {
		const separator = displaySeparator(home, cwd);
		const suffix = cwdSlash.slice(homeSlash.length).replace(/^\/+/, "").replaceAll("/", separator);
		return `~${separator}${suffix}`;
	}
	return cwd;
}

export function formatPercent(percent: number | null | undefined): string {
	if (percent == null || Number.isNaN(Number(percent))) return "?";
	return String(Math.round(Number(percent)));
}

export type UsageSource = "codex" | "grok" | "session";

/** Context and allowance belong to the selected model, not every signed-in provider. */
export function usageSource(provider?: string | null): UsageSource {
	if (provider === "openai-codex") return "codex";
	if (provider === "xai") return "grok";
	return "session";
}

function usageItems(input: FooterInput): FooterItem[] {
	const source = usageSource(input.provider);
	const context = `Context ${formatPercent(source === "grok" ? input.grokPercent : input.percent)}% used`;
	if (source === "grok") return [{ text: context }, { text: input.grokWeekly ?? "Weekly ?% left" }];
	if (source === "codex" && input.subscription) return [{ text: context }, { text: input.subscription }];
	return [{ text: context }];
}

/** Clips plain text with a bare ellipsis; Pi's truncation adds resets that would end an item's color early. */
function clip(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	return width > 0 ? `${sliceByColumn(text, 0, width - 1, true)}…` : "";
}

function itemsWidth(items: FooterItem[]): number {
	return items.reduce((sum, item, index) => sum + visibleWidth(item.text) + (index ? SEPARATOR_WIDTH : 0), 0);
}

/** Keeps items left to right within `width`, clipping the first one that overflows and dropping the rest. */
function fitItems(items: FooterItem[], width: number): FooterItem[] {
	const fitted: FooterItem[] = [];
	let remaining = width;
	for (const item of items) {
		const room = remaining - (fitted.length ? SEPARATOR_WIDTH : 0);
		if (room <= 0) break;
		const text = clip(item.text, room);
		fitted.push({ ...item, text });
		if (text !== item.text) break;
		remaining = room - visibleWidth(text);
	}
	return fitted;
}

export function modelDisplayName(model: FooterContext["model"]): string {
	if (!model) return "unknown";
	return (model.name || model.id || "unknown").trim() || "unknown";
}

/**
 * Lays out the footer row `identity │ usage │ account`. Usage keeps its full width,
 * identity shrinks into what remains, and the account only takes space identity leaves over.
 * Text is clipped before painting, so styling never affects layout.
 */
export function renderFooter(input: FooterInput, options: { width: number; paint?: FooterPaint }): string[] {
	const { width, paint = (_token, text) => text } = options;
	if (width <= 0) return [""];
	const identity: FooterItem[] = [
		{ text: `${cwdDisplayPath(input.cwd)}${input.branch ? ` (${input.branch})` : ""}` },
		{ text: `${input.model.trim() || "unknown"} ${input.thinkingLevel ?? "?"}` },
	];
	const usage = usageItems(input);
	const available = width - itemsWidth(usage) - SEPARATOR_WIDTH;
	let items: FooterItem[];
	if (available <= 0) {
		items = fitItems(usage, width);
	} else {
		const accountRoom = available - itemsWidth(identity) - SEPARATOR_WIDTH;
		const account = input.account && accountRoom >= ACCOUNT_MIN_WIDTH
			? [{ text: clip(`Account ${input.account}`, accountRoom) }]
			: [];
		items = [...fitItems(identity, available), ...usage, ...account];
	}
	const row = items.map((item) => paint(item.tone ?? "muted", item.text)).join(paint("muted", SEPARATOR));
	// Layout measured plain text; this only guards against a theme that paints visible text.
	return [truncateToWidth(row, width, "")];
}
