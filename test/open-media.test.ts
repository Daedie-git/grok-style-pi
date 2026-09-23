import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { isMediaPath, openMedia } from "../src/navigation/open-media.ts";

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
