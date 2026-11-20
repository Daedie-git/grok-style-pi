// Where Claude Code keeps auto memory and what its configuration says about it, resolved the way Claude Code 2.1.329
// does, so Pi reads the same notes and protects the same folders.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

const KEY_LIMIT = 200;
const truthy = (value: string | undefined) => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
const falsy = (value: string | undefined) => /^(?:0|false|no|off)$/i.test(value?.trim() ?? "");

function settings(path: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch { return {}; }
}

/** Claude Code's managed-settings folder (`ei`) for this platform. */
export function managedSettingsDir(platform = process.platform): string {
	return platform === "darwin" ? "/Library/Application Support/ClaudeCode" : platform === "win32" ? "C:\\Program Files\\ClaudeCode" : "/etc/claude-code";
}

/** managed-settings.json, then each managed-settings.d file in name order on top of it; `env` merges key by key. */
function managedSettings(dir: string): Record<string, unknown> {
	let files: string[] = [];
	try { files = readdirSync(join(dir, "managed-settings.d")).filter((name) => name.endsWith(".json")).sort(); } catch {}
	let merged: Record<string, unknown> = {};
	for (const value of [settings(join(dir, "managed-settings.json")), ...files.map((name) => settings(join(dir, "managed-settings.d", name)))]) {
		merged = { ...merged, ...value, env: { ...(merged.env as object | undefined), ...(value.env as object | undefined) } };
	}
	return merged;
}

/**
 * Claude Code's directory validation (`hc`): `~/` only where allowed and never escaping home; the result must be absolute,
 * at least three characters, not a filesystem or drive root, and free of NUL. Anything else is ignored.
 */
function validDirectory(value: unknown, allowTilde: boolean, home: string): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	let path = value;
	if (allowTilde && path.startsWith("~/")) {
		const rest = path.slice(2);
		const normalized = relative(".", rest || ".");
		if (normalized === "" || normalized === ".." || normalized.startsWith(`..${sep}`)) return undefined;
		path = join(home, rest);
	}
	const result = resolve(path).replace(/[\\/]+$/, "");
	if (!isAbsolute(path) || result.length < 3 || /^[A-Za-z]:$/.test(result) || result.includes("\0")) return undefined;
	return result;
}

/** Everything Claude Code's configuration says about memory, from one read of managed and user settings. */
export interface ClaudeConfig {
	home: string;
	/** Settings `env` applied over the process environment, policy over user, as Claude Code applies them. */
	env: NodeJS.ProcessEnv;
	configDir: string;
	/** Where `projects/<key>/memory` lives: CLAUDE_CODE_REMOTE_MEMORY_DIR in remote sessions (`jkt`), else the config folder. */
	memoryBase: string;
	/** A valid cowork override, else a valid `autoMemoryDirectory` from policy or user settings. */
	configuredDirectory?: string;
	/** Claude Code's enablement (`Ih`, `Mh`) and `autoMemoryEnabled: false`. */
	disabled: boolean;
	/** ANTHROPIC_DEFAULT_SONNET_MODEL, when set. */
	sonnet?: string;
	noModelFallback: boolean;
}

/**
 * Read Claude Code's configuration once. Project and local `.claude/settings*.json` are a trust boundary Claude Code gates,
 * so recall never follows them; the write guard reads them separately (`projectMemoryDirectories`).
 */
export function claudeConfig(processEnv: NodeJS.ProcessEnv, home = homedir(), platform = process.platform): ClaudeConfig {
	const configDir = processEnv.CLAUDE_CONFIG_DIR?.trim() ? resolve(processEnv.CLAUDE_CONFIG_DIR) : join(home, ".claude");
	const policy = managedSettings(managedSettingsDir(platform));
	const user = settings(join(configDir, "settings.json"));
	const strings = (value: unknown) => Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
	const env: NodeJS.ProcessEnv = { ...processEnv, ...strings(user.env), ...strings(policy.env) };
	const disable = env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
	const disabled = truthy(disable) ? true : falsy(disable) ? false
		: truthy(env.CLAUDE_CODE_SIMPLE) || (truthy(env.CLAUDE_CODE_REMOTE) && !env.CLAUDE_CODE_REMOTE_MEMORY_DIR && !env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE)
			|| policy.autoMemoryEnabled === false || user.autoMemoryEnabled === false;
	return {
		home, env, configDir,
		memoryBase: env.CLAUDE_CODE_REMOTE_MEMORY_DIR ? resolve(env.CLAUDE_CODE_REMOTE_MEMORY_DIR) : configDir,
		configuredDirectory: validDirectory(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, false, home)
			?? validDirectory(policy.autoMemoryDirectory, true, home) ?? validDirectory(user.autoMemoryDirectory, true, home),
		disabled,
		sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || undefined,
		noModelFallback: truthy(env.CLAUDE_CODE_NO_MODEL_FALLBACK),
	};
}

/** Claude Code's 32-bit string hash, printed in base 36 for over-long project keys. */
function hash(text: string): string {
	let value = 0;
	for (let index = 0; index < text.length; index++) value = (value << 5) - value + text.charCodeAt(index) | 0;
	return Math.abs(value).toString(36);
}

export function projectKey(path: string): string {
	const key = path.replace(/[^a-zA-Z0-9]/g, "-");
	return key.length <= KEY_LIMIT ? key : `${key.slice(0, KEY_LIMIT)}-${hash(path)}`;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((done) => {
		execFile("git", ["-C", cwd, ...args], { timeout: 5_000 }, (error, stdout) => done(error ? undefined : stdout.trim() || undefined));
	});
}

/** The real path, resolving the nearest existing ancestor when the file itself does not exist yet. */
function canonical(path: string): string {
	try { return realpathSync(path); } catch {
		const parent = dirname(path);
		return parent === path ? resolve(path) : join(canonical(parent), basename(path));
	}
}

/** The project memory key's base: linked worktrees share their main checkout's memory; outside Git, the working directory. */
export async function projectBase(cwd: string): Promise<string> {
	const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (common && basename(common) === ".git") return canonical(dirname(common));
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return canonical(top ?? cwd);
}

/** The root auto-memory directory Claude Code reads and writes for a project. */
export function memoryDirectory(config: ClaudeConfig, base: string): string {
	return config.configuredDirectory ?? join(config.memoryBase, "projects", projectKey(base), "memory");
}

export async function claudeMemoryDirectory(cwd: string, config: ClaudeConfig): Promise<string> {
	return config.configuredDirectory ?? memoryDirectory(config, await projectBase(cwd));
}

/** Where Claude Code reads project settings: the working directory and this checkout's top level (a linked worktree's own). */
export async function settingsRoots(cwd: string): Promise<string[]> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return [...new Set([resolve(cwd), ...(top ? [canonical(top)] : [])])];
}

/** `autoMemoryDirectory` from `.claude/settings.json` and `.claude/settings.local.json` under each settings root, reread per call. */
export function projectMemoryDirectories(roots: string[], home: string): string[] {
	return roots.flatMap((root) => ["settings.json", "settings.local.json"].map((name) => validDirectory(settings(join(root, ".claude", name)).autoMemoryDirectory, true, home)))
		.filter((dir): dir is string => !!dir);
}

/** The file a Pi file tool would touch: Pi's `resolveToCwd` (Unicode spaces, `@` prefix, Windows shell drives, `~`, file URLs). */
export function toolPath(path: string, cwd: string, home = homedir(), platform = process.platform): string {
	const paths = platform === "win32" ? win32 : posix;
	let value = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (value.startsWith("@")) value = value.slice(1);
	// Pi's `normalizeWindowsShellPath`: /c/x, /mnt/c/x and /cygdrive/c/x name drive C: on Windows.
	if (platform === "win32" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
		const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
		if (drive) value = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (value === "~") value = home;
	else if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) value = paths.join(home, value.slice(2));
	else if (/^file:\/\//.test(value)) value = fileURLToPath(value);
	return paths.isAbsolute(value) ? paths.resolve(value) : paths.resolve(cwd, value);
}

function inside(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/**
 * The one table of Claude-owned memory that Pi never writes. Each area is a folder (everything below it is protected)
 * or a projects folder (only `<project>/memory` below it is). `folders` are this project's memory folder, the configured
 * folder, and folders the working copy's settings name; every base contributes its projects, agent-memory and account
 * memory (`memory/personal`, Claude Code's `gSl`) areas.
 */
export type ProtectedArea = { path: string; projects?: true };
export type ProtectedRoots = { home: string; areas: ProtectedArea[] };

export function protectedRoots(config: ClaudeConfig, folders: (string | undefined)[]): ProtectedRoots {
	const bases = [...new Set([config.configDir, config.memoryBase])];
	return {
		home: config.home,
		areas: [
			...folders.filter((path): path is string => !!path).map((path) => ({ path })),
			...bases.flatMap((base) => [{ path: join(base, "projects"), projects: true as const }, { path: join(base, "agent-memory") }, { path: join(base, "memory") }]),
		],
	};
}

/** Claude's fixed path shapes, protected wherever they appear (project agent memory lives in the working copy). */
const SHAPES = /(?:^|[\\/])\.claude[\\/]+(?:agent-memory(?:-local)?|memory[\\/]+personal)(?:[\\/]|$)/;

/** The same shapes as a shell command may write them, relative or after any prefix, and Claude's projects folder with a memory segment. */
const SHELL_SHAPES = [/\.claude[\\/]+(?:agent-memory(?:-local)?|memory[\\/]+personal)(?:[\\/\s'";|&)]|$)/, /\.claude[\\/]+projects[\s\S]*?(?:^|[\\/\s'"=])memory(?:$|[\\/\s'";|&)])/];

/** Whether a resolved file path lies in a protected area, under its own or its real (symlink-resolved) name. */
export function isClaudeMemoryPath(path: string, roots: ProtectedRoots): boolean {
	const target = resolve(path);
	const candidates = [target, canonical(target)];
	return candidates.some((candidate) => SHAPES.test(candidate) || roots.areas.some((area) => [resolve(area.path), canonical(area.path)].some((root) => {
		if (!area.projects) return inside(root, candidate);
		const parts = relative(root, candidate).split(sep);
		return parts.length >= 2 && parts[0] !== ".." && !isAbsolute(parts[0]) && parts[1] === "memory";
	})));
}

/**
 * A best-effort filter, not a sandbox: a shell command is refused when it names a protected area in one of the four ways a
 * shell spells a path (as is, `~/x`, `$HOME/x`, `${HOME}/x`), or one of Claude's fixed path shapes. Commands that build a
 * path indirectly get through; the read tool is the supported way to read a note. Extend the table, not this function.
 */
export function mentionsClaudeMemory(command: string, roots: ProtectedRoots): boolean {
	const spellings = (path: string) => {
		const result = [path];
		if (inside(roots.home, path) && path !== roots.home) {
			const rest = relative(roots.home, path).split(sep).join("/");
			result.push(`~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`);
		}
		return result;
	};
	const memorySegment = /(?:^|[\\/\s'"=])memory(?:$|[\\/\s'";|&)])/;
	return SHELL_SHAPES.some((shape) => shape.test(command)) || roots.areas.some((area) => spellings(area.path).some((spelling) => command.includes(spelling))
		&& (!area.projects || memorySegment.test(command)));
}
