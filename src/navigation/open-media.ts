import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { absPath, type OpenTarget } from "./open-in-cursor.ts";

const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".tif", ".tiff",
	".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"]);

export function isMediaPath(path: string): boolean {
	return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

export function defaultOpenCommand(path: string, platform = process.platform): { command: string; args: string[] } {
	if (platform === "win32") {
		// Only Base64 data is interpolated into this fixed script; no file name reaches a shell command line.
		const encodedPath = Buffer.from(path, "utf16le").toString("base64");
		const script = `$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))\n` +
			`$info = New-Object System.Diagnostics.ProcessStartInfo\n` +
			`$info.FileName = $path\n` +
			`$info.UseShellExecute = $true\n` +
			`[void][System.Diagnostics.Process]::Start($info)`;
		return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
	}
	if (platform === "darwin") return { command: "open", args: [path] };
	return { command: "xdg-open", args: [path] };
}

/** Open a rendered image or video reference with the desktop's default application. */
export async function openMedia(target: OpenTarget, launch = spawn, platform = process.platform): Promise<void> {
	const path = absPath(target.path, target.cwd);
	if (!isMediaPath(path) || !(await stat(path)).isFile()) throw new Error("Media file is no longer available.");
	await new Promise<void>((resolve, reject) => {
		const { command, args } = defaultOpenCommand(path, platform);
		const child = launch(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}
