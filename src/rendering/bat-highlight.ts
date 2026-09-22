import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const GROK_NIGHT_THEME = join(dirname(fileURLToPath(import.meta.url)), "../../themes/grok-night.tmTheme");

import { defaultStyleColors, type StyleColors } from "./style-palette.ts";

let batMissing = false;
let batVersion: string | undefined;
const batCaches = new Map<string, string>();

export function themeWithComments(source: string, colors: StyleColors): string {
	const marks = { comment: "\u0000comment\u0000", commentDoc: "\u0000comment-doc\u0000", commentDocEmphasized: "\u0000comment-doc-emphasized\u0000" };
	let theme = source;
	for (const key of ["comment", "commentDoc", "commentDocEmphasized"] as const) theme = theme.replaceAll(defaultStyleColors[key], marks[key]);
	for (const key of ["comment", "commentDoc", "commentDocEmphasized"] as const) theme = theme.replaceAll(marks[key], colors[key]);
	return theme;
}

function colored(lines: string[]): string[] | undefined {
	return lines.join("").includes("\x1b[") ? lines : undefined;
}

function grokBatCache(colors: StyleColors): string | undefined {
	const colorKey = JSON.stringify(colors);
	const cached = batCaches.get(colorKey);
	if (cached) return cached;
	if (!batVersion) {
		const version = spawnSync("bat", ["--version"], { encoding: "utf8", timeout: 5000 });
		if (version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT") batMissing = true;
		if (version.error || version.status !== 0) return;
		batVersion = version.stdout;
	}
	const theme = themeWithComments(readFileSync(GROK_NIGHT_THEME, "utf8"), colors);
	const fingerprint = createHash("sha256").update(batVersion + theme).digest("hex");
	const root = join(tmpdir(), "grok-style-pi-bat");
	const dir = join(root, fingerprint);
	const ready = () => existsSync(join(dir, "ready")) && existsSync(join(dir, "cache", "themes.bin")) && existsSync(join(dir, "cache", "syntaxes.bin"));
	if (!ready()) {
		mkdirSync(root, { recursive: true });
		const temporary = mkdtempSync(join(root, "build-"));
		try {
			mkdirSync(join(temporary, "themes"));
			writeFileSync(join(temporary, "themes", "grok-night.tmTheme"), theme);
			const built = spawnSync("bat", ["cache", "--build"], {
				env: { ...process.env, BAT_CONFIG_DIR: temporary, BAT_CACHE_PATH: join(temporary, "cache") },
				stdio: "ignore", timeout: 15_000,
			});
			if (built.error || built.status !== 0) return;
			writeFileSync(join(temporary, "ready"), fingerprint);
			try { renameSync(temporary, dir); }
			catch (error) { if (!ready()) throw error; }
		} finally { rmSync(temporary, { recursive: true, force: true }); }
	}
	batCaches.set(colorKey, dir);
	return dir;
}

/** Syntect highlighting with Grok Build's Grok Night theme. Undefined when bat is unavailable. */
export function highlightWithBat(text: string, fileName: string | undefined, lang: string | undefined, colors: StyleColors): string[] | undefined {
	if (batMissing || !text || (!fileName && !lang)) return undefined;
	let dir: string | undefined;
	try { dir = grokBatCache(colors); } catch { return undefined; }
	if (!dir) return undefined;
	const args = ["--color=always", "--paging=never", "--style=plain", "--theme=grok-night"];
	if (fileName) args.push("--file-name", fileName.split(/[\\/]/).pop() || fileName);
	else if (lang) args.push("--language", lang);
	else return undefined;
	const result = spawnSync("bat", args, {
		input: text.endsWith("\n") ? text : `${text}\n`,
		encoding: "utf8",
		timeout: 5_000,
		env: { ...process.env, BAT_CONFIG_DIR: dir, BAT_CACHE_PATH: join(dir, "cache"), BAT_PAGER: "", COLORTERM: "truecolor" },
		stdio: ["pipe", "pipe", "ignore"],
	});
	if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") batMissing = true;
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
	return colored(result.stdout.replace(/\n$/, "").split("\n"));
}

