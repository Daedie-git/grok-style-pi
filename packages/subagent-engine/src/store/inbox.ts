import { randomBytes } from "node:crypto";
import type { Envelope, EnvelopeState } from "../types.ts";
import { Journal, object } from "./journal.ts";

export type AcceptanceInput = Pick<Envelope, "acceptanceKey" | "from" | "to" | "text" | "summary" | "noticeKey" | "queued">;
const states: EnvelopeState[] = ["pending", "submitted", "persisted", "prepared", "included", "consumed", "refused"];

function valid(value: unknown): value is Envelope {
	return object(value) && ["id", "acceptanceKey", "from", "to", "text"].every(key => typeof value[key] === "string")
		&& states.includes(value.state as EnvelopeState) && typeof value.createdAt === "number"
		&& ["summary", "noticeKey", "runId", "refusedReason"].every(key => value[key] === undefined || typeof value[key] === "string")
		&& (value.queued === undefined || typeof value.queued === "boolean");
}

function samePayload(record: Envelope, input: AcceptanceInput): boolean {
	return record.from === input.from && record.to === input.to && record.text === input.text
		&& record.summary === input.summary && record.noticeKey === input.noticeKey && Boolean(record.queued) === Boolean(input.queued);
}

/**
 * Input for a new run: every waiting steer, or when there is none and `queueOpen`, the oldest queued task.
 * One queued task per run keeps each task's report separate.
 */
export function nextRunInput(undelivered: Envelope[], queueOpen: boolean): Envelope[] {
	const steers = undelivered.filter(record => !record.queued);
	if (steers.length > 0 || !queueOpen) return steers;
	return undelivered.filter(record => record.queued).slice(0, 1);
}

export class InboxStore {
	private readonly journal: Journal<Envelope>;
	private readonly records = new Map<string, Envelope>();
	private readonly acceptances = new Map<string, string>();

	constructor(file: string) {
		this.journal = new Journal(file);
		for (const record of this.journal.load(valid)) this.records.set(record.id, record);
		for (const record of this.records.values()) this.acceptances.set(record.acceptanceKey, record.id);
		this.journal.compact(this.records.values());
	}

	accept(input: AcceptanceInput): { envelope: Envelope; duplicate: boolean } | { conflict: true } {
		const id = this.acceptances.get(input.acceptanceKey);
		if (id !== undefined) {
			const record = this.records.get(id)!;
			return samePayload(record, input) ? { envelope: structuredClone(record), duplicate: true } : { conflict: true };
		}
		const envelope: Envelope = {
			id: `e${randomBytes(16).toString("hex")}`,
			acceptanceKey: input.acceptanceKey, from: input.from, to: input.to, text: input.text,
			createdAt: Date.now(), state: "pending",
			...(input.summary === undefined ? {} : { summary: input.summary }),
			...(input.noticeKey === undefined ? {} : { noticeKey: input.noticeKey }),
			...(input.queued ? { queued: true } : {}),
		};
		this.journal.append([envelope]);
		this.records.set(envelope.id, envelope);
		this.acceptances.set(envelope.acceptanceKey, envelope.id);
		return { envelope: structuredClone(envelope), duplicate: false };
	}

	/** Whether an envelope was accepted under this acceptance key (durable, survives restart). */
	hasAcceptance(acceptanceKey: string): boolean {
		return this.acceptances.has(acceptanceKey);
	}

	/** Whether this inbox owns the envelope (a forked session can carry an ancestor root's receipts). */
	has(id: string): boolean {
		return this.records.has(id);
	}

	setState(id: string, state: EnvelopeState, extra?: { runId?: string; refusedReason?: string }): void {
		if (!states.includes(state)) throw new Error(`Invalid envelope state: ${state}`);
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown envelope: ${id}`);
		// Requeueing before inclusion is intentional: selection/persistence is not delivery.
		const next: Envelope = { ...record, state };
		if (extra?.runId !== undefined) next.runId = extra.runId;
		if (extra?.refusedReason !== undefined) next.refusedReason = extra.refusedReason;
		if (state === "pending") {
			delete next.runId;
			delete next.refusedReason;
		}
		this.journal.append([next]);
		this.records.set(id, next);
	}

	/** Replace a queued envelope's text; the caller checks it has not started. */
	revise(id: string, text: string, summary?: string): void {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown envelope: ${id}`);
		const next: Envelope = { ...record, text };
		if (summary === undefined) delete next.summary;
		else next.summary = summary;
		this.journal.append([next]);
		this.records.set(id, next);
	}

	undelivered(): Envelope[] {
		return this.all().filter(record => !["included", "consumed", "refused"].includes(record.state));
	}

	all(): Envelope[] {
		return [...this.records.values()].map(record => structuredClone(record));
	}
}
