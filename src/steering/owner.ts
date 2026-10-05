import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OWNER_FILE = ".owner";
export const LOCK_FILE = ".owner.lock";
const RELEASE_WAIT_MS = 1_000;

/** Who receives an inbox. `sessionFile` is what a sender checks against the target's Herdr agent session. */
export type OwnerRecord = { pid: number; token: string; sessionFile: string | null; startedAt: string };
export type Acquired = { owned: true; token: string } | { owned: false; busy: boolean; holder?: OwnerRecord; reason: string };
type LockRecord = { pid: number; token: string };

export function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function readJson<T>(path: string): T | undefined {
	try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

export function readOwner(dir: string): OwnerRecord | undefined {
	const parsed = readJson<Partial<OwnerRecord> | null>(join(dir, OWNER_FILE));
	return parsed && typeof parsed.pid === "number" && typeof parsed.token === "string" ? parsed as OwnerRecord : undefined;
}

/** Publishes `record` at `path` atomically and exclusively: a temporary file hard-linked into place never shows partial content. */
function publishExclusive(path: string, record: object): boolean {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(record));
	try { linkSync(tmp, path); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally { rmSync(tmp, { force: true }); }
}

/**
 * Takes the short-lived mutex that serializes owner changes, or reports it busy. The mutex names its holder (pid and
 * instance token). It is taken over only when that holder process is dead, never because it is old: a paused live
 * holder keeps it. Taking over renames the dead holder's file away and verifies what was renamed, so two takers
 * cannot both delete a live successor's mutex undetected.
 */
function tryLock(dir: string, alive: (pid: number) => boolean): string | undefined {
	const lock = join(dir, LOCK_FILE);
	const token = randomUUID();
	for (let attempt = 0; attempt < 3; attempt++) {
		if (publishExclusive(lock, { pid: process.pid, token } satisfies LockRecord)) return token;
		const holder = readJson<LockRecord>(lock);
		if (!holder || typeof holder.pid !== "number") continue; // vanished between our attempt and the read
		if (holder.pid === process.pid || alive(holder.pid)) return undefined;
		const aside = `${lock}.stale.${token}`;
		try { renameSync(lock, aside); } catch { continue; }
		const moved = readJson<LockRecord>(aside);
		if (moved?.token !== holder.token) {
			// Took a live successor's mutex instead: put it back (exclusively) and let it finish.
			try { linkSync(aside, lock); } catch { /* another taker already holds it */ }
		}
		rmSync(aside, { force: true });
	}
	return undefined;
}
function unlock(dir: string, token: string) {
	const lock = join(dir, LOCK_FILE);
	if (readJson<LockRecord>(lock)?.token === token) rmSync(lock, { force: true });
}
const holds = (dir: string, token: string) => readJson<LockRecord>(join(dir, LOCK_FILE))?.token === token;

/** One acquisition attempt. `busy` means the mutex was held by a live process: retry shortly. */
export function acquireOwner(dir: string, sessionFile: string | null, alive: (pid: number) => boolean = processAlive): Acquired {
	const lock = tryLock(dir, alive);
	if (!lock) return { owned: false, busy: true, reason: "another process is changing the inbox owner" };
	try {
		const holder = readOwner(dir);
		if (holder && holder.pid !== process.pid && alive(holder.pid)) return { owned: false, busy: false, holder, reason: `owned by process ${holder.pid}` };
		const token = randomUUID();
		const record: OwnerRecord = { pid: process.pid, token, sessionFile, startedAt: new Date().toISOString() };
		const tmp = join(dir, `${OWNER_FILE}.${token}.tmp`);
		writeFileSync(tmp, JSON.stringify(record));
		renameSync(tmp, join(dir, OWNER_FILE));
		// If a mutex takeover raced ours, we may no longer hold it: do not claim an inbox we cannot serialize.
		if (!holds(dir, lock)) {
			if (readOwner(dir)?.token === token) rmSync(join(dir, OWNER_FILE), { force: true });
			return { owned: false, busy: true, reason: "lost the owner mutex during acquisition" };
		}
		return { owned: true, token };
	} finally { unlock(dir, lock); }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries a busy mutex with exponential backoff (50 ms up to 1 s) for at most `withinMs`, without blocking Pi. */
export async function acquireOwnerWithBackoff(dir: string, sessionFile: string | null, options: { withinMs?: number; alive?: (pid: number) => boolean; cancelled?: () => boolean } = {}): Promise<Acquired> {
	const end = Date.now() + (options.withinMs ?? 15_000);
	let delay = 50;
	for (;;) {
		const claim = acquireOwner(dir, sessionFile, options.alive);
		if (claim.owned && options.cancelled?.()) { releaseOwner(dir, claim.token); return { owned: false, busy: false, reason: "cancelled" }; }
		if (claim.owned || !claim.busy || Date.now() + delay > end || options.cancelled?.()) return claim;
		await sleep(delay);
		delay = Math.min(delay * 2, 1_000);
	}
}

/** Removes the owner record only if it is still the one this instance published. */
export function releaseOwner(dir: string, token: string) {
	try { releaseOwnerUnchecked(dir, token); } catch { /* the inbox directory is gone: nothing left to release */ }
}
function releaseOwnerUnchecked(dir: string, token: string) {
	const end = Date.now() + RELEASE_WAIT_MS;
	let lock = tryLock(dir, processAlive);
	while (!lock && Date.now() < end) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		lock = tryLock(dir, processAlive);
	}
	try { if (readOwner(dir)?.token === token) rmSync(join(dir, OWNER_FILE), { force: true }); } finally { if (lock) unlock(dir, lock); }
}
