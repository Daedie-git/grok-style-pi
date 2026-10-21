import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CompactionEntry, ContextEditEntry, SessionEntry, SessionHeader, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export interface ForkSnapshotInput {
	branch: SessionEntry[];
	spawningToolCallId: string;
	directive: string;
	childSessionId: string;
	cwd: string;
	parentSessionFile?: string;
	now: () => string;
}

type Call = { id: string; name: string };
function calls(entry: SessionEntry): Call[] {
	return entry.type === "message" && entry.message.role === "assistant"
		? entry.message.content.filter((block) => block.type === "toolCall") : [];
}

/** Identify broken groups in conversation order, not just by global call-id presence. */
function brokenGroups(entries: SessionEntry[]): Set<string> {
	const removed = new Set<string>();
	let group: { entry: SessionEntry; expected: Set<string>; results: SessionEntry[]; seen: Set<string> } | undefined;
	const finish = () => {
		if (group && group.seen.size !== group.expected.size) {
			removed.add(group.entry.id);
			for (const result of group.results) removed.add(result.id);
		}
		group = undefined;
	};
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant" || entry.message.role === "user") {
			finish();
			const expected = calls(entry);
			if (expected.length) {
				group = { entry, expected: new Set(expected.map((call) => call.id)), results: [], seen: new Set() };
				if (group.expected.size !== expected.length) throw new Error(`Duplicate tool call IDs in assistant entry ${entry.id}`);
			}
		} else if (entry.message.role === "toolResult") {
			const id = entry.message.toolCallId;
			if (!group || !group.expected.has(id) || group.seen.has(id)) removed.add(entry.id);
			else { group.results.push(entry); group.seen.add(id); }
		}
	}
	finish();
	return removed;
}

/** Mirror Pi's latest-compaction selection without following not-yet-rechained parents. */
function contextRange(entries: SessionEntry[]): SessionEntry[] {
	const index = entries.findLastIndex((entry) => entry.type === "compaction");
	if (index < 0) return entries;
	const compaction = entries[index] as CompactionEntry;
	const first = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	return [compaction, ...(first >= 0 && first < index ? entries.slice(first, index).filter((entry) =>
		entry.type !== "compaction" && !(entry.type === "message" && entry.message.role === "system")) : []), ...entries.slice(index + 1)];
}

export function buildForkEntries(input: ForkSnapshotInput): { header: SessionHeader; entries: SessionEntry[]; removed: string[] } {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(input.childSessionId)) throw new Error("Invalid child session ID");
	const timestamp = input.now();
	const milliseconds = Date.parse(timestamp);
	if (!Number.isFinite(milliseconds)) throw new Error("Invalid fork timestamp");
	const branch = structuredClone(input.branch);
	const used = new Set<string>();
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (!entry.id || used.has(entry.id)) throw new Error(`Missing or duplicate entry ID: ${entry.id}`);
		if (entry.parentId !== (branch[i - 1]?.id ?? null)) throw new Error(`Fork input is not a root-to-leaf branch at ${entry.id}`);
		used.add(entry.id);
	}
	const spawners = branch.filter((entry) => calls(entry).some((call) => call.id === input.spawningToolCallId));
	if (spawners.length !== 1) throw new Error("Fork requires exactly one spawning assistant entry");
	const spawning = spawners[0] as SessionMessageEntry;
	const spawningCalls = calls(spawning);
	if (new Set(spawningCalls.map((call) => call.id)).size !== spawningCalls.length) throw new Error("Duplicate spawning tool call IDs");
	const spawningIds = new Set(spawningCalls.map((call) => call.id));
	const removed = new Set<string>([spawning.id]);
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "toolResult" && spawningIds.has(entry.message.toolCallId)) removed.add(entry.id);
	}

	const edits = new Map<string, ContextEditEntry>();
	for (const entry of branch) if (entry.type === "context_edit") { edits.set(entry.targetId, entry); removed.add(entry.id); }
	let entries = branch.filter((entry) => !removed.has(entry.id)).filter((entry) => {
		const edit = edits.get(entry.id);
		if (!edit) return true;
		if (edit.replacement === null) { removed.add(entry.id); return false; }
		if (entry.type === "custom_message") entry.content = edit.replacement.content as typeof entry.content;
		else if (entry.type === "message" && ["user", "assistant", "toolResult", "custom"].includes(entry.message.role)) {
			const content = (entry.message.role === "assistant" || entry.message.role === "toolResult") && typeof edit.replacement.content === "string"
				? [{ type: "text" as const, text: edit.replacement.content }] : edit.replacement.content;
			entry.message = { ...entry.message, content } as typeof entry.message;
		}
		return true;
	});
	const originalIndex = new Map(branch.map((entry, index) => [entry.id, index]));

	// Compaction policy: discard obsolete broken checkpoints. If the latest
	// checkpoint loses its anchor, move that checkpoint to the chain head with
	// a self anchor (Pi's retain-none form), followed by the surviving original
	// retained range and suffix. Discard summarized history and older checkpoints
	// so none can supersede the materialized summary. Preserve model/effort state.
	for (;;) {
		const previousLength = entries.length;
		const latest = entries.findLastIndex((entry) => entry.type === "compaction");
		const ids = new Set(entries.map((entry) => entry.id));
		const broken = (entry: CompactionEntry): boolean => {
			const anchor = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
			return !ids.has(entry.firstKeptEntryId) || anchor > entries.indexOf(entry);
		};
		if (latest >= 0 && broken(entries[latest] as CompactionEntry)) {
			const checkpoint = entries[latest] as CompactionEntry;
			const boundary = originalIndex.get(checkpoint.firstKeptEntryId);
			const checkpointIndex = originalIndex.get(checkpoint.id)!;
			const keepFrom = boundary !== undefined && boundary < checkpointIndex ? boundary : checkpointIndex + 1;
			const settings = entries.filter((entry) => (originalIndex.get(entry.id) ?? Infinity) < keepFrom && (entry.type === "model_change" || entry.type === "thinking_level_change"));
			const suffix = entries.filter((entry) => {
				const index = originalIndex.get(entry.id) ?? Infinity;
				return entry.id !== checkpoint.id && entry.type !== "compaction" && index >= keepFrom &&
					!(index < checkpointIndex && entry.type === "message" && entry.message.role === "system");
			});
			const survivors = new Set([checkpoint.id, ...settings.map((entry) => entry.id), ...suffix.map((entry) => entry.id)]);
			for (const entry of entries) if (!survivors.has(entry.id)) removed.add(entry.id);
			checkpoint.firstKeptEntryId = checkpoint.id;
			entries = [checkpoint, ...settings, ...suffix];
		} else {
			entries = entries.filter((entry) => {
				if (entry.type !== "compaction" || !broken(entry)) return true;
				removed.add(entry.id);
				return false;
			});
		}
		const bad = new Set([...brokenGroups(entries), ...brokenGroups(contextRange(entries))]);
		if (!bad.size) {
			// Dropping an obsolete checkpoint can itself remove the latest
			// checkpoint's anchor. Normalize again before declaring stability.
			if (entries.length !== previousLength) continue;
			break;
		}
		for (const id of bad) removed.add(id);
		entries = entries.filter((entry) => !bad.has(entry.id));
	}

	const newId = (): string => {
		let id: string;
		do { id = randomUUID(); } while (used.has(id));
		used.add(id);
		return id;
	};
	entries.push({ ...spawning, id: newId(), timestamp });
	for (const call of spawningCalls) entries.push({
		type: "message", id: newId(), parentId: null, timestamp,
		message: { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false,
			content: [{ type: "text", text: "Fork snapshot placeholder: this call's real output is not part of the inherited context." }],
			details: { forkPlaceholder: true }, timestamp: milliseconds },
	});
	entries.push({ type: "message", id: newId(), parentId: null, timestamp, message: { role: "user", content: input.directive, timestamp: milliseconds } });
	// Rechain only after partitioning, edits, group repair, compaction and appends.
	entries = entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null }));
	const header: SessionHeader = { type: "session", version: 3, id: input.childSessionId, timestamp, cwd: input.cwd,
		...(input.parentSessionFile ? { parentSession: input.parentSessionFile } : {}) };
	return { header, entries, removed: [...removed] };
}

export function writeForkSession(file: string, built: ReturnType<typeof buildForkEntries>): void {
	const serialized = [built.header, ...built.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	mkdirSync(dirname(file), { recursive: true });
	// Exclusive creation protects the canonical session (including an existing
	// parent) against accidental overwrite. Never remove a file we did not create.
	const fd = openSync(file, "wx");
	try {
		writeFileSync(fd, serialized, "utf8");
	} catch (error) {
		closeSync(fd);
		unlinkSync(file);
		throw error;
	}
	closeSync(fd);
}
