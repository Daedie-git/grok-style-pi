import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { missing } from "../store/journal.ts";

function snapshot(path: string): { inode: number; token?: string; mtime: number } {
	const directory = statSync(path);
	try {
		const token = readFileSync(join(path, "owner"), "utf8");
		return { inode: directory.ino, token, mtime: statSync(join(path, "owner")).mtimeMs };
	} catch (error) {
		if (missing(error)) return { inode: directory.ino, mtime: directory.mtimeMs };
		throw error;
	}
}

/** Serialize stale reapers inside the old lease, then remove a renamed quarantine.
 * A contender holding an old snapshot cannot remove a newly acquired lease.
 */
function reap(path: string, now: () => number): void {
	try {
		const before = snapshot(path);
		if (now() - before.mtime <= 10_000) return;
		const guard = join(path, ".reap");
		try { mkdirSync(guard); } catch (error) {
			if (missing(error)) return;
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				// Recover a process that died during stale-lease reclamation.
				if (now() - statSync(guard).mtimeMs > 10_000) rmSync(guard, { recursive: true, force: true });
				return;
			}
			throw error;
		}
		const guardInode = statSync(guard).ino;
		try {
			const current = snapshot(path);
			if (current.inode !== before.inode || current.token !== before.token
				|| (before.token !== undefined && current.mtime !== before.mtime)) return;
			const quarantine = `${path}.stale-${randomBytes(16).toString("hex")}`;
			renameSync(path, quarantine);
			rmSync(quarantine, { recursive: true, force: true });
		} finally {
			try {
				if (statSync(guard).ino === guardInode) rmSync(guard, { recursive: true, force: true });
			} catch (error) { if (!missing(error)) throw error; }
		}
	} catch (error) { if (!missing(error)) throw error; }
}

/** Filesystem lease shared by all task writers, including other Node processes. */
export async function lockDirectory(path: string, now: () => number = Date.now): Promise<() => void> {
	const token = randomBytes(16).toString("hex");
	const ownerFile = join(path, "owner");
	for (let attempt = 0; attempt <= 30; attempt++) {
		try {
			mkdirSync(path);
			try {
				writeFileSync(ownerFile, token);
				const time = new Date(now());
				utimesSync(ownerFile, time, time);
			} catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
			const owns = () => {
				try { return readFileSync(ownerFile, "utf8") === token; } catch (error) { if (missing(error)) return false; throw error; }
			};
			const heartbeat = setInterval(() => {
				try { if (owns()) { const time = new Date(now()); utimesSync(ownerFile, time, time); } } catch { /* Next lease check handles vanished locks. */ }
			}, 5_000);
			heartbeat.unref();
			return () => {
				clearInterval(heartbeat);
				if (owns()) rmSync(path, { recursive: true, force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		reap(path, now);
		if (attempt < 30) await delay(Math.min(100, 5 * (attempt + 1)));
	}
	throw new Error(`Timed out acquiring task lock: ${path}`);
}
