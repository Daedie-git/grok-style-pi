import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";

const GROK_NIGHT_THEME = join(dirname(fileURLToPath(import.meta.url)), "../themes/grok-night.tmTheme");
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

let batMissing = false;
let batCache: string | undefined;
const highlightCaches = new WeakMap<HighlightAttempt, Map<string, string[]>>();

function remember(cache: Map<string, string[]>, key: string, lines: string[]): string[] {
	if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	cache.set(key, lines);
	return lines;
}

function colored(lines: string[]): string[] | undefined {
	return lines.join("").includes("\x1b[") ? lines : undefined;
}

function grokBatCache(): string | undefined {
	if (batCache) return batCache;
	const dir = join(tmpdir(), "grok-style-pi-bat");
	mkdirSync(join(dir, "themes"), { recursive: true });
	copyFileSync(GROK_NIGHT_THEME, join(dir, "themes", "grok-night.tmTheme"));
	const built = spawnSync("bat", ["cache", "--build"], {
		env: { ...process.env, BAT_CONFIG_DIR: dir, BAT_CACHE_PATH: join(dir, "cache") },
		stdio: "ignore",
		timeout: 15_000,
	});
	if (built.error && (built.error as NodeJS.ErrnoException).code === "ENOENT") {
		batMissing = true;
		return undefined;
	}
	if (built.status !== 0) return undefined;
	batCache = dir;
	return dir;
}

/** Syntect highlighting with Grok Build's Grok Night theme. Undefined when bat is unavailable. */
export function highlightWithGrokNight(text: string, fileName: string | undefined, lang: string | undefined): string[] | undefined {
	if (batMissing || !text) return undefined;
	let dir: string | undefined;
	try { dir = grokBatCache(); } catch { return undefined; }
	if (!dir) return undefined;
	const args = ["--color=always", "--paging=never", "--style=plain", "--theme=grok-night"];
	if (fileName) args.push("--file-name", fileName.split(/[\\/]/).pop() || fileName);
	else if (lang) args.push("--language", lang);
	else return undefined;
	const result = spawnSync("bat", args, {
		input: text.endsWith("\n") ? text : `${text}\n`,
		encoding: "utf8",
		timeout: 5_000,
		env: { ...process.env, BAT_CONFIG_DIR: dir, BAT_CACHE_PATH: join(dir, "cache"), BAT_PAGER: "" },
		stdio: ["pipe", "pipe", "ignore"],
	});
	if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") batMissing = true;
	if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
	return colored(result.stdout.replace(/\n$/, "").split("\n"));
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
	const key = `${filePath ?? ""}\0${lang ?? ""}\0${normalized}`;
	let cache = highlightCaches.get(attempt);
	if (!cache) {
		cache = new Map();
		highlightCaches.set(attempt, cache);
	}
	const cached = cache.get(key);
	if (cached) return cached;
	const lines = attempt(normalized, filePath, lang);
	// Fallbacks must not hide recovery from a temporary primary failure, and
	// Pi's theme-dependent output must be recomputed when the theme changes.
	return lines ? remember(cache, key, lines) : piHighlight(normalized, lang);
}
