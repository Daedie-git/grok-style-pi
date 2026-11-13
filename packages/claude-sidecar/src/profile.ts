// Fleet role profiles (version 1): a resolved role the caller binds to a fresh Pi sidecar. Fleet keeps policy
// authority; the launcher validates and maps the fields onto the runner.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Profile {
	role: "reviewer" | "implementer";
	prompt: string;
	allow: string[] | null;
	deny: string[];
	skills: string[];
	mcp: boolean;
	/** Canonical JSON, and its digest. */
	json: string;
	hash: string;
}

const KEYS = ["allow", "deny", "mcp", "prompt", "role", "skills", "version"];
/** Pi's default tools; a closed list starts from them. */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
/** The tools no profile may deny: the Bash launcher's delivery tools. */
const MANDATORY = ["read", "submit_review"];

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && !item.includes("\0"));
const tools = (value: unknown): value is string[] => strings(value) && value.every((item) => item.length > 0 && !/[,\s]|^[+-]/.test(item));
/** Pi's tool patterns support only `*`. */
const patternMatch = (pattern: string, name: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

/** Reads and validates FILE. Throws Error with the launcher's message, and refuses what the runner cannot enforce. */
export function loadProfile(file: string): Profile {
	if (!existsSync(file)) throw new Error(`profile file does not exist: ${file}`);
	const invalid = () => new Error(`invalid version 1 role profile: ${file}`);
	let value: Record<string, unknown>;
	try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw invalid(); }
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== KEYS.join()) throw invalid();
	const { version, role, prompt, allow, deny, skills, mcp } = value;
	if (version !== 1 || (role !== "reviewer" && role !== "implementer") || typeof prompt !== "string" || prompt.includes("\0")
		|| !(allow === null || tools(allow)) || !tools(deny) || typeof mcp !== "boolean"
		|| !strings(skills) || !skills.every((skill) => skill.length > 0 && !/[\r\n]/.test(skill) && /^(\/|~\/|[A-Za-z]:[/\\])/.test(skill))) throw invalid();
	for (const pattern of deny) for (const name of MANDATORY) if (patternMatch(pattern, name)) throw new Error(`profile cannot deny mandatory tool ${name}`);
	// The runner has no switch for Pi's MCP extensions, and it filters tools by exact name.
	if (mcp) throw new Error("profile mcp: true cannot be honored: the runner cannot load Pi's MCP extensions");
	for (const name of allow ?? []) if (name.includes("*")) throw new Error(`profile allow pattern ${name} cannot be honored: the runner matches tool names exactly; list the tools`);
	const json = canonical(value);
	return { role, prompt, allow, deny, skills, mcp, json, hash: createHash("sha256").update(`${json}\n`).digest("hex") };
}

/** The tools the sidecar may use. Always a closed list, so MCP and other ambient tools stay hidden (`mcp: false`). */
export function profileTools(profile: Profile): string[] {
	return [...new Set([...(profile.allow ?? DEFAULT_TOOLS), "read"])].filter((name) => !profile.deny.some((pattern) => patternMatch(pattern, name)));
}

/** Skill paths for the local machine, `~/` expanded; each must be a Markdown file or a directory with SKILL.md. */
export function profileSkills(profile: Profile, home: string): string[] {
	return profile.skills.map((skill) => {
		const path = skill.startsWith("~/") ? join(home, skill.slice(2)) : skill;
		try {
			const stat = statSync(path);
			if (stat.isDirectory() ? statSync(join(path, "SKILL.md")).isFile() : stat.isFile() && /\.md$/i.test(path)) return path;
		} catch {}
		throw new Error(`profile skill must be a Markdown file or a directory with regular SKILL.md: ${skill}`);
	});
}
