import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OWNER_FILE = ".owner";
const LOCK_DIR = ".owner.lock";
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

/** Who receives an inbox. `sessionFile` is what a sender checks against the target's Herdr agent session. */
export type OwnerRecord = { pid: number; token: string; sessionFile: string | null; startedAt: string };
export type Acquired = { owned: true; token: string } | { owned: false; holder?: OwnerRecord; reason: string };

export function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readOwner(dir: string): OwnerRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8")) as Partial<OwnerRecord> | null;
		if (parsed && typeof parsed.pid === "number" && typeof parsed.token === "string") return parsed as OwnerRecord;
	} catch { /* absent or unreadable */ }
	return undefined;
}

/** Runs `action` under a mutex directory (mkdir is atomic everywhere). A mutex older than 10 s belongs to a crashed holder. */
function locked<T>(dir: string, action: () => T): T | undefined {
	const lock = join(dir, LOCK_DIR);
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try { mkdirSync(lock); break; } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
			try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true }); } catch { /* released meanwhile */ }
			if (Date.now() > deadline) return undefined;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
	try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/**
 * Claims the inbox for this process. The owner record is published atomically (temporary file, then rename) and every
 * acquire and release runs under one mutex, so a record is never seen half-written, never replaced by two processes at
 * once, and never removed by a process that does not hold it. A live owner other than this process keeps the inbox.
 */
export function acquireOwner(dir: string, sessionFile: string | null, alive: (pid: number) => boolean = processAlive): Acquired {
	const result = locked<Acquired>(dir, () => {
		const holder = readOwner(dir);
		if (holder && holder.pid !== process.pid && alive(holder.pid)) return { owned: false, holder, reason: `owned by process ${holder.pid}` };
		const token = randomUUID();
		const record: OwnerRecord = { pid: process.pid, token, sessionFile, startedAt: new Date().toISOString() };
		const tmp = join(dir, `${OWNER_FILE}.${token}.tmp`);
		writeFileSync(tmp, JSON.stringify(record));
		renameSync(tmp, join(dir, OWNER_FILE));
		return { owned: true, token };
	});
	return result ?? { owned: false, reason: "could not lock the inbox" };
}

/** Removes the owner record only if it is still the one this instance published. */
export function releaseOwner(dir: string, token: string) {
	locked(dir, () => { if (readOwner(dir)?.token === token) rmSync(join(dir, OWNER_FILE), { force: true }); });
}
