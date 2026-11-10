export type MemoryEntry = { id?: string; type: string; message?: { role: string; content?: unknown } };
export type MemoryCursor = { entryId?: string; offset?: number };
export const MEMORY_INPUT_UNITS = 80_000;

function prose(entry: MemoryEntry): string {
	if (!entry || entry.type !== "message" || !entry.message || !["user", "assistant"].includes(entry.message.role)) return "";
	const content = entry.message.content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
}

/** Oldest unprocessed prose first. The cursor covers exactly the supplied text, including partial entries. */
export function memoryChunk(entries: readonly MemoryEntry[], cursor: MemoryCursor = {}, limit = MEMORY_INPUT_UNITS): { text: string; cursor: MemoryCursor; pending: boolean } {
	if (!Number.isSafeInteger(limit) || limit < 100) throw new Error("Memory chunk budget must be at least 100 units");
	const found = cursor.entryId ? entries.findIndex(entry => entry.id === cursor.entryId) : -1;
	const start = found < 0 ? 0 : found + (cursor.offset === undefined ? 1 : 0);
	let next = { ...cursor };
	let result = "";
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		const text = prose(entry);
		const offset = index === found ? cursor.offset ?? 0 : 0;
		if (!text || offset >= text.length) { if (entry?.id) next = { entryId: entry.id }; continue; }
		const prefix = `${result ? "\n\n" : ""}${entry.message!.role}${offset ? " (continued)" : ""}: `;
		const room = limit - result.length - prefix.length;
		if (room < 2) return { text: result, cursor: next, pending: true };
		let end = Math.min(text.length, offset + room);
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
		result += prefix + text.slice(offset, end);
		next = { entryId: entry.id, ...(end < text.length ? { offset: end } : {}) };
		if (end < text.length) return { text: result, cursor: next, pending: true };
	}
	return { text: result, cursor: next, pending: false };
}

/** Prose-only bounded preview; extraction uses memoryChunk's corresponding cursor instead. */
export function memoryConversation(entries: readonly MemoryEntry[]): string { return memoryChunk(entries).text; }

/** All prose from an already byte-bounded transcript tail; caller chunks it for model requests. */
export function memoryHistoryConversation(entries: readonly MemoryEntry[]): string {
	return entries.flatMap(entry => {
		const text = prose(entry);
		return text ? [`${entry.message!.role}: ${text}`] : [];
	}).join("\n\n");
}

export type MemorySessionText = { id: string; modified: number; text: string };
/** Preserve newest-first ordering AND every supplied session; never tail-slice an opaque concatenation. */
export function consolidationChunks(sessions: readonly MemorySessionText[]): string[] {
	const chunks: string[] = [];
	for (const session of [...sessions].sort((a, b) => b.modified - a.modified)) {
		const header = `Session ${JSON.stringify(session.id).slice(0, 1000)}, modified ${new Date(session.modified).toISOString()}`;
		for (let offset = 0; offset < session.text.length;) {
			const prefix = `${header}${offset ? " (continued)" : ""}\n`;
			let end = Math.min(session.text.length, offset + MEMORY_INPUT_UNITS - prefix.length);
			if (end < session.text.length && /[\uD800-\uDBFF]/.test(session.text[end - 1]) && /[\uDC00-\uDFFF]/.test(session.text[end])) end--;
			chunks.push(prefix + session.text.slice(offset, end));
			offset = end;
		}
	}
	return chunks;
}
