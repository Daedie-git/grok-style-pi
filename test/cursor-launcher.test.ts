import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { cursorLauncher, findMountedCursor, isOwnedAppImageMount, openInCursor, type SpawnLike } from "../src/navigation/open-in-cursor.ts";

async function fixture(t: TestContext, name = ".mount_cursor") {
	const root = await mkdtemp(join(tmpdir(), "cursor-launcher-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const mount = join(root, name);
	const electron = join(mount, "usr/share/cursor/cursor");
	const cli = join(mount, "usr/share/cursor/resources/app/out/cli.js");
	await mkdir(join(mount, "usr/share/cursor/resources/app/out"), { recursive: true });
	await writeFile(electron, "", { mode: 0o755 });
	await writeFile(cli, "", { mode: 0o644 });
	return { root, mount, electron, cli };
}

const linux = { skip: process.platform !== "linux" };

test("root-owned AppImage metadata requires the current user's FUSE mount", () => {
	const info = "263 58 0:76 / /tmp/.mount_cursor ro,nosuid,nodev - fuse.Cursor.AppImage Cursor.AppImage ro,user_id=1000,group_id=1000";
	assert.equal(isOwnedAppImageMount("/tmp/.mount_cursor", info, 1000), true);
	assert.equal(isOwnedAppImageMount("/tmp/.mount_cursor", info, 1001), false);
	assert.equal(isOwnedAppImageMount("/tmp/.mount_other", info, 1000), false);
	assert.equal(isOwnedAppImageMount("/tmp/.mount_cursor", info.replace("fuse.Cursor.AppImage", "ext4"), 1000), false);
	assert.equal(isOwnedAppImageMount("/tmp/with space", info.replace("/tmp/.mount_cursor", "/tmp/with\\040space"), 1000), true);
});

test("mounted Cursor discovery rejects writable ancestors and CLI files", linux, async (t) => {
	const { root, mount, electron, cli } = await fixture(t);
	assert.deepEqual(findMountedCursor(root), { electron, cli });
	for (const path of [mount, join(mount, "usr/share"), cli]) {
		await chmod(path, 0o777);
		assert.equal(findMountedCursor(root), undefined);
		await chmod(path, path === cli ? 0o644 : 0o755);
	}
	assert.deepEqual(findMountedCursor(root), { electron, cli });
});

test("mounted Cursor discovery rejects symlinked mount roots", linux, async (t) => {
	const { root, mount } = await fixture(t, "not-a-mount");
	await symlink(mount, join(root, ".mount_spoof"));
	assert.equal(findMountedCursor(root), undefined);
});

test("a disappearing Cursor mount falls back to the normal launcher", linux, async (t) => {
	const { root, electron } = await fixture(t);
	const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
	const spawn: SpawnLike = (command, args, options) => {
		calls.push({ command, args, env: options.env });
		const child = Object.assign(new EventEmitter(), { unref() {} });
		queueMicrotask(() => command === electron
			? child.emit("error", Object.assign(new Error("Unmounted"), { code: "ENOENT" }))
			: child.emit("spawn"));
		return child;
	};
	await openInCursor({ path: "file.ts", line: 9, cwd: root }, spawn, root);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].command, electron);
	assert.equal(calls[0].env?.ELECTRON_RUN_AS_NODE, "1");
	assert.equal(calls[1].command, cursorLauncher());
	assert.deepEqual(calls[1].args, ["--classic", "--goto", `${root}/file.ts:9`, root]);
	assert.equal(calls[1].env, process.env, "the fallback must not inherit Electron's node-only mode");
});

test("both launcher failures reject without retrying indefinitely", linux, async (t) => {
	const { root } = await fixture(t);
	let attempts = 0;
	await assert.rejects(openInCursor({ path: "file.ts", line: 1, cwd: root }, () => {
		attempts++;
		throw new Error("Cannot spawn");
	}, root), /Cannot spawn/);
	assert.equal(attempts, 2);
});
