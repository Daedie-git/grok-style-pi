import type { AgentDefinition, DefinitionSource, HookConfig, HookEventName, HookMatcherGroup, McpServerSpec } from "../types.ts";
import { commaList, isMapping, parseYaml } from "./yaml.ts";

export interface DefinitionOrigin { source: DefinitionSource; path?: string; namespace?: string }
export interface ParseResult { definition?: AgentDefinition; error?: string }

const hookEvents = new Set<string>(["SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"]);

function hooks(value: unknown, diagnostics: string[]): HookConfig | undefined {
	if (!isMapping(value)) { diagnostics.push("hooks must be a mapping"); return; }
	const result: HookConfig = {};
	for (const [event, groups] of Object.entries(value)) {
		if (!hookEvents.has(event) || !Array.isArray(groups)) { diagnostics.push(`Unsupported hook event or invalid groups: ${event}`); continue; }
		const accepted: HookMatcherGroup[] = [];
		for (const group of groups) {
			if (!isMapping(group) || !Array.isArray(group.hooks) || (group.matcher !== undefined && typeof group.matcher !== "string")) {
				diagnostics.push(`Invalid hook group for ${event}`); continue;
			}
			const commands: HookMatcherGroup["hooks"] = [];
			for (const command of group.hooks) {
				if (!isMapping(command) || command.type !== "command" || typeof command.command !== "string" || !command.command.trim()
					|| (command.args !== undefined && (!Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string")))
					|| (command.timeout !== undefined && (typeof command.timeout !== "number" || !Number.isFinite(command.timeout) || command.timeout <= 0))) {
					diagnostics.push(`Unsupported or invalid hook for ${event}; only command hooks are supported`); continue;
				}
				commands.push({ type: "command", command: command.command, ...(command.args === undefined ? {} : { args: command.args as string[] }), ...(command.timeout === undefined ? {} : { timeout: command.timeout as number }) });
			}
			if (commands.length) accepted.push({ ...(group.matcher === undefined ? {} : { matcher: group.matcher as string }), hooks: commands });
		}
		result[event as HookEventName] = accepted;
	}
	return result;
}

/** Shared validation for Markdown files and the --agents JSON source. */
export function parseDefinitionData(data: unknown, prompt: string, origin: DefinitionOrigin): ParseResult {
	if (!isMapping(data)) return { error: "Definition frontmatter must be a mapping" };
	if (typeof data.name !== "string" || !data.name.trim()) return { error: "name is required and must be a nonempty string" };
	if (typeof data.description !== "string" || !data.description.trim()) return { error: "description is required and must be a nonempty string" };
	const name = data.name.trim();
	if (name.startsWith("-") || name.includes(":") || name.length > 64) return { error: `Invalid agent name: ${name} (no leading '-', colons, or more than 64 characters)` };
	if (origin.source === "package" && (!origin.namespace?.trim() || /\s/.test(origin.namespace))) return { error: "Package definitions require a nonempty namespace without whitespace" };
	const diagnostics: string[] = [];
	const definition: AgentDefinition = {
		agentType: origin.source === "package" ? `${origin.namespace}:${name}` : name,
		description: data.description.trim(), prompt: prompt.replace(/^\uFEFF/, "").trim(), source: origin.source,
		...(origin.path === undefined ? {} : { path: origin.path }),
		disallowedTools: [], skills: [], diagnostics,
	};
	const list = (key: string): string[] | undefined => {
		const value = data[key];
		if (value === undefined) return;
		if (typeof value === "string") {
			try { return commaList(value); } catch (error) { diagnostics.push(`${key}: ${String(error)}`); return; }
		}
		if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.map((item) => item.trim()).filter(Boolean);
		diagnostics.push(`${key} must be a string or a list of strings`);
	};
	definition.tools = list("tools");
	definition.disallowedTools = list("disallowedTools") ?? [];
	definition.skills = list("skills") ?? [];
	for (const key of ["model", "color", "permissionMode"] as const) {
		if (data[key] === undefined) continue;
		if (origin.source === "package" && key === "permissionMode") { diagnostics.push("Package permissionMode is ignored"); continue; }
		if (typeof data[key] !== "string") { diagnostics.push(`${key} must be a string`); continue; }
		definition[key] = data[key].trim();
	}
	if (definition.model?.toLowerCase() === "inherit") definition.model = "inherit";
	const effort = data.effort ?? data.thinking;
	if (effort !== undefined) {
		if (typeof effort === "string") definition.effort = effort.trim();
		else diagnostics.push("effort/thinking must be a string");
	}
	for (const key of ["background", "omitClaudeMd"] as const) {
		if (data[key] === undefined) continue;
		if (typeof data[key] === "boolean") definition[key] = data[key];
		else diagnostics.push(`${key} must be a boolean`);
	}
	const maxTurns = data.maxTurns ?? data.max_turns;
	if (maxTurns !== undefined) {
		if (typeof maxTurns === "number" && Number.isSafeInteger(maxTurns) && maxTurns > 0) definition.maxTurns = maxTurns;
		else diagnostics.push("maxTurns must be a positive integer");
	}
	if (data.extensions === false || data.isolated === true) definition.isolated = true;
	if (data.isolation !== undefined) {
		if (data.isolation === "worktree") definition.isolation = "worktree";
		else diagnostics.push(`Unsupported isolation: ${String(data.isolation)}; only worktree is supported`);
	}
	if (data.memory !== undefined) {
		if (data.memory === "user" || data.memory === "project" || data.memory === "local") definition.memory = data.memory;
		else diagnostics.push("memory must be user, project or local");
	}
	if (definition.permissionMode !== undefined) diagnostics.push("permissionMode is unsupported by Pi and has no effect");
	for (const key of ["hooks", "mcpServers"] as const) {
		if (data[key] === undefined) continue;
		if (origin.source === "package") { diagnostics.push(`Package ${key} is ignored`); continue; }
		if (key === "hooks") { definition.hooks = hooks(data.hooks, diagnostics); continue; }
		const value = data.mcpServers;
		let entries: unknown[];
		if (typeof value === "string") entries = commaList(value);
		else if (Array.isArray(value)) entries = value;
		else if (isMapping(value)) entries = Object.entries(value).map(([name, config]) => ({ [name]: config }));
		else { diagnostics.push("mcpServers must be names or inline server objects"); continue; }
		const servers: McpServerSpec[] = [];
		for (const entry of entries) {
			if (typeof entry === "string" && entry.trim()) { servers.push(entry.trim()); continue; }
			if (isMapping(entry)) {
				if (typeof entry.name === "string" && isMapping(entry.config)) { servers.push({ name: entry.name, config: entry.config }); continue; }
				const pairs = Object.entries(entry);
				if (pairs.length === 1 && isMapping(pairs[0][1])) { servers.push({ name: pairs[0][0], config: pairs[0][1] }); continue; }
			}
			diagnostics.push("Invalid mcpServers entry; expected a name or named configuration mapping");
		}
		definition.mcpServers = servers;
	}
	return { definition };
}

export function parseDefinitionFile(text: string, origin: DefinitionOrigin): ParseResult {
	text = text.replace(/^\uFEFF/, "");
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
	if (!match) return { error: "Expected a Markdown definition with opening and closing --- frontmatter delimiters" };
	try { return parseDefinitionData(parseYaml(match[1]), match[2], origin); }
	catch (error) { return { error: `Invalid definition frontmatter: ${error instanceof Error ? error.message : String(error)}` }; }
}
