import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentDefinition, DefinitionSource } from "../types.ts";
import { builtInDefinitions } from "./builtins.ts";
import { parseDefinitionData, parseDefinitionFile } from "./parse.ts";
import { isMapping } from "./yaml.ts";

export interface DiscoveryOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	additionalDirs?: string[];
	flagJson?: string;
	policyDir?: string;
	packageDirs?: { dir: string; namespace: string }[];
	forkEnabled: boolean;
	homeDir?: string;
}

export interface DefinitionSet {
	active: Map<string, AgentDefinition>;
	list: AgentDefinition[];
	diagnostics: string[];
	revision: string;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (isMapping(value)) return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
	return value;
}
function missing(error: unknown): boolean {
	return isMapping(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Discover from low to high priority; every exact-name assignment replaces the previous one. */
export async function discoverDefinitions(options: DiscoveryOptions): Promise<DefinitionSet> {
	const active = new Map<string, AgentDefinition>();
	const diagnostics: string[] = [];
	const seenPaths = new Set<string>();
	const seenInodes = new Set<string>();
	const add = (definition: AgentDefinition) => {
		if (definition.agentType === "fork" && definition.source !== "built-in" && active.get("fork")?.builtIn === "fork") {
			diagnostics.push(`Built-in fork removed: ${definition.source} definition named fork takes precedence and has no built-in semantics`);
		}
		active.set(definition.agentType, definition);
		for (const message of definition.diagnostics) diagnostics.push(`${definition.path ?? definition.agentType}: ${message}`);
	};
	for (const definition of builtInDefinitions({ forkEnabled: options.forkEnabled })) add(definition);
	async function directory(dir: string, source: DefinitionSource, namespace?: string): Promise<void> {
		let names: string[];
		try { names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort(compare); }
		catch (error) { if (!missing(error)) diagnostics.push(`${dir}: ${String(error)}`); return; }
		for (const name of names) {
			const path = join(dir, name);
			try {
				const resolved = await realpath(path);
				const info = await stat(resolved, { bigint: true });
				if (!info.isFile()) continue;
				const inode = info.ino === 0n ? undefined : `${info.dev}:${info.ino}`;
				if (seenPaths.has(resolved) || (inode !== undefined && seenInodes.has(inode))) { diagnostics.push(`Duplicate definition file skipped: ${path}`); continue; }
				seenPaths.add(resolved);
				if (inode !== undefined) seenInodes.add(inode);
				const parsed = parseDefinitionFile(await readFile(path, "utf8"), { source, path, namespace });
				if (parsed.definition) add(parsed.definition);
				else diagnostics.push(`${path}: ${parsed.error}`);
			} catch (error) { diagnostics.push(`${path}: ${String(error)}`); }
		}
	}
	for (const pkg of options.packageDirs ?? []) await directory(resolve(options.cwd, pkg.dir), "package", pkg.namespace);
	await directory(join(resolve(options.cwd, options.agentDir), "agents"), "user");
	if (options.projectTrusted) {
		const roots = (options.additionalDirs ?? []).map((dir) => resolve(options.cwd, dir));
		const ancestors: string[] = [];
		const home = resolve(options.homeDir ?? homedir());
		let current = resolve(options.cwd);
		while (true) {
			ancestors.push(current);
			const parent = dirname(current);
			if (current === home || current === parent) break;
			current = parent;
		}
		roots.push(...ancestors.reverse());
		for (const root of roots) for (const relative of [".pi/agents", ".claude/agents", ".agents/agents"]) await directory(join(root, relative), "project");
	}
	if (options.flagJson !== undefined) {
		try {
			const data: unknown = JSON.parse(options.flagJson);
			if (!isMapping(data) && !Array.isArray(data)) throw new Error("--agents JSON must be an object keyed by agent name or an array of definitions");
			const entries = Array.isArray(data) ? data.map((value) => [undefined, value] as const) : Object.entries(data);
			for (const [name, value] of entries) {
				if (!isMapping(value)) { diagnostics.push(`flag ${name ?? "entry"}: definition must be an object`); continue; }
				if (value.prompt !== undefined && typeof value.prompt !== "string") { diagnostics.push(`flag ${name ?? "entry"}: prompt must be a string`); continue; }
				const parsed = parseDefinitionData({ ...value, name: name ?? value.name }, value.prompt as string | undefined ?? "", { source: "flag" });
				if (parsed.definition) add(parsed.definition);
				else diagnostics.push(`flag ${name ?? "entry"}: ${parsed.error}`);
			}
		} catch (error) { diagnostics.push(`Invalid --agents JSON: ${String(error)}`); }
	}
	if (options.policyDir) await directory(resolve(options.cwd, options.policyDir), "policy");
	const list = [...active.values()].sort((a, b) => compare(a.agentType, b.agentType));
	const revision = createHash("sha256").update(JSON.stringify(canonical(list))).digest("hex");
	return { active, list, diagnostics, revision };
}

export function selectDefinition(set: DefinitionSet, name: string): { definition?: AgentDefinition; error?: string } {
	const exact = set.active.get(name);
	if (exact) return { definition: exact };
	const normalize = (value: string) => value.toLowerCase().replace(/[_ ]/g, "-");
	const matches = set.list.filter((definition) => normalize(definition.agentType) === normalize(name));
	if (matches.length === 1) return { definition: matches[0] };
	if (matches.length > 1) return { error: `Ambiguous agent name ${JSON.stringify(name)}; candidates: ${matches.map((definition) => definition.agentType).join(", ")}` };
	return { error: `Unknown agent type: ${name}` };
}
