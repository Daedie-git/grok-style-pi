// Findings Claude rejected, per slot: the reviewer must hold its ground, and later diff reviews re-check them.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./state.ts";

export type RejectionStatus = "open" | "stands" | "withdrawn" | "overruled";
interface Rejection { id: string; text: string; status: RejectionStatus; reason?: string }

export class Rejections {
	private readonly file: string;
	constructor(dir: string, slotName: string) { this.file = join(dir, `${slotName}.rejections.jsonl`); }

	private read(): Rejection[] {
		if (!existsSync(this.file)) return [];
		return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Rejection);
	}

	// Every read-modify-write holds the lock, so concurrent rejections get distinct IDs and no update is lost.
	private async locked<T>(body: () => T): Promise<T> {
		const release = await acquireLock(`${this.file}.lock`, undefined, 20);
		try { return body(); } finally { release(); }
	}

	add(text: string): Promise<string> {
		return this.locked(() => {
			const id = `R${this.read().length + 1}`;
			appendFileSync(this.file, JSON.stringify({ id, text, status: "open" }) + "\n");
			return id;
		});
	}

	/** False when no rejection has this ID. */
	set(id: string, status: RejectionStatus, reason = ""): Promise<boolean> {
		return this.locked(() => {
			const all = this.read();
			if (!all.some((entry) => entry.id === id)) return false;
			const text = all.map((entry) => JSON.stringify(entry.id === id ? { ...entry, status, ...(reason ? { reason } : {}) } : entry)).join("\n") + "\n";
			writeFileSync(`${this.file}.tmp`, text);
			renameSync(`${this.file}.tmp`, this.file);
			return true;
		});
	}

	/** Rejections the reviewer has not withdrawn and Claude has not overruled, as list lines. */
	unsettled(): string {
		return this.read().filter((entry) => entry.status === "open" || entry.status === "stands")
			.map((entry) => `- ${entry.id} (${entry.status}): ${entry.text}`).join("\n");
	}

	/** Applies `R<n>: withdrawn|stands` verdicts from REPORT; returns the IDs still standing. */
	async apply(report: string): Promise<string[]> {
		if (!this.read().length) return [];
		const verdicts = new Map<string, "withdrawn" | "stands">();
		let fenced = false;
		for (const line of report.split("\n")) {
			if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
			const match = !fenced && /^\s*(?:[-*]\s+)?`?(R\d+): *(withdrawn|stands)/.exec(line);
			// Conflicting verdicts for one finding resolve to stands: a finding is withdrawn only unambiguously.
			if (match && (!verdicts.has(match[1]) || match[2] === "stands")) verdicts.set(match[1], match[2] as "withdrawn" | "stands");
		}
		for (const [id, verdict] of verdicts) await this.set(id, verdict);
		return [...verdicts].filter(([, verdict]) => verdict === "stands").map(([id]) => id);
	}
}

export function rejectionPrompt(id: string, text: string): string {
	return `# Claude rejected one of your findings (${id})

${text}

Re-check the finding against the current code. Concede only to evidence that refutes your failure scenario; agreement, authority or repetition is not evidence.
- If the rejection holds, start your report with \`${id}: withdrawn\` and name the evidence that convinced you.
- If it does not, start with \`${id}: stands\` and restate the failure scenario with a reproduction: the command and its output.`;
}
