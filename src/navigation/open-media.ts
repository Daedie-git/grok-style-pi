import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { absPath, type OpenTarget } from "./open-in-cursor.ts";

const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".tif", ".tiff",
	".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"]);

export function isMediaPath(path: string): boolean {
	return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

function defaultOpenCommand(path: string): { command: string; args: string[] } {
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", path] };
	if (process.platform === "darwin") return { command: "open", args: [path] };
	return { command: "xdg-open", args: [path] };
}

/** Open a rendered image or video reference with the desktop's default application. */
export async function openMedia(target: OpenTarget, launch = spawn): Promise<void> {
	const path = absPath(target.path, target.cwd);
	if (!isMediaPath(path) || !(await stat(path)).isFile()) throw new Error("Media file is no longer available.");
	await new Promise<void>((resolve, reject) => {
		const { command, args } = defaultOpenCommand(path);
		const child = launch(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}
