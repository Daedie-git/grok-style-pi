import { DatabaseSync } from "node:sqlite";
import { parentPort, threadId, workerData } from "node:worker_threads";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { START_TIMEOUT_MS, expireUnaccepted, isTerminal, transition, type RunRef, type RunSnapshot, type ExecutionEvent } from "./state.ts";
import type { AgentRecord, HerdrTask, LaunchRecord, LaunchStage, Command, ChildBinding, CompletionNotice } from "./store.ts";

const { root } = workerData as { root: string };
mkdirSync(root, { recursive: true });

function database(name: string): DatabaseSync {
	const db = new DatabaseSync(join(root, name));
	db.exec("PRAGMA busy_timeout=5000");
	const deadline = Date.now() + 5000;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
			return db;
		} catch (error) {
			// Simultaneous first opens can report BUSY while enabling WAL despite busy_timeout.
			if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) { db.close(); throw error; }
			Atomics.wait(sleeper, 0, 0, 25);
		}
	}
}

// Temporary diagnostics: never include operation arguments, prompts, or stored task data.
function databaseDiagnostics<T>(operation: string, body: () => T): T {
	try { return body(); }
	catch (error) {
		const sqlite = error as { code?: string; errcode?: number } | null;
		if (sqlite?.code !== "ERR_SQLITE_ERROR" && typeof sqlite?.errcode !== "number") throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`[DEBUG-herdr-db] operation=${operation} code=${sqlite.code ?? "unknown"} errcode=${sqlite.errcode ?? "unknown"} node=${process.version} pid=${process.pid} thread=${threadId}: ${message}`, { cause: error });
	}
}

const db = databaseDiagnostics("initialize control.sqlite", () => database("control.sqlite"));
const placement = databaseDiagnostics("initialize placement.sqlite", () => database("placement.sqlite"));
// The placement lock is retried asynchronously by the caller. Control operations use another connection.
placement.exec("PRAGMA busy_timeout=0");
let placementOwner: string | undefined;

function transaction<T>(body: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = body();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

databaseDiagnostics("initialize control.sqlite schema", () => transaction(() => {
	const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
	if (version !== 0 && version !== 2) throw new Error(`Unsupported Herdr protocol version ${version}`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, pane TEXT, session_file TEXT NOT NULL, binding TEXT, data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS commands_run ON commands(run);
		CREATE TABLE IF NOT EXISTS launches (run TEXT PRIMARY KEY REFERENCES runs(id), data TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS notices (run TEXT PRIMARY KEY REFERENCES runs(id), acknowledged INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS retired_owners (id TEXT PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires INTEGER NOT NULL, next_at INTEGER NOT NULL);
		INSERT OR IGNORE INTO maintenance(id,expires,next_at) VALUES(1,0,0);
		CREATE INDEX IF NOT EXISTS active_runs ON runs(agent) WHERE json_extract(data,'$.phase') IN ('queued','starting','running','blocked');
		CREATE INDEX IF NOT EXISTS recoverable_launches ON launches(run) WHERE json_extract(data,'$.stage') NOT IN ('published','closed','ambiguous');
		CREATE INDEX IF NOT EXISTS pending_notices ON notices(run) WHERE acknowledged=0;
		PRAGMA user_version=2;
	`);
}));

function decode<T>(row: Record<string, unknown> | undefined): T | undefined {
	return row ? JSON.parse(String(row.data)) as T : undefined;
}
function agent(id: string): AgentRecord | undefined {
	return decode<AgentRecord>(db.prepare("SELECT data FROM agents WHERE id=?").get(id));
}
function run(ref: RunRef): RunSnapshot {
	const value = decode<RunSnapshot>(db.prepare("SELECT data FROM runs WHERE id=? AND agent=?").get(ref.runId, ref.agentId));
	if (!value) throw new Error(`Run not found: ${ref.agentId}/${ref.runId}`);
	return value;
}
function saveRun(value: RunSnapshot): RunSnapshot {
	db.prepare("UPDATE runs SET data=? WHERE id=? AND agent=?").run(JSON.stringify(value), value.runId, value.agentId);
	return value;
}
function saveAgent(value: AgentRecord) {
	db.prepare("UPDATE agents SET pane=?, session_file=?, data=? WHERE id=?").run(value.paneId, resolve(value.sessionFile), JSON.stringify(value), value.id);
}
function current(ref: RunRef): boolean {
	return agent(ref.agentId)?.currentRunId === ref.runId;
}
function owns(agentId: string, token: string): boolean {
	return db.prepare("SELECT binding FROM agents WHERE id=?").get(agentId)?.binding === token;
}
function addCommand(ref: RunRef, type: Command["type"], text = "") {
	const command: Command = { ...ref, id: randomUUID(), type, text, state: "queued" };
	db.prepare("INSERT INTO commands(id,run,data) VALUES(?,?,?)").run(command.id, ref.runId, JSON.stringify(command));
}
function commands(ref: RunRef): Command[] {
	return db.prepare("SELECT data FROM commands WHERE run=? ORDER BY seq").all(ref.runId).map((row) => decode<Command>(row)!);
}
function newRun(agentId: string, now: number): RunSnapshot {
	return { agentId, runId: randomUUID(), phase: "queued", accepted: false, cancelRequested: false, deadline: 0, turns: 0, updatedAt: now };
}
function insertRun(value: RunSnapshot) {
	db.prepare("INSERT INTO runs(id,agent,data) VALUES(?,?,?)").run(value.runId, value.agentId, JSON.stringify(value));
}
function launch(ref: RunRef): LaunchRecord {
	const value = decode<LaunchRecord>(db.prepare("SELECT data FROM launches WHERE run=?").get(ref.runId));
	if (!value || value.agentId !== ref.agentId) throw new Error("Launch not found");
	return value;
}
function saveLaunch(value: LaunchRecord) {
	db.prepare("UPDATE launches SET data=? WHERE run=?").run(JSON.stringify(value), value.runId);
}
function publish(ref: RunRef, prompt: string, notify: boolean, now: number): RunSnapshot {
	const value = run(ref);
	if (!current(ref) || value.phase !== "queued" || value.cancelRequested) throw new Error("Run cannot be published");
	if (commands(ref).some((command) => command.type === "prompt")) throw new Error("Run already published");
	addCommand(ref, "prompt", prompt);
	if (notify) db.prepare("INSERT INTO notices(run) VALUES(?)").run(ref.runId);
	return saveRun({ ...value, deadline: now + START_TIMEOUT_MS, updatedAt: now });
}

const operations = {
	assertProtocolReady(): void {
		// Never silently mix the shared-status protocol with run-scoped control. Legacy files remain untouched.
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "sessions" || entry.name === "panes" || entry.name === "locks") continue;
			let task: unknown;
			try { task = JSON.parse(readFileSync(join(root, entry.name, "task.json"), "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
			if (!task) continue;
			let status: { status?: string } = {};
			try { status = JSON.parse(readFileSync(join(root, entry.name, "status.json"), "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (!status.status || !["completed", "failed", "stopped"].includes(status.status)) {
				throw new Error(`Legacy Herdr agent ${entry.name} is still active. Finish or stop legacy runs before switching to protocol 2.`);
			}
		}
	},
	reserveAgent(task: HerdrTask, sessionFile: string, owner: string, now: number): RunRef | undefined {
		return transaction(() => {
			if (agent(task.id)) return undefined;
			const first = newRun(task.id, now);
			const record: AgentRecord = { ...task, currentRunId: first.runId, sessionFile: resolve(sessionFile) };
			db.prepare("INSERT INTO agents(id,pane,session_file,data) VALUES(?,?,?,?)").run(task.id, task.paneId, record.sessionFile, JSON.stringify(record));
			insertRun(first);
			const value: LaunchRecord = { agentId: task.id, runId: first.runId, stage: "reserved", owner, updatedAt: now };
			db.prepare("INSERT INTO launches(run,data) VALUES(?,?)").run(first.runId, JSON.stringify(value));
			return { agentId: task.id, runId: first.runId };
		});
	},
	findAgent: agent,
	agentForSession(paneId: string, sessionFile: string): AgentRecord | undefined {
		return decode<AgentRecord>(db.prepare("SELECT data FROM agents WHERE pane=? AND session_file=?").get(paneId, resolve(sessionFile)));
	},
	claimMaintenance(token: string, now: number): boolean {
		// An early read avoids taking the write lock on every 200 ms tick in every pane.
		const lease = db.prepare("SELECT expires,next_at FROM maintenance WHERE id=1").get()!;
		if (Number(lease.expires) > now || Number(lease.next_at) > now) return false;
		return Number(db.prepare("UPDATE maintenance SET token=?,expires=? WHERE id=1 AND expires<=? AND next_at<=?").run(token, now + 5000, now, now).changes) === 1;
	},
	activeRuns(): Array<{ agent: AgentRecord; run: RunSnapshot }> {
		return db.prepare(`SELECT a.data AS agent_data,r.data AS run_data FROM runs r JOIN agents a ON a.id=r.agent
			WHERE json_extract(r.data,'$.phase') IN ('queued','starting','running','blocked')
			AND json_extract(r.data,'$.deadline')>0 AND json_extract(a.data,'$.currentRunId')=r.id`).all()
			.map((row) => ({ agent: JSON.parse(String(row.agent_data)), run: JSON.parse(String(row.run_data)) }));
	},
	finishMaintenance(token: string, observations: Array<{ ref: RunRef; alive: boolean }>, now: number): boolean {
		return transaction(() => {
			const lease = db.prepare("SELECT token,expires FROM maintenance WHERE id=1").get()!;
			if (lease.token !== token || Number(lease.expires) <= now) return false;
			for (const { ref, alive } of observations) {
				if (!current(ref)) continue;
				const value = run(ref);
				if (isTerminal(value.phase)) continue;
				const next = alive ? expireUnaccepted(value, now) : transition(value, { type: "failed", error: "The Herdr pane closed before the agent finished." }, now);
				if (next !== value) saveRun(next);
			}
			db.prepare("UPDATE maintenance SET expires=0,next_at=? WHERE id=1 AND token=?").run(now + 1000, token);
			return true;
		});
	},
	listAgents(): AgentRecord[] {
		return db.prepare("SELECT data FROM agents").all().map((row) => decode<AgentRecord>(row)!);
	},
	read: run,
	beginRun(agentId: string, previousRunId: string, prompt: string, notify: boolean, now: number): RunRef {
		return transaction(() => {
			const record = agent(agentId);
			if (!record || record.currentRunId !== previousRunId || !isTerminal(run({ agentId, runId: previousRunId }).phase)) {
				throw new Error(`Agent ${agentId} is still running or already being resumed. Use steer_subagent or get_subagent_result.`);
			}
			const next = newRun(agentId, now);
			insertRun(next);
			saveAgent({ ...record, currentRunId: next.runId });
			publish(next, prompt, notify, now);
			return { agentId, runId: next.runId };
		});
	},
	publish(ref: RunRef, prompt: string, notify: boolean, now: number): RunSnapshot {
		return transaction(() => {
			const value = publish(ref, prompt, notify, now);
			const pending = launch(ref);
			saveLaunch({ ...pending, stage: "published", updatedAt: now });
			return value;
		});
	},
	steer(ref: RunRef, text: string): void {
		transaction(() => {
			const value = run(ref);
			if (!current(ref) || isTerminal(value.phase) || value.cancelRequested) throw new Error(`Run ${ref.runId} is not running`);
			addCommand(ref, "steer", text);
		});
	},
	requestCancellation(ref: RunRef, now: number): RunSnapshot {
		return transaction(() => {
			const value = run(ref);
			if (isTerminal(value.phase) || value.cancelRequested) return value;
			// An unpublished or unclaimed prompt can be cancelled without invoking Pi at all.
			const dispatched = commands(ref).some((command) => command.type === "prompt" && command.state !== "queued");
			if (!dispatched) return saveRun({ ...value, cancelRequested: true, phase: "stopped", error: "Stopped", updatedAt: now });
			addCommand(ref, "abort");
			return saveRun({ ...value, cancelRequested: true, updatedAt: now });
		});
	},
	expireUnacceptedRun(ref: RunRef, now: number): RunSnapshot {
		return transaction(() => saveRun(expireUnaccepted(run(ref), now)));
	},
	recordPaneClosed(ref: RunRef, now: number): RunSnapshot {
		return transaction(() => saveRun(transition(run(ref), { type: "failed", error: "The Herdr pane closed before the agent finished." }, now)));
	},
	attach(paneId: string, sessionFile: string, sessionId: string): ChildBinding | undefined {
		return transaction(() => {
			const record = operations.agentForSession(paneId, sessionFile);
			if (!record || (record.sessionId && record.sessionId !== sessionId)) return undefined;
			const token = randomUUID();
			saveAgent({ ...record, sessionId });
			db.prepare("UPDATE agents SET binding=? WHERE id=?").run(token, record.id);
			const value = run({ agentId: record.id, runId: record.currentRunId });
			const ambiguous = commands(value).some((command) => command.state === "dispatching");
			return { agent: { ...record, sessionId }, token, run: value, ambiguous };
		});
	},
	claimNextCommand(agentId: string, token: string, streaming: boolean): Command | undefined {
		return transaction(() => {
			if (!owns(agentId, token)) return undefined;
			const record = agent(agentId)!;
			const value = run({ agentId, runId: record.currentRunId });
			if (isTerminal(value.phase)) return undefined;
			const pending = commands(value).filter((command) => command.state === "queued");
			const command = pending.find((item) => item.type === "abort") ?? pending.find((item) => {
				if (value.cancelRequested) return false;
				return item.type === "prompt" ? !streaming && value.phase === "queued" : value.accepted && streaming;
			});
			if (!command) return undefined;
			command.state = "dispatching";
			db.prepare("UPDATE commands SET data=? WHERE id=?").run(JSON.stringify(command), command.id);
			if (command.type === "prompt") saveRun({ ...value, phase: "starting", updatedAt: Date.now() });
			return command;
		});
	},
	commandDelivered(command: Command, token: string): void {
		transaction(() => {
			if (!owns(command.agentId, token)) return;
			const stored = commands(command).find((item) => item.id === command.id);
			if (!stored || stored.state !== "dispatching") return;
			db.prepare("UPDATE commands SET data=? WHERE id=?").run(JSON.stringify({ ...stored, state: "delivered" }), command.id);
		});
	},
	authorizeInput(ref: RunRef, commandId: string, token: string): boolean {
		if (!owns(ref.agentId, token) || !current(ref)) return false;
		const value = run(ref);
		return !isTerminal(value.phase) && !value.cancelRequested && commands(ref).some((command) => command.id === commandId && command.type !== "abort" && command.state !== "queued");
	},
	recordExecutionEvent(ref: RunRef, token: string, event: ExecutionEvent, now: number): RunSnapshot {
		return transaction(() => {
			const value = run(ref);
			if (!owns(ref.agentId, token) || !current(ref)) return value;
			const next = transition(value, event, now);
			if (next.cancelRequested && !value.cancelRequested) addCommand(ref, "abort");
			return saveRun(next);
		});
	},
	recoverableLaunches(): LaunchRecord[] {
		return db.prepare("SELECT data FROM launches WHERE json_extract(data,'$.stage') NOT IN ('published','closed','ambiguous')").all().map((row) => decode<LaunchRecord>(row)!);
	},
	launches(): LaunchRecord[] {
		return db.prepare("SELECT data FROM launches").all().map((row) => decode<LaunchRecord>(row)!);
	},
	recordLaunch(ref: RunRef, owner: string, stage: LaunchStage, facts: { paneId?: string; tabId?: string; direction?: "right" | "down"; error?: string }, now: number): void {
		transaction(() => {
			const value = launch(ref);
			if (value.owner !== owner) throw new Error("Launch ownership changed");
			saveLaunch({ ...value, ...facts, stage, updatedAt: now });
			if (facts.paneId) saveAgent({ ...agent(ref.agentId)!, paneId: facts.paneId });
		});
	},
	claimLaunchRecovery(ref: RunRef, previousOwner: string, owner: string, now: number): boolean {
		return transaction(() => {
			const value = launch(ref);
			if (value.owner !== previousOwner || value.stage === "published" || value.stage === "closed") return false;
			saveLaunch({ ...value, owner, updatedAt: now });
			return true;
		});
	},
	failLaunch(ref: RunRef, owner: string, error: string, stopped: boolean, now: number): RunSnapshot {
		return transaction(() => {
			if (launch(ref).owner !== owner) throw new Error("Launch ownership changed");
			return saveRun(transition(run(ref), { type: stopped ? "stopped" : "failed", error }, now));
		});
	},
	notices(parentPaneId: string): CompletionNotice[] {
		return db.prepare(`SELECT r.data,a.data AS agent_data FROM notices n JOIN runs r ON r.id=n.run JOIN agents a ON a.id=r.agent
			WHERE n.acknowledged=0 AND json_extract(a.data,'$.parentPaneId')=? AND json_extract(r.data,'$.phase') IN ('completed','failed','stopped')`).all(parentPaneId).map((row) => {
			const value = decode<RunSnapshot>(row)!;
			const record = JSON.parse(String(row.agent_data)) as AgentRecord;
			return { agentId: value.agentId, runId: value.runId, id: value.runId, agent: record, run: value };
		});
	},
	acknowledgeNotice(runId: string): void {
		db.prepare("UPDATE notices SET acknowledged=1 WHERE run=?").run(runId);
	},
	retireOwner(owner: string): void {
		db.prepare("INSERT OR IGNORE INTO retired_owners(id) VALUES(?)").run(owner);
	},
	ownerRetired(owner: string): boolean {
		return !!db.prepare("SELECT id FROM retired_owners WHERE id=?").get(owner);
	},
	releasePlacement(ref: RunRef): void {
		transaction(() => {
			const value = launch(ref);
			if (value.stage === "published") saveLaunch({ ...value, stage: "closed" });
		});
	},
	tryPlacementLock(owner: string): boolean {
		if (placementOwner) return false;
		try { placement.exec("BEGIN IMMEDIATE"); }
		catch (error) {
			if ((error as { errcode?: number }).errcode === 5 || /database is locked/.test(String(error))) return false;
			throw error;
		}
		placementOwner = owner;
		return true;
	},
	releasePlacementLock(owner: string): void {
		if (placementOwner !== owner) throw new Error("Placement ownership changed");
		placement.exec("ROLLBACK");
		placementOwner = undefined;
	},
};

export type StoreOperations = typeof operations;

parentPort!.on("message", (request: { id: number; operation: keyof StoreOperations; args: unknown[] }) => {
	try {
		const operation = operations[request.operation] as (...args: unknown[]) => unknown;
		if (typeof operation !== "function") throw new Error("Unknown Herdr control operation");
		parentPort!.postMessage({ id: request.id, value: databaseDiagnostics(request.operation, () => operation(...request.args)) });
	} catch (error) {
		parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
	}
});
