import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalResult, JournalStarted } from "./replay.ts";

export type JournalEvent = JournalResult | JournalStarted
	| { type: "launched"; scriptSha256?: string }
	| { type: "failed"; key: string; agentId: string }
	| { type: "restoring" | "restored" | "resumed" };
export interface JournalLoad {
	results: Map<string, JournalResult>;
	started: Map<string, JournalStarted[]>;
	failed: Set<string>;
	scriptSha256?: string;
	hasUnreadLine: boolean;
}
const keyPattern = /^v\d+:[0-9a-f]{64}$/;
export const MAX_JOURNAL_TAIL_BYTES = 16_384;
export interface JournalTail { text: string; truncated: boolean; bytesRead: number }
export interface JournalReader {
	readFile?(file: string): Promise<string>;
	readTail?(file: string, limit: number): Promise<JournalTail | undefined>;
}
/** Only append preparation uses this bounded read. Replay loading still reads history. */
export async function readJournalTail(file: string, limit = MAX_JOURNAL_TAIL_BYTES): Promise<JournalTail | undefined> {
	let handle;
	try { handle = await open(file, "r"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, limit);
		const buffer = Buffer.alloc(length);
		let bytesRead = 0;
		while (bytesRead < length) {
			const read = await handle.read(buffer, bytesRead, length - bytesRead, size - length + bytesRead);
			if (read.bytesRead === 0) break;
			bytesRead += read.bytesRead;
		}
		return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: size > length, bytesRead };
	} finally { await handle.close(); }
}

export class WorkflowJournal {
	readonly file: string;
	private tail: Promise<void> = Promise.resolve();
	private writerReady = false;
	private readonly reader: JournalReader;
	/** One exclusive writer per invocation, enforced by Workflow resume admission. */
	constructor(file: string, reader: JournalReader = {}) { this.file = file; this.reader = reader; }
	private async contents(): Promise<string | undefined> {
		try { return await (this.reader.readFile?.(this.file) ?? readFile(this.file, "utf8")); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async load(): Promise<JournalLoad> {
		await this.tail;
		const content = await this.contents();
		const loaded: JournalLoad = { results: new Map(), started: new Map(), failed: new Set(), hasUnreadLine: false };
		if (!content) return loaded;
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as JournalEvent;
				if (!event || typeof event !== "object") throw new Error("Invalid journal event");
				if (event.type === "launched") {
					if (event.scriptSha256 !== undefined && !/^[0-9a-f]{64}$/.test(event.scriptSha256)) throw new Error("Invalid script digest");
					loaded.scriptSha256 ??= event.scriptSha256;
				} else if (event.type === "started" || event.type === "result" || event.type === "failed") {
					if (!keyPattern.test(event.key) || typeof event.agentId !== "string" || !event.agentId) throw new Error("Invalid journal identity");
					if (event.type === "result") {
						if (!Object.hasOwn(event, "result")) throw new Error("Missing journal result");
						loaded.results.set(event.key, event);
					} else if (event.type === "started") loaded.started.set(event.key, [...(loaded.started.get(event.key) ?? []), event]);
					else loaded.failed.add(event.key);
				} else if (!["restoring", "restored", "resumed"].includes(event.type)) throw new Error("Unknown journal event");
			} catch {
				const lastTorn = index === lines.length - 1 && !content.endsWith("\n");
				const repairedTail = /^\s*\{\s*"type"\s*:\s*"resumed"\s*\}\s*$/.test(lines[index + 1] ?? "");
				if ((!lastTorn && !repairedTail) || line.includes("launched") || line.includes("scriptSha256")) loaded.hasUnreadLine = true;
			}
		}
		return loaded;
	}
	append(event: JournalEvent): Promise<void> {
		// Serialize before queueing, so callers cannot mutate an event awaiting I/O.
		const line = JSON.stringify(event);
		const operation = this.tail.then(async () => {
			let prefix = "";
			if (!this.writerReady) {
				await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
				const tail = await (this.reader.readTail ?? readJournalTail)(this.file, MAX_JOURNAL_TAIL_BYTES);
				if (tail?.text && !tail.text.endsWith("\n")) {
					const boundary = tail.text.lastIndexOf("\n");
					try {
						if (tail.truncated && boundary < 0) throw new Error("Final line exceeds bounded inspection");
						JSON.parse(tail.text.slice(boundary + 1));
						prefix = "\n";
					} catch { prefix = '\n{"type":"resumed"}\n'; }
				}
			}
			try {
				await appendFile(this.file, `${prefix}${line}\n`, { encoding: "utf8", mode: 0o600 });
				this.writerReady = true;
			} catch (error) {
				// A failed write may have left a partial tail. Reinspect on retry.
				this.writerReady = false;
				throw error;
			}
		});
		this.tail = operation.catch(() => undefined);
		return operation;
	}
	async restoreState(): Promise<"missing" | "partial" | "complete"> {
		await this.tail;
		const content = await this.contents();
		if (content === undefined) return "missing";
		const lines = content.split("\n").filter(Boolean);
		let restoring = false, restored = false;
		for (let i = 0; i < lines.length; i++) {
			try {
				const event = JSON.parse(lines[i]);
				if (i === 0 && event.type === "restoring") restoring = true;
				if (event.type === "restored") restored = true;
			} catch { /* load() separately diagnoses unread lines */ }
		}
		return restoring && !restored ? "partial" : "complete";
	}
}
