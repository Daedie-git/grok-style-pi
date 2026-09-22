import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createCursorWorkspaceOpener } from "../src/navigation/cursor-workspace.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "cursor-workspace-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".git"));
	const notifications: { message: string; kind?: string }[] = [];
	return {
		root,
		target: { path: "main.cpp", line: 7, cwd: root },
		ctx: { cwd: root, isProjectTrusted: () => true, ui: { notify(message: string, kind?: string) { notifications.push({ message, kind }); } } },
		notifications,
	};
}

test("concurrent first opens await one refresh; later opens are immediate", async t => {
	const { root, target, ctx, notifications } = await fixture(t);
	const started = deferred<void>(), finish = deferred<void>();
	const order: string[] = [];
	let refreshes = 0;
	const opener = createCursorWorkspaceOpener({
		open: async () => { order.push("open"); },
		refresh: async (workspace, options) => {
			assert.equal(workspace, root);
			refreshes++;
			options?.onProgress?.("Refreshing compilation database");
			started.resolve();
			await finish.promise;
			order.push("refresh");
			return { status: "refreshed", message: "Refreshed compile_commands.json" };
		},
	});
	const first = opener.open(target, ctx);
	await started.promise;
	const second = opener.open(target, ctx);
	assert.deepEqual(order, []);
	finish.resolve();
	assert.deepEqual(await Promise.all([first, second]), [true, true]);
	assert.equal(refreshes, 1);
	assert.deepEqual(order, ["refresh", "open", "open"]);
	await opener.open(target, ctx);
	assert.equal(refreshes, 1);
	assert.equal(notifications.length, 2);
});

test("refresh failure warns once without preventing Cursor from opening", async t => {
	const { target, ctx, notifications } = await fixture(t);
	let opened = 0, refreshed = 0;
	const opener = createCursorWorkspaceOpener({
		open: async () => { opened++; },
		refresh: async () => { refreshed++; throw new Error("CMake configure failed\x1b[2J"); },
	});
	await opener.open(target, ctx);
	await opener.open(target, ctx);
	assert.equal(opened, 2);
	assert.equal(refreshed, 1);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /configure failed/);
	assert.doesNotMatch(notifications[0].message, /\x1b/);
	assert.equal(notifications[0].kind, "warning");
});

test("untrusted and foreign workspaces open without executing build configuration", async t => {
	const { target, ctx, notifications } = await fixture(t);
	const other = await fixture(t);
	let opens = 0, refreshes = 0;
	const opener = createCursorWorkspaceOpener({
		open: async () => { opens++; },
		refresh: async () => { refreshes++; throw new Error("must not execute"); },
	});
	await opener.open(target, { ...ctx, isProjectTrusted: () => false });
	await opener.open(other.target, ctx);
	assert.equal(opens, 2);
	assert.equal(refreshes, 0);
	assert.equal(notifications.length, 2);
	assert.ok(notifications.every(n => n.kind === "warning" && n.message.includes("trusted")));
});

test("session replacement aborts pending refresh and never opens the old target", async t => {
	const { target, ctx, notifications } = await fixture(t);
	const started = deferred<void>(), finish = deferred<void>();
	let oldSignal: AbortSignal | undefined;
	let opened = 0, refreshes = 0;
	const opener = createCursorWorkspaceOpener({
		open: async () => { opened++; },
		refresh: async (_workspace, options) => {
			refreshes++;
			if (refreshes === 1) {
				oldSignal = options?.signal;
				started.resolve();
				await finish.promise;
				options?.onProgress?.("stale progress");
			}
			return { status: "refreshed", message: "done" };
		},
	});
	const previous = opener.open(target, ctx);
	await started.promise;
	opener.reset();
	assert.equal(oldSignal?.aborted, true);
	await opener.open(target, ctx);
	finish.resolve();
	assert.equal(await previous, false);
	assert.equal(opened, 1);
	assert.equal(refreshes, 2);
	assert.deepEqual(notifications.map(n => n.message), ["done"]);
});

test("ordinary non-native workspaces are silent and launcher errors still propagate", async t => {
	const { target, ctx, notifications } = await fixture(t);
	const opener = createCursorWorkspaceOpener({
		open: async () => { throw new Error("Cursor not found"); },
		refresh: async () => ({ status: "skipped" }),
	});
	await assert.rejects(opener.open(target, ctx), /Cursor not found/);
	assert.deepEqual(notifications, []);
});
