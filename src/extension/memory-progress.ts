import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MutationQueue } from "./memory-store.ts";

/** Private worker metadata only; never exposed as a model tool. */
export async function readMemoryProgress(path: string, signal: AbortSignal): Promise<Record<string, number>> {
	signal.throwIfAborted();
	if (await realpath(dirname(path)) !== dirname(path)) throw new Error("Unsafe memory metadata directory");
	let file;
	try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 200_000) throw new Error("Invalid memory progress file");
		const buffer = Buffer.alloc(200_001);
		let size = 0;
		while (size < buffer.length) {
			signal.throwIfAborted();
			const part = await file.read(buffer, size, buffer.length - size, size);
			if (!part.bytesRead) break;
			size += part.bytesRead;
		}
		if (size > 200_000) throw new Error("Memory progress file exceeded its read limit");
		const parsed: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid memory progress record");
		return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0));
	} finally { await file.close(); }
}

export async function writeMemoryProgress(path: string, data: Record<string, number>, queue: MutationQueue, signal: AbortSignal): Promise<void> {
	// Evicting old progress may cause harmless reinspection, never skipped input.
	const content = JSON.stringify(Object.fromEntries(Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 2000)));
	if (Buffer.byteLength(content) > 200_000) throw new Error("Memory progress record is too large");
	await queue(path, async () => {
		signal.throwIfAborted();
		if (await realpath(dirname(path)) !== dirname(path)) throw new Error("Unsafe memory metadata directory");
		const temporary = `${path}-${randomUUID()}`;
		const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			signal.throwIfAborted();
			await file.writeFile(content);
			await file.close();
			signal.throwIfAborted();
			if (await realpath(dirname(path)) !== dirname(path)) throw new Error("Unsafe memory metadata directory");
			await rename(temporary, path);
		} finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
	});
}
