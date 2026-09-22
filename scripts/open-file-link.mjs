#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dispatchFileLink } from "../src/navigation/file-link-bridge.ts";

try {
	if (process.argv.length !== 3) throw new Error("Expected one Pi file link.");
	await dispatchFileLink(process.argv[2]);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	spawn("notify-send", ["Pi file link", message], { stdio: "ignore" }).on("error", () => {});
	process.exitCode = 1;
}
