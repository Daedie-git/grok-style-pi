import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSkills as loadPiSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface SkillInfo {
	name: string;
	path: string;
	description: string;
	content: string;
	context?: "fork";
	agent?: string;
	model?: string;
	effort?: string;
	allowedTools?: string[];
	disableModelInvocation: boolean;
}

function toolList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value.every(item => typeof item === "string") ? [...new Set(value.map(item => item.trim()).filter(Boolean))] : [];
	if (typeof value !== "string") return [];
	const tools: string[] = [];
	let depth = 0;
	let token = "";
	for (const char of value) {
		if (char === "(") depth++;
		if (char === ")") depth--;
		if (depth < 0) return [];
		if (depth === 0 && /[,\s]/.test(char)) {
			if (token) tools.push(token);
			token = "";
		} else token += char;
	}
	if (depth !== 0) return [];
	if (token) tools.push(token);
	return [...new Set(tools)];
}

export function loadSkills(input: { agentDir: string; cwd: string; projectTrusted: boolean }): SkillInfo[] {
	const cwd = resolve(input.cwd);
	const agentDir = resolve(input.agentDir);
	// Delegate traversal, ignore rules, file deduplication and first-name-wins
	// precedence to Pi's public loader. Supplying explicit default directories
	// lets us omit project resources before they are read when untrusted.
	const skillPaths = [join(agentDir, "skills")];
	if (input.projectTrusted) skillPaths.push(join(cwd, ".pi", "skills"));
	const loaded = loadPiSkills({ cwd, agentDir, includeDefaults: false, skillPaths });
	const result: SkillInfo[] = [];
	for (const skill of loaded.skills) {
		try {
			const { frontmatter, body } = parseFrontmatter(readFileSync(skill.filePath, "utf8"));
			const info: SkillInfo = {
				name: skill.name, path: skill.filePath, description: skill.description,
				content: body.trim(), disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			};
			if (frontmatter.context === "fork") info.context = "fork";
			for (const field of ["agent", "model", "effort"] as const) {
				const value = frontmatter[field];
				if (typeof value === "string" && value.trim()) info[field] = value.trim();
			}
			const allowed = toolList(frontmatter["allowed-tools"]);
			if (allowed !== undefined) info.allowedTools = allowed;
			result.push(info);
		} catch {
			// A removed, unreadable or malformed skill must not remain executable.
		}
	}
	return result;
}

export function preloadSkills(names: string[], skills: SkillInfo[]): { name: string; content: string }[] {
	const byName = new Map<string, SkillInfo>();
	for (const skill of skills) if (!byName.has(skill.name)) byName.set(skill.name, skill);
	return [...new Set(names)].flatMap(name => {
		const skill = byName.get(name);
		return skill ? [{ name: skill.name, content: skill.content }] : [];
	});
}

/** These select fresh skill-scoped children, never conversation-history forks. */
export function forkContextSkills(skills: SkillInfo[], origin: "user" | "model"): SkillInfo[] {
	return skills.filter(skill => skill.context === "fork" && (origin === "user" || !skill.disableModelInvocation));
}

export function skillAgentType(name: string): string {
	return `skill:${name}`;
}
