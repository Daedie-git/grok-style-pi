import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class StoreCorruptionError extends Error {
	readonly file: string;
	constructor(file: string, cause?: unknown) {
		super(`Corrupt subagent store: ${file}`, { cause });
		this.name = "StoreCorruptionError";
		this.file = file;
	}
}

export function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Replace without unlinking the destination: readers always see an entire version. */
export function atomicWrite(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, text, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		// Windows can transiently deny replacement while a scanner holds the target.
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(temp, file);
				break;
			} catch (error) {
				if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
			}
		}
	} finally {
		try { unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; }
	}
}

/** Full record snapshots are transitions; the last snapshot of each identity wins. */
export class Journal<T> {
	readonly file: string;
	constructor(file: string) { this.file = file; }

	load(valid: (value: unknown) => value is T): T[] {
		let text: string;
		try { text = readFileSync(this.file, "utf8"); } catch (error) {
			if (missing(error)) return [];
			throw error;
		}
		const lines = text.split("\n");
		// A record is committed only by its terminating newline.
		lines.pop();
		return lines.filter(line => line.trim()).map(line => {
			try {
				const value: unknown = JSON.parse(line);
				if (!valid(value)) throw new Error("Invalid journal record");
				return value;
			} catch (error) { throw new StoreCorruptionError(this.file, error); }
		});
	}

	compact(records: Iterable<T>): void {
		atomicWrite(this.file, Array.from(records, value => JSON.stringify(value) + "\n").join(""));
	}

	append(records: T[]): void {
		if (!records.length) return;
		mkdirSync(dirname(this.file), { recursive: true });
		const fd = openSync(this.file, "a", 0o600);
		try {
			writeFileSync(fd, records.map(value => JSON.stringify(value) + "\n").join(""), "utf8");
			fsyncSync(fd);
		} finally { closeSync(fd); }
	}
}

export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
