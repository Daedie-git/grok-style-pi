import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { RecentMemorySession } from "./automatic-memory.ts";
import { memoryHistoryConversation } from "./memory-context.ts";

type ListedSession = { id: string; path: string; modified: Date };

/** Read bounded tails only from the public session listing for this launch directory. */
export async function recentMemorySessions(sessions: readonly ListedSession[], since: number, currentId: string, signal: AbortSignal, processed: Readonly<Record<string, number>> = {}): Promise<RecentMemorySession[]> {
	const result: RecentMemorySession[] = [];
	for (const session of sessions.filter(item => item.id !== currentId && item.modified.getTime() > Math.max(since, processed[item.id] ?? 0)).sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, 10)) {
		signal.throwIfAborted();
		try {
			// Refuse aliased parent directories and leaf links, not merely special files.
			if (await realpath(dirname(session.path)) !== dirname(session.path)) continue;
			const stat = await lstat(session.path);
			if (stat.isSymbolicLink() || !stat.isFile()) continue;
			const file = await open(session.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const opened = await file.stat();
				if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) continue;
				const start = Math.max(0, opened.size - 100_000);
				const buffer = Buffer.alloc(Math.min(opened.size, 100_000));
				let size = 0;
				while (size < buffer.length) {
					signal.throwIfAborted();
					const part = await file.read(buffer, size, buffer.length - size, start + size);
					if (!part.bytesRead) break;
					size += part.bytesRead;
				}
				const lines = buffer.subarray(0, size).toString("utf8").split("\n");
				if (start) lines.shift();
				const entries = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
				const text = memoryHistoryConversation(entries);
				if (text) result.push({ id: session.id, modified: session.modified.getTime(), text });
			} finally { await file.close(); }
		} catch { signal.throwIfAborted(); /* A vanished or unreadable old session is not fatal. */ }
	}
	return result;
}
