// Slot state. The band reads the role, agent, machine, request and pending files.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const ROLES = ["reviewer", "implementer", "researcher", "explorer"] as const;
export type Role = typeof ROLES[number];
export type Backend = "pi" | "claude";

export interface SlotRecord {
	/** Qualified runner agent ID: `<id>` or `<id>@<machine>`. */
	agentId: string;
	role: Role;
	agent: Backend;
	machine?: string;
	/** sha256 of the canonical role profile the conversation was started with. */
	profile?: string;
	/** sha256 of the request text in flight, for duplicate detection. */
	inflight?: string;
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.SIDECAR_STATE_DIR || join(homedir(), ".cache", "claude-sidecar");
}

/** Sidecars belong to the Claude pane, so slots survive /clear; numbered slots keep independent context. */
export function ownerName(env: NodeJS.ProcessEnv, host: "herdr" | "hc"): string {
	if (env.SIDECAR_AGENT) return env.SIDECAR_AGENT;
	const id = host === "hc" ? `hc-${env.HC_TERMINAL_ID ?? ""}` : env.HERDR_PANE_ID ?? "";
	return `sc-${id.toLowerCase().replaceAll(":", "-")}`;
}

export function slotName(owner: string, slot: string): string {
	return slot === "1" ? owner : `${owner}-${slot}`;
}

function writeAtomic(path: string, text: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, path);
}

function readText(path: string): string | undefined {
	try { return readFileSync(path, "utf8").trim(); } catch { return undefined; }
}

export class SlotState {
	readonly dir: string;
	readonly name: string;
	constructor(dir: string, name: string) {
		this.dir = dir;
		this.name = name;
		mkdirSync(join(dir, "runner"), { recursive: true });
		mkdirSync(join(dir, "reports"), { recursive: true });
	}

	private path(suffix: string): string { return join(this.dir, `${this.name}${suffix}`); }

	read(): SlotRecord | undefined {
		const text = readText(join(this.dir, "runner", `${this.name}.json`));
		if (!text) return undefined;
		try { return JSON.parse(text) as SlotRecord; } catch { return undefined; }
	}

	write(record: SlotRecord): void {
		writeAtomic(join(this.dir, "runner", `${this.name}.json`), JSON.stringify(record) + "\n");
		// The band shows role and backend from the launcher's files.
		writeAtomic(this.path(".role"), record.role + "\n");
		writeAtomic(this.path(".agent"), record.agent + "\n");
		if (record.machine) writeAtomic(this.path(".machine"), record.machine + "\n");
		else rmSync(this.path(".machine"), { force: true });
	}

	forget(): void {
		for (const suffix of [".role", ".agent", ".machine", ".pending", ".request.json"]) rmSync(this.path(suffix), { force: true });
		rmSync(join(this.dir, "runner", `${this.name}.json`), { force: true });
	}

	/** The band's busy row: present without `finished` while a request runs. */
	beginRequest(id: string, started: number, machine?: string): void {
		writeAtomic(this.path(".request.json"), JSON.stringify({ id, started, ...(machine ? { machine } : {}) }) + "\n");
	}

	finishRequest(finished: number): void {
		const text = readText(this.path(".request.json"));
		if (!text) return;
		try { writeAtomic(this.path(".request.json"), JSON.stringify({ ...JSON.parse(text), finished }) + "\n"); } catch {}
	}

	pending(id: string | undefined, answered?: string): void {
		if (!id) { rmSync(this.path(".pending"), { force: true }); return; }
		writeAtomic(this.path(".pending"), JSON.stringify({ id, ...(answered ? { answered } : {}) }) + "\n");
	}

	pendingId(): string | undefined {
		const text = readText(this.path(".pending"));
		if (!text) return undefined;
		try {
			const value = JSON.parse(text) as { id?: string; answered?: string };
			return value.answered ? undefined : value.id;
		} catch { return undefined; }
	}

	reportPath(id: string): string { return join(this.dir, "reports", `${id}.md`); }

	saveReport(id: string, text: string): string {
		const path = this.reportPath(id);
		writeAtomic(path, text.endsWith("\n") ? text : text + "\n");
		writeAtomic(this.path(".report"), path + "\n");
		return path;
	}

	latestReport(): string | undefined { return readText(this.path(".report")); }

	/** One launcher per slot at a time. */
	lock(signal?: AbortSignal): Promise<() => void> {
		return acquireLock(join(this.dir, "runner", `${this.name}.lock`), signal);
	}

	/** Slots of this owner that the runner front-end manages. */
	static slots(dir: string, owner: string): string[] {
		const pattern = new RegExp(`^${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-(\\d+))?\\.json$`);
		if (!existsSync(join(dir, "runner"))) return [];
		return readdirSync(join(dir, "runner")).flatMap((name) => {
			const match = pattern.exec(name);
			return match ? [match[1] ?? "1"] : [];
		}).sort((a, b) => Number(a) - Number(b));
	}
}

/**
 * An exclusive lock held as a SQLite write lock on `PATH.sqlite`: the OS releases it when the holder exits, so a crashed
 * holder never leaves a lock to reclaim. An aborted SIGNAL makes a held lock fail at once.
 */
export async function acquireLock(path: string, signal?: AbortSignal, pollMs = 500): Promise<() => void> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(`${path}.sqlite`);
	for (;;) {
		try {
			db.exec("BEGIN EXCLUSIVE");
			// Launchers before SQLite locks held PATH with their PID; one still running keeps its slot.
			if (!legacyHolder(path)) return () => { try { db.close(); } catch {} };
			db.exec("ROLLBACK");
		} catch (error) {
			if ((error as { errcode?: number }).errcode !== 5) { db.close(); throw error; }
		}
		if (signal?.aborted) { db.close(); throw new Error("aborted"); }
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

function legacyHolder(path: string): boolean {
	const pid = Number(readText(path));
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** The band labels a request by the third dash-separated word of its id. */
export function requestId(kind: string, slotName: string, now = new Date()): string {
	const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
	return `${stamp.slice(0, 8)}-${stamp.slice(8)}-${kind}-${slotName}.${randomUUID().slice(0, 6)}`;
}
