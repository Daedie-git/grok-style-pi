import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { captureHtmlPreview } from "../src/media/html-preview.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("real Chromium cancellation preserves AbortError and removes its profile", { skip: process.env.GROK_HTML_INTEGRATION !== "1" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "grok-chromium-cancel-"));
	try {
		const path = join(dir, "page.html");
		await writeFile(path, "<script>while(true){}</script>");
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = new Set(await readdir(tmpdir()));
			const controller = new AbortController();
			const capture = captureHtmlPreview(path, controller.signal);
			void capture.catch(() => {});
			await delay(500);
			const profiles = (await readdir(tmpdir())).filter(name => name.startsWith("grok-html-") && !before.has(name));
			controller.abort();
			await assert.rejects(capture, { name: "AbortError" });
			assert.equal(profiles.length, 1, "capture created one private profile");
			await assert.rejects(access(join(tmpdir(), profiles[0])), { code: "ENOENT" });
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// A real executable reproduces a browser subprocess keeping pipes and profile writes alive.
test("cancelling an active HTML capture stops browser descendants before removing its profile", { skip: process.platform === "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "grok-html-cancel-test-"));
	const browser = join(dir, "browser.mjs");
	const record = join(dir, "started.json");
	const previous = process.env.GROK_HTML_BROWSER;
	const controller = new AbortController();
	let started: { profile: string; pid: number; descendant: number } | undefined;
	let capture: Promise<string> | undefined;
	try {
		await writeFile(browser, `#!${process.execPath}\n` +
			`import { spawn } from "node:child_process";\n` +
			`import { mkdirSync, writeFileSync } from "node:fs";\n` +
			`const profile = process.argv.find(arg => arg.startsWith("--user-data-dir=")).split("=").slice(1).join("=");\n` +
			`mkdirSync(profile, {recursive:true});\n` +
			`const worker = spawn(process.execPath, ["-e", "const fs=require('node:fs'); const profile=process.argv[1]; setInterval(()=>{fs.mkdirSync(profile,{recursive:true}); fs.writeFileSync(profile+'/heartbeat','alive');},10);", profile], {stdio:"inherit"});\n` +
			`writeFileSync(${JSON.stringify(record)}, JSON.stringify({profile,pid:process.pid,descendant:worker.pid}));\n` +
			`setInterval(()=>{},1000);\n`);
		await chmod(browser, 0o700);
		process.env.GROK_HTML_BROWSER = browser;
		capture = captureHtmlPreview(join(dir, "page.html"), controller.signal);
		// Attach a rejection handler before cancellation, but retain the original promise for assertions.
		void capture.catch(() => {});
		for (let attempt = 0; attempt < 200 && !started; attempt++) {
			try { started = JSON.parse(await readFile(record, "utf8")); } catch { await delay(10); }
		}
		assert.ok(started, "browser must start before cancellation");
		for (let attempt = 0; attempt < 200; attempt++) {
			try { await access(join(started.profile, "heartbeat")); break; } catch { await delay(10); }
		}
		await access(join(started.profile, "heartbeat"));
		controller.abort();
		await assert.rejects(capture, { name: "AbortError" });
		await delay(150);
		await assert.rejects(access(dirname(started.profile)), { code: "ENOENT" }, "profile must remain removed after descendants stop");
	} finally {
		controller.abort();
		if (capture) await capture.catch(() => {});
		if (previous === undefined) delete process.env.GROK_HTML_BROWSER;
		else process.env.GROK_HTML_BROWSER = previous;
		if (started) {
			for (const pid of [started.pid, started.descendant]) { try { process.kill(pid, "SIGKILL"); } catch {} }
			await delay(30);
			await rm(dirname(started.profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
		await rm(dir, { recursive: true, force: true });
	}
});
