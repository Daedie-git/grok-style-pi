import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { isImagePath, openImage } from "../src/navigation/open-image.ts";

test("image links open the existing file with the desktop's default application", async () => {
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
		assert.equal(isImagePath("/repo/screen shot.PNG"), true);
		assert.equal(isImagePath("/repo/app.ts"), false);
		await openImage({ path: "screen shot.PNG", cwd: dir, line: 1 }, launch);
		assert.deepEqual(calls, [
			{ command: "xdg-open", args: [join(dir, "screen shot.PNG")], options: { detached: true, stdio: "ignore" } },
			"unref",
		]);
		await assert.rejects(openImage({ path: "missing.png", cwd: dir, line: 1 }, launch));
		assert.equal(calls.length, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
