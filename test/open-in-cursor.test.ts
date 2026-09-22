import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as agent from "@earendil-works/pi-coding-agent";
import {
	absPath,
	cursorArgs,
	cursorLauncher,
	openInCursor,
	createOpenHistory,
	workspaceFor,
} from "../src/navigation/open-in-cursor.ts";
import { wrapWithDiamondRenderer, BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";
import { createGrokStyleExtension } from "../src/extension.ts";

const theme = { fg: (_token: string, text: string) => text };

test("workspaceFor uses the git root containing the file", async () => {
	const root = await mkdtemp(join(tmpdir(), "grok-cursor-"));
	try {
		await mkdir(join(root, ".git"));
		await mkdir(join(root, "src"), { recursive: true });
		const file = join(root, "src", "main.ts");
		await writeFile(file, "export {}\n");
		assert.equal(workspaceFor(file, join(root, "src")), root);
		assert.equal(workspaceFor("src/main.ts", root), root);
		assert.deepEqual(cursorArgs(file, 12, root), ["--classic", "--goto", `${file}:12`, root]);
		assert.equal(cursorLauncher("/home/aim", (path) => path === "/home/aim/.local/bin/cursor"), "/home/aim/.local/bin/cursor");
		assert.equal(cursorLauncher("/tmp", () => false), "cursor");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("openInCursor launches Cursor with the workspace folder and file:line", async () => {
	const launched: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
	await openInCursor({ path: "/repo/src/file.ts", line: 9, cwd: "/repo" }, (command, args, options) => {
		launched.push({ command, args, cwd: options.cwd, env: options.env });
		return {
			once(event, listener) {
				if (event === "spawn") listener();
			},
			unref() {},
		};
	}, "/no-cursor-mount");
	assert.equal(launched.length, 1);
	assert.deepEqual(launched[0].args, ["--classic", "--goto", "/repo/src/file.ts:9", "/repo"]);
	assert.equal(launched[0].cwd, "/repo");
	assert.equal(createOpenHistory().rememberOpen({ path: "other.ts", line: 1, cwd: "/repo" }).path, absPath("other.ts", "/repo"));
});

test("without a mounted editor, a nested file opens at the workspace root with its line and column", async () => {
	const root = await mkdtemp(join(tmpdir(), "grok-cursor-root-"));
	try {
		await mkdir(join(root, ".git"));
		const cwd = join(root, "src", "nested");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "main.ts");
		const launched: { command: string; args: string[]; cwd?: string }[] = [];
		await openInCursor({ path: file, line: 42, column: 3, cwd }, (command, args, options) => {
			launched.push({ command, args, cwd: options.cwd });
			return { once(event, listener) { if (event === "spawn") listener(); }, unref() {} };
		}, join(root, "no-mount"));
		assert.deepEqual(launched, [{
			command: cursorLauncher(), args: ["--classic", "--goto", `${file}:42:3`, root], cwd: root,
		}]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("openInCursor talks to a running Cursor mount instead of remounting the AppImage", { skip: process.platform !== "linux" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "grok-cursor-mount-"));
	try {
		const mount = join(root, ".mount_cursor");
		const electron = join(mount, "usr/share/cursor/cursor");
		const cli = join(mount, "usr/share/cursor/resources/app/out/cli.js");
		await mkdir(join(mount, "usr/share/cursor/resources/app/out"), { recursive: true });
		await writeFile(electron, "");
		await writeFile(cli, "");
		const launched: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
		await openInCursor({ path: "/repo/src/file.ts", line: 4, cwd: "/repo" }, (command, args, options) => {
			launched.push({ command, args, env: options.env });
			return { once(event, listener) { if (event === "spawn") listener(); }, unref() {} };
		}, root);
		assert.equal(launched[0].command, electron);
		assert.deepEqual(launched[0].args, [cli, "--classic", "--goto", "/repo/src/file.ts:4", "/repo"]);
		assert.equal(launched[0].env?.ELECTRON_RUN_AS_NODE, "1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ctrl+click opens the file without toggling an edit diamond", () => {
	const opened: { path: string; line: number; cwd: string }[] = [];
	const tool = wrapWithDiamondRenderer(agent.createEditToolDefinition(process.cwd()), {
		onModifierOpen(target) { opened.push(target); },
	});
	const result = { content: [], details: { diff: "- 1 old\n+ 1 new", firstChangedLine: 42 } };
	let invalidated = 0;
	const context = { cwd: process.cwd(), state: {}, expanded: false, args: { path: "file.ts" }, invalidate: () => { invalidated++; } };
	const header = tool.renderCall({ path: "file.ts" }, theme, context);
	assert.ok(tool.renderResult(result, { expanded: false }, theme, context).render(80).length > 0);
	assert.deepEqual(header.handleMouse?.({ type: "click", button: "left", ctrl: true } as any), { handled: true });
	assert.equal(invalidated, 0);
	assert.ok(tool.renderResult(result, { expanded: false }, theme, context).render(80).length > 0);
	assert.deepEqual(opened, [{ path: "file.ts", line: 42, cwd: process.cwd() }]);
	assert.equal(header.handleMouse?.({ type: "click", button: "left", ctrl: false } as any), undefined);
	assert.deepEqual(header.handleMouse?.({ type: "click", button: "left", ctrl: false, alt: true } as any), { handled: true });
	assert.equal(invalidated, 1);
	assert.deepEqual(tool.renderResult(result, { expanded: false }, theme, context).render(80), []);
});
