// Explicit upgrade administration; elapsed quiet and new-worker heartbeats cannot prove old readers exited.
import { createJiti } from "jiti";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const usage = "Usage: node lifecycle-upgrade.mjs [--root PATH] (--status | --confirm-old-workers-stopped)";
const args = process.argv.slice(2);
let root;
let action;
for (let index = 0; index < args.length; index++) {
	const argument = args[index];
	if (argument === "--root" && args[index + 1] && !root) root = args[++index];
	else if ((argument === "--status" || argument === "--confirm-old-workers-stopped") && !action) action = argument;
	else {
		console.error(usage);
		process.exit(2);
	}
}
if (!action) {
	console.error(usage);
	process.exit(2);
}

const { HerdrStore, herdrSubagentRoot } = await createJiti(import.meta.url).import("./store.ts");
root = resolve(root ?? herdrSubagentRoot());
const database = join(root, "control.sqlite");
if (action === "--status") {
	// Inspection must not initialize a worker, change the schema, or create a previously missing database.
	let status = { allowed: false, reason: "Database has not been initialized" };
	if (existsSync(database)) {
		const db = new DatabaseSync(database, { readOnly: true });
		try {
			const hasGate = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lifecycle_guard'").get();
			const row = hasGate ? db.prepare("SELECT allowed,reason FROM lifecycle_guard WHERE id=1").get() : undefined;
			status = row ? { allowed: Number(row.allowed) === 1, reason: String(row.reason) }
				: { allowed: false, reason: "Upgrade paused: confirm all old workers have stopped or reloaded" };
		} finally { db.close(); }
	}
	console.log(JSON.stringify({ database, ...status }));
} else {
	const store = new HerdrStore(root);
	try {
		const status = await store.confirmLifecycleUpgrade("all-old-workers-stopped");
		console.log(JSON.stringify({ database, ...status }));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		await store.close();
	}
}
