import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_PATH = /^[A-Za-z0-9_/@.+:-]+$/;

export function fileLinkDesktopPath(dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")): string {
	return join(resolve(dataHome), "applications/grok-style-pi-file.desktop");
}

/** xdg-open keeps quote marks on Exec tokens and then falls through to the browser. */
export function fileLinkDesktopContents(node = process.execPath, script = fileURLToPath(new URL("../scripts/open-file-link.mjs", import.meta.url))): string {
	for (const argument of [node, script]) {
		if (!SAFE_PATH.test(argument)) throw new Error("File-link setup requires Node and extension paths without spaces or special characters.");
	}
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Pi File Link",
		"NoDisplay=true",
		"Terminal=false",
		`Exec=${node} ${script} %u`,
		"MimeType=x-scheme-handler/grok-pi-file;",
		"",
	].join("\n");
}

export function installFileLinkHandler(desktop = fileLinkDesktopPath()): void {
	if (process.platform !== "linux") return;
	const contents = fileLinkDesktopContents();
	mkdirSync(dirname(desktop), { recursive: true });
	let current = "";
	try { current = readFileSync(desktop, "utf8"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (current !== contents) writeFileSync(desktop, contents);
	execFileSync("xdg-mime", ["default", "grok-style-pi-file.desktop", "x-scheme-handler/grok-pi-file"], { stdio: "ignore" });
}
