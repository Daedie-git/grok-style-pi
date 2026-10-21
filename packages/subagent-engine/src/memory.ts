import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MemoryScope } from "./types.ts";

function agentSegment(agentType: string): string {
	if (!agentType) throw new Error("Memory requires a nonempty agent type");
	let segment = encodeURIComponent(agentType).replace(/[.!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	// Reserved Windows device names must be escaped even without an extension.
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment)) segment = `%${segment.charCodeAt(0).toString(16).toUpperCase()}${segment.slice(1)}`;
	return segment;
}

export function memoryDir(scope: MemoryScope, input: { agentDir: string; cwd: string; agentType: string }): string {
	const segment = agentSegment(input.agentType);
	switch (scope) {
		case "user": return resolve(input.agentDir, "agent-memory", segment);
		case "project": return resolve(input.cwd, ".pi", "agent-memory", segment);
		case "local": return resolve(input.cwd, ".pi", "agent-memory-local", segment);
		default: throw new Error("Unsupported memory scope");
	}
}

/** Resolve existing ancestors too, so new files cannot escape through a symlink. */
function canonicalPath(path: string): string {
	try { return realpathSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			// A dangling link must not be mistaken for an ordinary new filename.
			lstatSync(path);
			throw new Error("Unresolvable existing memory path");
		} catch (statError) {
			if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
		}
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(canonicalPath(parent), basename(path));
	}
}

function contains(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Apply only to tools granted exclusively for memory, not pre-existing tool grants. */
export function memoryPathGuard(dir: string): (toolName: string, args: Record<string, unknown>) => string | undefined {
	const root = resolve(dir);
	return (toolName, args) => {
		if (!["read", "write", "edit"].includes(toolName.toLowerCase())) return undefined;
		const paths = [args.path, args.file_path].filter(value => value !== undefined);
		if (!paths.length) return "Memory-only tools require an absolute file path inside the memory directory.";
		try {
			const canonicalRoot = canonicalPath(root);
			for (const path of paths) {
				// The guard has no child-cwd parameter. Never guess a relative path's
				// base and accidentally authorize access outside memory.
				if (typeof path !== "string" || !isAbsolute(path)) return "Memory-only tools require an absolute file path inside the memory directory.";
				if (!contains(root, resolve(path)) || !contains(canonicalRoot, canonicalPath(resolve(path)))) {
					return `Memory-only ${toolName} access is restricted to ${root}.`;
				}
			}
			return undefined;
		} catch {
			return "Cannot verify the memory path; access refused.";
		}
	};
}

export function memoryIndex(dir: string, limit = 8_000): string | undefined {
	if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Memory index limit must be a nonnegative safe integer");
	const path = resolve(dir, "MEMORY.md");
	if (memoryPathGuard(dir)("read", { path })) return undefined;
	try {
		const content = readFileSync(path, "utf8");
		let end = Math.min(limit, content.length);
		if (end > 0 && end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
		return content.slice(0, end);
	} catch { return undefined; }
}
