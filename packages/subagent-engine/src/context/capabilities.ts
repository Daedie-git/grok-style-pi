import type { AgentDefinition } from "../types.ts";

export interface ToolLite { name: string; mcpServer?: string; source?: string }
export interface SurfaceInput {
	definition: AgentDefinition;
	available: ToolLite[];
	depth: number;
	maxDepth: number;
	background: boolean;
	isFork: boolean;
	parentTools?: string[];
	memoryTools?: string[];
}
export interface ToolSurface {
	active: string[];
	excluded: string[];
	allowedAgentTypes?: string[];
	invalid: string[];
	unavailable: string[];
	memoryScoped: string[];
}

// An empty target is a recognized Claude tool with no Pi equivalent.
export const CLAUDE_TOOL_ALIASES: Record<string, string> = {
	Read: "read", Bash: "bash", Edit: "edit", Write: "write", Grep: "grep",
	Glob: "find", LS: "ls", PowerShell: "powershell", NotebookEdit: "",
};
export const BACKGROUND_ALLOWED: ReadonlySet<string> = new Set([
	"read", "grep", "find", "ls", "bash", "powershell", "edit", "write",
	"SendMessage", "TaskList", "TaskStop",
]);
export const MAIN_THREAD_ONLY: ReadonlySet<string> = new Set([
	"TaskClaim", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "SlashCommand",
]);
const KNOWN = new Set([
	...Object.keys(CLAUDE_TOOL_ALIASES), ...Object.values(CLAUDE_TOOL_ALIASES).filter(Boolean),
	...BACKGROUND_ALLOWED, ...MAIN_THREAD_ONLY, "Agent", "TaskCreate", "TaskGet", "TaskUpdate",
]);
const unique = (names: string[]): string[] => [...new Set(names)];
const isMcp = (tool: ToolLite): boolean => tool.mcpServer !== undefined || tool.source === "mcp" || tool.name.startsWith("mcp__");

export function compileToolSurface(input: SurfaceInput): ToolSurface {
	const { available, definition } = input;
	const names = new Set(available.map((tool) => tool.name));
	const result: ToolSurface = { active: [], excluded: [], invalid: [], unavailable: [], memoryScoped: [] };
	if (input.isFork) {
		result.active = [...(input.parentTools ?? [])];
		result.unavailable = unique(result.active.filter((name) => !names.has(name)));
		result.excluded = unique([...names].filter((name) => !result.active.includes(name)));
		return result;
	}
	const pool = available.filter((tool) => {
		if (tool.name === "Agent") return input.depth < input.maxDepth;
		if (isMcp(tool)) return true;
		if (MAIN_THREAD_ONLY.has(tool.name) || tool.name.startsWith("/")) return false;
		return !input.background || BACKGROUND_ALLOWED.has(tool.name);
	});
	const poolNames = new Set(pool.map((tool) => tool.name));
	function expand(raw: string): { names: string[]; types?: string[] } {
		const value = raw.trim();
		if (value === "*") return { names: [...poolNames] };
		const agent = /^Agent\(([^()]*)\)$/.exec(value);
		const canonical = agent ? "Agent" : (Object.hasOwn(CLAUDE_TOOL_ALIASES, value) ? CLAUDE_TOOL_ALIASES[value] : value);
		const server = /^mcp__([^_]+(?:_(?!_)[^_]+)*)$/.exec(value)?.[1];
		if (server) {
			const matches = available.filter((tool) => tool.mcpServer === server || tool.name.startsWith(`${value}__`)).map((tool) => tool.name);
			if (!matches.length) result.unavailable.push(value);
			return { names: matches };
		}
		if (!names.has(canonical) && !KNOWN.has(value) && !agent && !value.startsWith("mcp__")) {
			result.invalid.push(value);
			return { names: [] };
		}
		if (!poolNames.has(canonical)) result.unavailable.push(value);
		return { names: canonical ? [canonical] : [], types: agent ? unique(agent[1].split(",").map((type) => type.trim()).filter(Boolean)) : undefined };
	}
	const denied = new Set(definition.disallowedTools.flatMap((name) => expand(name).names));
	const inherited = definition.tools === undefined || definition.tools.includes("*");
	const selected = new Set<string>();
	if (inherited) for (const name of poolNames) selected.add(name);
	else {
		let unrestrictedAgent = false;
		const types: string[] = [];
		for (const raw of definition.tools ?? []) {
			const grant = expand(raw);
			for (const name of grant.names) selected.add(name);
			if (grant.names.includes("Agent")) {
				if (grant.types) types.push(...grant.types);
				else unrestrictedAgent = true;
			}
		}
		if (!unrestrictedAgent && selected.has("Agent")) result.allowedAgentTypes = unique(types);
	}
	for (const name of selected) if (poolNames.has(name) && !denied.has(name)) result.active.push(name);
	for (const raw of input.memoryTools ?? []) {
		for (const name of expand(raw).names) {
			if (poolNames.has(name) && !denied.has(name) && !result.active.includes(name)) {
				result.active.push(name);
				result.memoryScoped.push(name);
			}
		}
	}
	if (!result.active.includes("Agent")) delete result.allowedAgentTypes;
	result.excluded = unique([...names].filter((name) => !result.active.includes(name)));
	result.invalid = unique(result.invalid);
	result.unavailable = unique(result.unavailable);
	return result;
}
