// Role instructions for sidecars: the shared protocol, how this backend asks a question, then the role file.
import { readFileSync } from "node:fs";
import type { Backend, Role } from "./state.ts";

const SIDECAR_HOME = new URL("../sidecar/", import.meta.url);

const PROTOCOL = `# Sidecar protocol

You are a persistent sidecar for a Claude Code agent working for the same user. You keep context across requests.

- Each request arrives as a user message. Do the work within your turn; your final reply is the report, and only it reaches Claude. Write it as complete Markdown.
- Messages starting with \`[note]\` share context on ongoing work. Absorb them and reply \`noted\`.
- Messages starting with \`# Answer from Claude\` answer a question you asked; continue the original task to completion.
- Steering messages arrive while you work. Apply them to the current task; your report for it reflects the change.
- The human may also talk to you directly in this pane. Answer them normally.
- Read the repository's applicable instructions before working. Never discard unrelated changes. Keep scratch output under a project \`captures/\` directory and set \`TMPDIR\` there.`;

const ASK = {
	pi: "If only Claude or the user can resolve a blocker, call needs_answer with the work state and ONE concrete question instead of finishing.",
	claude: "If only Claude or the user can resolve a blocker, end your reply with a final line `NEEDS_ANSWER: <one concrete question>` after the work state.",
};

export function roleInstructions(role: Role, backend: Backend): string {
	const file = readFileSync(new URL(`${role}.md`, SIDECAR_HOME), "utf8");
	return [PROTOCOL, ASK[backend], file.trim()].join("\n\n");
}

/** A Fleet profile's prompt replaces the role guidance and is always last. */
export function profileInstructions(prompt: string): string {
	return [PROTOCOL, ASK.pi, prompt].join("\n\n");
}

export function answerPrompt(text: string): string {
	return `# Answer from Claude\n\nYou were blocked and asked a question. Answer: ${text}\n\nContinue that original task to completion with this answer; do not restart finished work.`;
}

export function notePrompt(text: string): string {
	return `[note] ${text}`;
}

/** Claude Code children cannot call needs_answer, so a question is the final line of their report. */
export function claudeQuestion(report: string): { report: string; question?: string } {
	const match = /\n?^NEEDS_ANSWER:[ \t]*(.+)\s*$/m.exec(report.trimEnd());
	if (!match || match.index + match[0].length < report.trimEnd().length) return { report };
	return { report: report.slice(0, match.index).trimEnd(), question: match[1].trim() };
}
