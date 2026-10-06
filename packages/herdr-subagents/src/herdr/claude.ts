import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { HerdrStore, HerdrTask, Command } from "./store.ts";

export interface ClaudeHookInput {
	session_id: string;
	/** Native Claude subagents share the session but have their own tool batches. */
	agent_id?: string;
	hook_event_name: string;
	prompt?: string;
	last_assistant_message?: string;
	error?: string;
	error_details?: string;
	notification_type?: string;
	tool_name?: string;
	tool_input?: unknown;
}

// Claude can wrap large bracketed pastes in <pasted_content>; marker position is not stable.
export const CLAUDE_MARKER = /<!-- grok-claude:([a-f0-9-]+):([a-f0-9-]+) -->\r?\n/;
export const CLAUDE_START_TIMEOUT_MS = 300_000;

/** PermissionRequest has no tool_use_id, so correlate on canonical tool name/input instead. */
export function claudeActorPrefix(input: ClaudeHookInput): string {
	return `${createHash("sha256").update(input.agent_id ?? "").digest("hex")}:`;
}

export function claudePermissionKey(input: ClaudeHookInput): string {
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
		return value;
	};
	return createHash("sha256").update(JSON.stringify([input.tool_name ?? "", canonical(input.tool_input ?? null)])).digest("hex");
}

export function claudePrompt(command: Command): string {
	return `<!-- grok-claude:${command.runId}:${command.id} -->\n${command.text}`;
}

const TOOL_NAMES: Record<string, string> = {
	read: "Read", bash: "Bash", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "Glob",
};

export function claudeTools(tools: string[]): string[] {
	return [...new Set(tools.map((tool) => {
		const mapped = TOOL_NAMES[tool];
		if (!mapped) throw new Error(`Claude Code cannot enforce the Pi tool allow-list entry '${tool}'. Use read, bash, edit, write, grep, find, or ls.`);
		return mapped;
	}))];
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Native interactive Claude; no permission bypass, print-mode subprocess, or transcript scraping. */
export function claudeArgs(task: HerdrTask, sessionId: string, root: string): string[] {
	const command = [process.execPath, fileURLToPath(new URL("./claude-hook-entry.mjs", import.meta.url)), root, task.id].map(quote).join(" ");
	const hooks = Object.fromEntries([
		"UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Stop", "StopFailure", "SessionEnd", "Notification",
	].map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 10 }] }]]));
	const args = ["--session-id", sessionId, "--settings", JSON.stringify({ hooks }), "--name", task.id];
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--effort", task.thinking);
	// Herdr rejects newlines in launch arguments. Agent Markdown is already carried in taskMessage.
	if (task.allowedTools) args.push("--tools", claudeTools(task.allowedTools).join(","), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands");
	return args;
}

/** Input hooks fail closed. Other hook errors stay visible and never fabricate a successful result. */
export async function handleClaudeHook(store: HerdrStore, agentId: string, input: ClaudeHookInput): Promise<Record<string, unknown> | undefined> {
	const accepted = await store.claudeHook(agentId, input, Date.now());
	if (!accepted && input.hook_event_name === "UserPromptSubmit" && input.prompt?.includes("<!-- grok-claude:")) {
		return { decision: "block", reason: "This Herdr subagent command is expired, cancelled, or belongs to a different Claude session." };
	}
	return undefined;
}
