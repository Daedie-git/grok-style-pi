import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFileLinkBridge, dispatchFileLink } from "../src/navigation/file-link-bridge.ts";
import { fileLinkDesktopContents } from "../src/navigation/file-link-handler.ts";
import type { OpenTarget } from "../src/navigation/open-in-cursor.ts";

const target = { path: "/repo/my file #1?.ts", line: 42, column: 3, cwd: "/repo" };

test("installed desktop URL handler reaches the owning session", {
	skip: process.env.GROK_FILE_LINK_DESKTOP !== "1", timeout: 7000,
}, async t => {
	let received!: (target: OpenTarget) => void;
	const opened = new Promise<OpenTarget>(resolve => { received = resolve; });
	const bridge = createFileLinkBridge(async value => { received(value); return true; });
	t.after(() => bridge.stop());
	bridge.start(error => assert.fail(error));
	await promisify(execFile)("xdg-open", [bridge.urlFor(target)], { timeout: 5000 });
	assert.deepEqual(await opened, target);
});

test("file-link desktop entry stays unquoted so xdg-open does not fall through to a browser", () => {
	const contents = fileLinkDesktopContents("/usr/bin/node", "/home/aim/git/grok-style-pi/scripts/open-file-link.mjs");
	const exec = /^Exec=(.*)$/m.exec(contents)?.[1];
	assert.equal(exec, "/usr/bin/node /home/aim/git/grok-style-pi/scripts/open-file-link.mjs %u");
	assert.equal(exec?.split(" ")[0], "/usr/bin/node");
	assert.throws(() => fileLinkDesktopContents("/usr/bin/node", "/tmp/has space.mjs"), /spaces/);
});

test("private file links resolve only registered targets in the owning session", async t => {
	const directory = await mkdtemp(join(tmpdir(), "gpl-"));
	const opened: OpenTarget[] = [];
	const bridge = createFileLinkBridge(async value => { opened.push(value); return true; }, directory);
	const other = createFileLinkBridge(async () => { assert.fail("wrong session"); }, directory);
	t.after(async () => { bridge.stop(); other.stop(); await rm(directory, { recursive: true, force: true }); });
	const url = bridge.urlFor(target);
	assert.equal(bridge.urlFor({ ...target }), url);
	assert.doesNotMatch(url, /repo|my file/);
	assert.notEqual(other.urlFor(target), url);
	bridge.start(error => assert.fail(error));
	other.start(error => assert.fail(error));
	await dispatchFileLink(url, directory);
	assert.deepEqual(opened, [target]);
	await assert.rejects(dispatchFileLink(url.replace(/[^/]+$/, "0".repeat(64)), directory), /expired/);
	await assert.rejects(dispatchFileLink("https://example.com", directory), /Invalid/);
	bridge.stop();
	await assert.rejects(dispatchFileLink(url, directory), /expired/);
	assert.deepEqual(opened, [target]);
});

test("desktop helper forwards to the session opener without launching its own editor", async t => {
	const root = await mkdtemp(join(tmpdir(), "gpl-"));
	const directory = join(root, `grok-pi-links-${process.getuid!()}`);
	const opened: OpenTarget[] = [];
	const bridge = createFileLinkBridge(async value => { opened.push(value); return true; }, directory);
	t.after(async () => { bridge.stop(); await rm(root, { recursive: true, force: true }); });
	bridge.start(error => assert.fail(error));
	await promisify(execFile)(process.execPath, [new URL("../scripts/open-file-link.mjs", import.meta.url).pathname, bridge.urlFor(target)], {
		env: { ...process.env, TMPDIR: root }, timeout: 5000,
	});
	assert.deepEqual(opened, [target]);
});

test("insecure socket directories and failed opens do not fall back to another launcher", async t => {
	const directory = await mkdtemp(join(tmpdir(), "gpl-"));
	let calls = 0;
	const bridge = createFileLinkBridge(async () => { calls++; return false; }, directory);
	t.after(async () => { bridge.stop(); await rm(directory, { recursive: true, force: true }); });
	await chmod(directory, 0o777);
	assert.throws(() => bridge.start(error => assert.fail(error)), /private/);
	await chmod(directory, 0o700);
	bridge.start(error => assert.fail(error));
	await assert.rejects(dispatchFileLink(bridge.urlFor(target), directory), /could not/);
	assert.equal(calls, 1);
});
