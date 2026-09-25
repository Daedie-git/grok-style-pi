import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { defaultOpenCommand, isMediaPath, openMedia } from "../src/navigation/open-media.ts";

test("image and video links open with the desktop's default application", async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-image-test-"));
	try {
		writeFileSync(join(dir, "screen shot.PNG"), "image");
		const calls: unknown[] = [];
		const launch = ((command: string, args: string[], options: unknown) => {
			calls.push({ command, args, options });
			const child = new EventEmitter() as EventEmitter & { unref: () => void };
			child.unref = () => { calls.push("unref"); };
			queueMicrotask(() => child.emit("spawn"));
			return child;
		}) as typeof import("node:child_process").spawn;
		assert.equal(isMediaPath("/repo/screen shot.PNG"), true);
		assert.equal(isMediaPath("/repo/clip.mp4"), true);
		assert.equal(isMediaPath("/repo/app.ts"), false);
		await openMedia({ path: "screen shot.PNG", cwd: dir, line: 1 }, launch);
		assert.deepEqual(calls, [
			{ command: "xdg-open", args: [join(dir, "screen shot.PNG")], options: { detached: true, stdio: "ignore" } },
			"unref",
		]);
		writeFileSync(join(dir, "clip.mp4"), "video");
		await openMedia({ path: "clip.mp4", cwd: dir, line: 1 }, launch);
		assert.deepEqual(calls.slice(2), [
			{ command: "xdg-open", args: [join(dir, "clip.mp4")], options: { detached: true, stdio: "ignore" } },
			"unref",
		]);
		await assert.rejects(openMedia({ path: "missing.png", cwd: dir, line: 1 }, launch));
		assert.equal(calls.length, 4);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows media launch encodes metacharacters as data for ShellExecute", async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-win-media-"));
	try {
		const name = `a & % "quote" 'single' shot.png`;
		writeFileSync(join(dir, name), "image");
		const calls: { command: string; args: string[] }[] = [];
		const launch = ((command: string, args: string[]) => {
			calls.push({ command, args });
			const child = Object.assign(new EventEmitter(), { unref() {} });
			queueMicrotask(() => child.emit("spawn"));
			return child;
		}) as typeof import("node:child_process").spawn;
		await openMedia({ path: name, cwd: dir, line: 1 }, launch, "win32");
		assert.equal(calls[0].command, "powershell.exe");
		assert.deepEqual(calls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
		assert.ok(calls[0].args.every(arg => !arg.includes(name)));
		const script = Buffer.from(calls[0].args[3], "base64").toString("utf16le");
		assert.match(script, /UseShellExecute = \$true/);
		assert.match(script, /\[System\.Diagnostics\.Process\]::Start\(\$info\)/);
		const encodedPath = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)?.[1];
		assert.ok(encodedPath);
		assert.equal(Buffer.from(encodedPath, "base64").toString("utf16le"), join(dir, name));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("macOS and Linux media openers pass paths as single arguments", () => {
	const path = `/tmp/a & % "quoted" image.png`;
	assert.deepEqual(defaultOpenCommand(path, "linux"), { command: "xdg-open", args: [path] });
	assert.deepEqual(defaultOpenCommand(path, "darwin"), { command: "open", args: [path] });
});
