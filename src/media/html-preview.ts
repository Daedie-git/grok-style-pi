import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 10 * 1024 * 1024;

/** Wait for close and terminate the browser's process group before touching the profile. */
function runBrowser(command: string, args: string[], signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		let failure: Error | undefined;
		const grouped = process.platform !== "win32";
		let stderr = "";
		let teardown: Promise<void> | undefined;
		const child = spawn(command, args, { detached: grouped, stdio: ["ignore", "ignore", "pipe"] });
		child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8192); });
		child.once("error", error => { failure ??= error; kill(); });
		function kill() {
			if (!child.pid) return;
			// Chrome has several child processes, some of which keep writing the profile.
			if (grouped) {
				try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
				child.kill("SIGKILL");
			} else if (child.exitCode === null && child.signalCode === null) {
				teardown ??= new Promise<void>(done => {
					const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
					killer.once("error", () => { child.kill("SIGKILL"); done(); });
					killer.once("close", () => { child.kill("SIGKILL"); done(); });
				});
			}
		}
		function stop(error: Error) { failure ??= error; kill(); }
		function abort() {
			const error = new Error("HTML preview cancelled.", { cause: signal?.reason });
			error.name = "AbortError";
			stop(error);
		}
		const timer = setTimeout(() => stop(new Error("HTML preview timed out after 15 seconds.")), 15_000);
		signal?.addEventListener("abort", abort, { once: true });
		child.once("close", (code, exitSignal) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			kill();
			void (teardown ?? Promise.resolve()).then(() => {
				if (failure) reject(failure);
				else if (code !== 0) reject(new Error(`HTML preview browser exited (${exitSignal ?? code}): ${stderr.trim()}`));
				else resolve();
			});
		});
		if (signal?.aborted) abort();
	});
}

/** A short-lived, sandboxed browser captures one viewport and releases its private profile. */
export async function captureHtmlPreview(path: string, signal?: AbortSignal): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "grok-html-"));
	let failed = false;
	try {
		const screenshot = join(dir, "preview.png");
		const browsers = process.env.GROK_HTML_BROWSER ? [process.env.GROK_HTML_BROWSER] : ["chromium", "chromium-browser", "google-chrome"];
		let found = false;
		for (const browser of browsers) {
			try {
				await runBrowser(browser, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
					`--user-data-dir=${join(dir, "profile")}`, "--window-size=1200,800", "--hide-scrollbars",
					"--virtual-time-budget=1000", `--screenshot=${screenshot}`, pathToFileURL(path).href],
				signal);
				found = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (!found) throw new Error("show_html requires Chromium or Chrome. Set GROK_HTML_BROWSER to its executable path.");
		const data = await readFile(screenshot);
		if (data.length > MAX_BYTES) throw new Error("HTML preview exceeds 10 MB.");
		return data.toString("base64");
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		try { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
		catch (error) { if (!failed) throw error; }
	}
}
