// Deliberately independent of current Herdr code: this connection predates the upgrade.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

mkdirSync(workerData.root, { recursive: true });
const db = new DatabaseSync(join(workerData.root, "control.sqlite"));
db.exec(`
	PRAGMA busy_timeout=5000;
	PRAGMA journal_mode=WAL;
	PRAGMA foreign_keys=ON;
	CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, pane TEXT, session_file TEXT NOT NULL, binding TEXT, data TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires INTEGER NOT NULL, next_at INTEGER NOT NULL);
	INSERT OR IGNORE INTO maintenance(id,expires,next_at) VALUES(1,0,0);
	PRAGMA user_version=2;
`);
parentPort.on("message", ({ id, operation, sql, args = [], method = "run", token, now, ref, prompt }) => {
	try {
		let value;
		if (operation === "sql") value = db.prepare(sql)[method](...args);
		else if (operation === "claimMaintenance") {
			value = Number(db.prepare("UPDATE maintenance SET token=?,expires=? WHERE id=1 AND expires<=? AND next_at<=?").run(token, now + 5000, now, now).changes) === 1;
		} else if (operation === "finishMaintenance") {
			// Protocol 1 did not know about paneClose intents. A missing pane failed its active run.
			db.exec("BEGIN IMMEDIATE");
			try {
				const lease = db.prepare("SELECT token,expires FROM maintenance WHERE id=1").get();
				value = lease.token === token && Number(lease.expires) > now;
				if (value) {
					const row = db.prepare("SELECT data FROM runs WHERE id=? AND agent=?").get(ref.runId, ref.agentId);
					const run = JSON.parse(row.data);
					if (["queued", "starting", "running", "blocked"].includes(run.phase)) {
						db.prepare("UPDATE runs SET data=? WHERE id=? AND agent=?").run(JSON.stringify({ ...run, phase: "failed", error: "The Herdr pane closed before the agent finished.", updatedAt: now }), ref.runId, ref.agentId);
					}
					db.prepare("UPDATE maintenance SET expires=0,next_at=? WHERE id=1 AND token=?").run(now + 1000, token);
				}
				db.exec("COMMIT");
			} catch (error) { db.exec("ROLLBACK"); throw error; }
		} else if (operation === "beginRun") {
			// Old beginRun spreads agent data without understanding a newer paneClose field.
			db.exec("BEGIN IMMEDIATE");
			try {
				const record = JSON.parse(db.prepare("SELECT data FROM agents WHERE id=?").get(ref.agentId).data);
				const previous = JSON.parse(db.prepare("SELECT data FROM runs WHERE id=? AND agent=?").get(ref.runId, ref.agentId).data);
				if (record.currentRunId !== ref.runId || !["completed", "failed", "stopped"].includes(previous.phase)) throw new Error("Agent is still running or already being resumed");
				const runId = randomUUID();
				const next = { agentId: ref.agentId, runId, phase: "queued", accepted: false, cancelRequested: false, deadline: now + 15_000, turns: 0, updatedAt: now };
				db.prepare("INSERT INTO runs(id,agent,data) VALUES(?,?,?)").run(runId, ref.agentId, JSON.stringify(next));
				const updated = { ...record, currentRunId: runId, paneState: undefined };
				db.prepare("UPDATE agents SET pane=?,session_file=?,data=? WHERE id=?").run(updated.paneId, updated.sessionFile, JSON.stringify(updated), ref.agentId);
				const command = { agentId: ref.agentId, runId, id: randomUUID(), type: "prompt", text: prompt, state: "queued" };
				db.prepare("INSERT INTO commands(id,run,data) VALUES(?,?,?)").run(command.id, runId, JSON.stringify(command));
				db.prepare("INSERT INTO notices(run) VALUES(?)").run(runId);
				db.exec("COMMIT");
				value = { agentId: ref.agentId, runId };
			} catch (error) { db.exec("ROLLBACK"); throw error; }
		} else if (operation === "close") {
			db.close();
			parentPort.postMessage({ id, value: true });
			parentPort.close();
			return;
		} else throw new Error(`Unknown legacy fixture operation: ${operation}`);
		parentPort.postMessage({ id, value });
	} catch (error) { parentPort.postMessage({ id, error: String(error) }); }
});
parentPort.postMessage({ ready: true });
