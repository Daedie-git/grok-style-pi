import type { NoticeRecord, NoticeState } from "../types.ts";
import { Journal, object } from "./journal.ts";

const states: NoticeState[] = ["pending", "submitted", "persisted", "acknowledged"];
const kinds = ["interim_handback", "terminal_result", "terminal_failure", "stopped", "delivery_refusal"];

function valid(value: unknown): value is NoticeRecord {
	return object(value) && ["key", "rootSessionId", "agentId", "runId", "destination"].every(key => typeof value[key] === "string")
		&& kinds.includes(value.kind as string) && states.includes(value.state as NoticeState)
		&& Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0
		&& typeof value.createdAt === "number" && typeof value.passive === "boolean" && object(value.payload)
		&& value.key === `${value.rootSessionId}:${value.agentId}:${value.runId}:${value.kind}:${value.sequence}`;
}

export class Outbox {
	private readonly journal: Journal<NoticeRecord>;
	private readonly records = new Map<string, NoticeRecord>();

	constructor(file: string) {
		this.journal = new Journal(file);
		for (const record of this.journal.load(valid)) this.records.set(record.key, record);
		for (const record of this.records.values()) {
			if (record.state === "submitted") record.state = "pending";
		}
		this.journal.compact(this.records.values());
	}

	create(input: Omit<NoticeRecord, "key" | "sequence" | "state" | "createdAt">): NoticeRecord {
		let sequence = 1;
		for (const record of this.records.values()) {
			if (record.agentId !== input.agentId || record.runId !== input.runId || record.rootSessionId !== input.rootSessionId) continue;
			if (record.kind === input.kind && record.state !== "acknowledged") return structuredClone(record);
			sequence = Math.max(sequence, record.sequence + 1);
		}
		const record: NoticeRecord = structuredClone({
			...input, sequence, state: "pending", createdAt: Date.now(),
			key: `${input.rootSessionId}:${input.agentId}:${input.runId}:${input.kind}:${sequence}`,
		});
		this.journal.append([record]);
		this.records.set(record.key, record);
		return structuredClone(record);
	}

	pending(destination?: string): NoticeRecord[] {
		return [...this.records.values()].filter(record => record.state === "pending" && (destination === undefined || record.destination === destination)).map(record => structuredClone(record));
	}

	mark(keys: string[], state: NoticeState): void {
		if (!states.includes(state)) throw new Error(`Invalid notice state: ${state}`);
		const changes: NoticeRecord[] = [];
		for (const key of new Set(keys)) {
			const record = this.records.get(key);
			// Failed submissions may be retried; persisted receipts must not regress.
			if (record && (states.indexOf(state) > states.indexOf(record.state)
				|| (record.state === "submitted" && state === "pending"))) changes.push({ ...record, state });
		}
		this.journal.append(changes);
		for (const record of changes) this.records.set(record.key, record);
	}

	/** Records whose destination handoff may have been interrupted: persisted (root), or not yet acknowledged for an owner. */
	unfinished(): { key: string; destination: string; state: string }[] {
		const result: { key: string; destination: string; state: string }[] = [];
		for (const record of this.records.values()) {
			if (record.state === "persisted" || (record.destination !== "root" && record.state !== "acknowledged")) result.push({ key: record.key, destination: record.destination, state: record.state });
		}
		return result;
	}

	/** Whether any notice of this run already reached its destination durably (acknowledged). */
	acknowledgedRun(agentId: string, runId: string): boolean {
		for (const record of this.records.values()) if (record.agentId === agentId && record.runId === runId && record.state === "acknowledged") return true;
		return false;
	}

	observePersisted(entries: { type: string; customType?: string; details?: unknown }[]): string[] {
		const keys = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "custom_message" || entry.customType !== "subagent-notification" || !object(entry.details) || !Array.isArray(entry.details.noticeKeys)) continue;
			for (const key of entry.details.noticeKeys) {
				// Only records that have not already reached persisted/acknowledged advance; history is not re-reported.
				const state = typeof key === "string" ? this.records.get(key)?.state : undefined;
				if (state === "pending" || state === "submitted") keys.add(key as string);
			}
		}
		this.mark([...keys], "persisted");
		return [...keys];
	}

	recover(): void {
		const changes = [...this.records.values()].filter(record => record.state === "submitted").map(record => ({ ...record, state: "pending" as const }));
		this.journal.append(changes);
		for (const record of changes) this.records.set(record.key, record);
	}

	/** Identity of a notice without cloning its payload. */
	identity(key: string): { agentId: string; runId: string; destination: string } | undefined {
		const record = this.records.get(key);
		return record && { agentId: record.agentId, runId: record.runId, destination: record.destination };
	}

	get(key: string): NoticeRecord | undefined {
		const record = this.records.get(key);
		return record && structuredClone(record);
	}
}
