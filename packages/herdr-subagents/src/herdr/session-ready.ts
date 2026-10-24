import { buildSessionContext, CURRENT_SESSION_VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function content(value: unknown, assistant = false): boolean {
	if (typeof value === "string") return !assistant;
	return Array.isArray(value) && value.every((block) => {
		if (!object(block)) return false;
		switch (block.type) {
			case "text": return typeof block.text === "string";
			case "image": return !assistant && typeof block.data === "string" && typeof block.mimeType === "string";
			case "thinking": return assistant && (typeof block.thinking === "string" || block.redacted === true);
			case "toolCall": return assistant && typeof block.id === "string" && typeof block.name === "string" && object(block.arguments);
			default: return false;
		}
	});
}

function message(value: unknown): boolean {
	if (!object(value) || typeof value.role !== "string" || !value.role || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
	switch (value.role) {
		case "assistant":
			return content(value.content, true) && typeof value.api === "string" && typeof value.provider === "string"
				&& typeof value.model === "string" && object(value.usage) && object(value.usage.cost)
				&& ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(value.stopReason));
		case "toolResult":
			return Array.isArray(value.content) && content(value.content) && typeof value.toolCallId === "string"
				&& typeof value.toolName === "string" && typeof value.isError === "boolean";
		case "system":
			return content(value.content) && (value.sections === undefined || object(value.sections))
				&& (value.toolsAdded === undefined || Array.isArray(value.toolsAdded))
				&& (value.toolsRemoved === undefined || Array.isArray(value.toolsRemoved));
		case "user": return content(value.content);
		case "custom": return typeof value.customType === "string" && typeof value.display === "boolean" && content(value.content);
		case "bashExecution": return typeof value.command === "string" && typeof value.output === "string"
			&& typeof value.cancelled === "boolean" && typeof value.truncated === "boolean";
		case "branchSummary": case "compactionSummary": return typeof value.summary === "string";
		// Hosts can augment AgentMessage with their own roles. The public context builder remains authoritative.
		default: return true;
	}
}

function entryPayload(entry: Record<string, unknown>, ids: Set<string>): boolean {
	switch (entry.type) {
		case "message": return message(entry.message);
		case "compaction": return typeof entry.summary === "string" && typeof entry.tokensBefore === "number"
			&& Number.isFinite(entry.tokensBefore) && typeof entry.firstKeptEntryId === "string"
			&& (entry.firstKeptEntryId === entry.id || ids.has(entry.firstKeptEntryId))
			&& (entry.systemMessage === undefined || (object(entry.systemMessage) && entry.systemMessage.role === "system" && message(entry.systemMessage)));
		case "context_edit": return typeof entry.targetId === "string" && ids.has(entry.targetId)
			&& (entry.replacement === null || (object(entry.replacement) && (content(entry.replacement.content) || content(entry.replacement.content, true))));
		case "branch_summary": return typeof entry.summary === "string" && (entry.fromId === null || typeof entry.fromId === "string");
		case "custom_message": return typeof entry.customType === "string" && typeof entry.display === "boolean" && content(entry.content);
		case "custom": return typeof entry.customType === "string";
		case "model_change": return typeof entry.provider === "string" && typeof entry.modelId === "string";
		case "thinking_level_change": return typeof entry.thinkingLevel === "string";
		case "usage": return typeof entry.kind === "string" && typeof entry.provider === "string" && typeof entry.model === "string" && object(entry.usage);
		case "label": return typeof entry.targetId === "string" && (entry.label === undefined || typeof entry.label === "string");
		case "session_info": return entry.name === undefined || typeof entry.name === "string";
		default: return false;
	}
}

/** Read-only validation: never opens a writable manager or migrates a live child's session file. */
export function piSessionReady(text: string, expected: { sessionId?: string; cwd: string }): boolean {
	try {
		const [header, ...entries]: unknown[] = text.trim().split("\n").map((line) => JSON.parse(line));
		if (!object(header) || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION
			|| typeof header.id !== "string" || header.id !== expected.sessionId || header.cwd !== expected.cwd) return false;
		const ids = new Set<string>();
		for (const entry of entries) {
			if (!object(entry) || typeof entry.type !== "string" || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
				|| typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))
				|| (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
				|| !entryPayload(entry, ids)) return false;
			ids.add(entry.id);
		}
		// This is the same exported reconstruction used by SessionManager, without writes or resource discovery.
		return buildSessionContext(entries as SessionEntry[]).messages.every(message);
	} catch { return false; }
}
