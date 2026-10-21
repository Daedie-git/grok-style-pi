import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentId, RunId } from "../types.ts";

function segment(value: string): string {
	if (!value || value === "." || value === ".." || /[\\/\0:]/.test(value)) {
		throw new Error("Invalid store path segment");
	}
	return value;
}

export function engineRoot(agentDir: string): string {
	return join(agentDir, "subagents");
}

export function sessionDir(agentDir: string, rootSessionId: string): string {
	return join(engineRoot(agentDir), segment(rootSessionId));
}

export function agentFiles(agentDir: string, rootSessionId: string, agentId: AgentId): { sessionFile: string; metaFile: string; inboxFile: string } {
	const base = join(sessionDir(agentDir, rootSessionId), `agent-${segment(agentId)}`);
	return { sessionFile: `${base}.jsonl`, metaFile: `${base}.meta.json`, inboxFile: `${base}.inbox.jsonl` };
}

export function newAgentId(): AgentId {
	return `a${randomBytes(8).toString("hex")}`;
}

export function newRunId(): RunId {
	return `r${randomBytes(8).toString("hex")}`;
}
