import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { styleColors } from "../chrome/style-colors.ts";
import { highlightWithBat } from "./bat-highlight.ts";
export { themeWithComments } from "./bat-highlight.ts";

const CACHE_LIMIT = 64;

/** Extensions Pi maps elsewhere, or not at all, that should still highlight. */
const EXTENSIONS: Record<string, string> = {
	h: "cpp",
	hh: "cpp",
	hpp: "cpp",
	hxx: "cpp",
	"h++": "cpp",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	"c++": "cpp",
	inl: "cpp",
	ipp: "cpp",
	tpp: "cpp",
	cuh: "cpp",
	cu: "cpp",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	rs: "rust",
	py: "python",
	pyw: "python",
	pyi: "python",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	ps1: "powershell",
	psm1: "powershell",
	psd1: "powershell",
};

export type HighlightAttempt = (text: string, fileName: string | undefined, lang: string | undefined) => string[] | undefined;

export function languageForPath(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
	if (ext && EXTENSIONS[ext]) return EXTENSIONS[ext];
	return getLanguageFromPath(filePath);
}

const highlightCaches = new WeakMap<HighlightAttempt, Map<string, string[]>>();
const cacheBytes = new WeakMap<Map<string, string[]>, number>();

export function highlightWithGrokNight(text: string, fileName: string | undefined, lang: string | undefined): string[] | undefined {
	return highlightWithBat(text, fileName, lang, styleColors());
}

function remember(cache: Map<string, string[]>, key: string, lines: string[]): string[] {
	const size = (key.length + lines.reduce((sum, line) => sum + line.length, 0)) * 2;
	const limit = 16 * 1024 * 1024;
	if (size > limit) return lines;
	let bytes = cacheBytes.get(cache) ?? 0;
	while (cache.size && (cache.size >= CACHE_LIMIT || bytes + size > limit)) {
		const first = cache.keys().next().value!;
		bytes -= (first.length + cache.get(first)!.reduce((sum, line) => sum + line.length, 0)) * 2;
		cache.delete(first);
	}
	cache.set(key, lines); cacheBytes.set(cache, bytes + size);
	return lines;
}

function colored(lines: string[]): string[] | undefined {
	return lines.join("").includes("\x1b[") ? lines : undefined;
}

function piHighlight(text: string, lang: string | undefined): string[] | undefined {
	if (!lang) return undefined;
	try { return colored(highlightCode(text, lang)); } catch { return undefined; }
}

/** Theme-colored lines. Tries bat, then Pi's public highlighter, then leaves the caller with plain text. */
export function highlightLines(
	text: string,
	lang: string | undefined,
	filePath?: string,
	attempt: HighlightAttempt = highlightWithGrokNight,
): string[] | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\n$/, "");
	const key = `${JSON.stringify(styleColors())}\0${filePath ?? ""}\0${lang ?? ""}\0${normalized}`;
	let cache = highlightCaches.get(attempt);
	if (!cache) {
		cache = new Map();
		highlightCaches.set(attempt, cache);
	}
	const cached = cache.get(key);
	if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
	const lines = attempt(normalized, filePath, lang);
	// Fallbacks must not hide recovery from a temporary primary failure, and
	// Pi's theme-dependent output must be recomputed when the theme changes.
	return lines ? remember(cache, key, lines) : piHighlight(normalized, lang);
}
