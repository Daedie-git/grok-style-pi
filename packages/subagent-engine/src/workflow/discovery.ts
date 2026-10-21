import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseWorkflowSource } from "./meta.ts";
import { compileBody } from "./compile.ts";

export interface WorkflowDefinition { path: string; source: string; origin: "bundled" | "user" | "project" }
export function discoverWorkflows(input: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	homeDir?: string;
	bundled?: Iterable<{ source: string; path?: string }>;
}): Map<string, WorkflowDefinition> {
	const result = new Map<string, WorkflowDefinition>();
	const seen = new Set<string>();
	function add(source: string, path: string, origin: WorkflowDefinition["origin"]): void {
		const parsed = parseWorkflowSource(source);
		if (!parsed.meta || parsed.error) return;
		if (result.has(parsed.meta.name) && !compileBody(parsed.body).ok) return;
		result.set(parsed.meta.name, { source, path, origin });
	}
	for (const [index, bundled] of [...(input.bundled ?? [])].entries()) add(bundled.source, bundled.path ?? `bundled:${index}`, "bundled");
	function scan(dir: string, origin: "user" | "project"): void {
		let entries: string[];
		try { entries = readdirSync(dir).sort(); } catch { return; }
		for (const name of entries) {
			if (!name.endsWith(".js")) continue;
			const path = join(dir, name);
			try {
				const canonical = realpathSync(path);
				if (seen.has(canonical)) continue;
				const stat = statSync(canonical);
				if (!stat.isFile() || stat.size > 524_288) continue;
				seen.add(canonical);
				add(readFileSync(canonical, "utf8").replace(/\r\n/g, "\n"), canonical, origin);
			} catch { /* unreadable definitions do not replace valid ones */ }
		}
	}
	scan(resolve(input.agentDir, "workflows"), "user");
	if (input.projectTrusted) {
		const ancestors: string[] = [];
		const home = resolve(input.homeDir ?? homedir());
		for (let dir = resolve(input.cwd); dir !== home;) {
			ancestors.push(dir);
			const parent = dirname(dir);
			if (parent === dir || existsSync(join(dir, ".git"))) break;
			dir = parent;
		}
		for (const dir of ancestors.reverse()) for (const family of [".pi", ".claude"]) scan(join(dir, family, "workflows"), "project");
	}
	return result;
}
