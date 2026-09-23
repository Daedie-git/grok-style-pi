import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { absPath, type OpenTarget } from "./open-in-cursor.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".tif", ".tiff"]);

export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Open a rendered image reference with the desktop's default application, not Cursor. */
export async function openImage(target: OpenTarget, launch = spawn): Promise<void> {
	const path = absPath(target.path, target.cwd);
	if (!isImagePath(path) || !(await stat(path)).isFile()) throw new Error("Image file is no longer available.");
	await new Promise<void>((resolve, reject) => {
		const child = launch("xdg-open", [path], { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}
