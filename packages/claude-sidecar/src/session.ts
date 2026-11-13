// SessionStart: sidecars belong to the Claude pane, so a conversation that continues under a new transcript
// (/clear) hands them over. The pane's last transcript is recorded under the state dir to know the previous one.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionStartInput { sessionId?: string; transcript?: string; source?: string }

export function parseSessionStart(text: string): SessionStartInput {
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		const string = (key: string) => typeof value[key] === "string" && value[key] ? value[key] as string : undefined;
		return { sessionId: string("session_id"), transcript: string("transcript_path"), source: string("source") };
	} catch { return {}; }
}

const transcriptFile = (dir: string, owner: string) => join(dir, "runner", `${owner}.transcript`);

/** The transcript recorded for the pane, if any. */
export function recordedTranscript(dir: string, owner: string): string | undefined {
	try { return readFileSync(transcriptFile(dir, owner), "utf8").trim() || undefined; } catch { return undefined; }
}

export function recordTranscript(dir: string, owner: string, transcript: string): void {
	const file = transcriptFile(dir, owner);
	mkdirSync(join(dir, "runner"), { recursive: true });
	writeFileSync(`${file}.tmp`, `${transcript}\n`);
	renameSync(`${file}.tmp`, file);
}
