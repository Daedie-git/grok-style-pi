import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type OpenTarget = { path: string; line: number; column?: number; cwd: string };

export type SpawnLike = (
	command: string,
	args: string[],
	options: { cwd?: string; detached?: boolean; stdio?: "ignore"; env?: NodeJS.ProcessEnv },
) => { once(event: "error" | "spawn", listener: (...args: any[]) => void): void; unref(): void };

const MAX_RECENT = 30;

export function findGitRoot(start: string): string | undefined {
	let dir = resolve(start);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function workspaceFor(file: string, cwd: string): string {
	const absolute = absPath(file, cwd);
	return findGitRoot(dirname(absolute)) ?? findGitRoot(cwd) ?? cwd;
}

export function absPath(path: string, cwd: string): string {
	// Match built-in tool arguments: strip one @ before expanding the home prefix.
	path = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** Owned by an extension instance, never by the cached module or launcher. */
export function createOpenHistory() {
	const recent: OpenTarget[] = [];
	return {
		rememberOpen(target: OpenTarget): OpenTarget {
			const next = { path: absPath(target.path, target.cwd), line: Math.max(1, target.line), cwd: target.cwd };
			const existing = recent.findIndex((item) => item.path === next.path);
			if (existing >= 0) recent.splice(existing, 1);
			recent.unshift(next);
			if (recent.length > MAX_RECENT) recent.pop();
			return { ...next };
		},
		lastOpen(): OpenTarget | undefined { return recent[0] ? { ...recent[0] } : undefined; },
		recentOpens(): OpenTarget[] { return recent.map((target) => ({ ...target })); },
		clear() { recent.length = 0; },
	};
}

export function cursorLauncher(home = homedir(), exists = existsSync): string {
	const shim = join(home, ".local", "bin", "cursor");
	return exists(shim) ? shim : "cursor";
}

export function cursorArgs(file: string, line: number, workspace: string, column?: number): string[] {
	const position = `${file}:${Math.max(1, line)}${column === undefined ? "" : `:${Math.max(1, column)}`}`;
	return ["--classic", "--goto", position, workspace];
}

/** /tmp is shared: never execute a different user's lookalike or a writable/symlinked mount. */
function trustedMountPath(path: string, directory: boolean): boolean {
	try {
		const stat = lstatSync(path);
		return (directory ? stat.isDirectory() : stat.isFile()) &&
			(stat.uid === 0 || stat.uid === process.getuid?.()) && (stat.mode & 0o022) === 0;
	} catch { return false; }
}

function mountRecord(path: string, mountInfo: string): { type: string; options: string[] } | undefined {
	for (const line of mountInfo.split("\n")) {
		const [fields, filesystem] = line.split(" - ");
		if (!filesystem) continue;
		const mountPath = fields.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
		if (mountPath !== path) continue;
		const [type, , options] = filesystem.split(" ");
		return { type, options: options?.split(",") ?? [] };
	}
	return undefined;
}

/** FUSE may forge file UIDs, including our own; kernel mount ownership is authoritative. */
export function isOwnedAppImageMount(path: string, mountInfo: string, uid: number): boolean {
	const mount = mountRecord(path, mountInfo);
	return Boolean(mount?.type.startsWith("fuse.") && mount.options.includes(`user_id=${uid}`));
}

function ownedMountRoot(path: string): boolean {
	try {
		const uid = process.getuid?.();
		if (uid === undefined) return false;
		const info = readFileSync("/proc/self/mountinfo", "utf8");
		return mountRecord(path, info) ? isOwnedAppImageMount(path, info, uid) : lstatSync(path).uid === uid;
	} catch { return false; }
}

export function findMountedCursor(tmpDir = "/tmp"): { electron: string; cli: string } | undefined {
	if (process.platform !== "linux") return undefined;
	let names: string[] = [];
	try { names = readdirSync(tmpDir); } catch { return undefined; }
	for (const name of names) {
		if (!name.startsWith(".mount_")) continue;
		const mount = join(tmpDir, name);
		if (!ownedMountRoot(mount)) continue;
		const directories = [mount, ...["usr", "usr/share", "usr/share/cursor", "usr/share/cursor/resources",
			"usr/share/cursor/resources/app", "usr/share/cursor/resources/app/out"].map(path => join(mount, path))];
		const electron = join(mount, "usr/share/cursor/cursor");
		const cli = join(mount, "usr/share/cursor/resources/app/out/cli.js");
		if (directories.every(path => trustedMountPath(path, true)) &&
			trustedMountPath(electron, false) && trustedMountPath(cli, false)) return { electron, cli };
	}
	return undefined;
}

export function resolveCursorInvocation(args: string[], tmpDir = "/tmp"): { command: string; args: string[]; env: NodeJS.ProcessEnv; mounted?: boolean } {
	const mounted = findMountedCursor(tmpDir);
	if (mounted) {
		return {
			command: mounted.electron,
			mounted: true,
			args: [mounted.cli, ...args],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		};
	}
	return { command: cursorLauncher(), args, env: process.env };
}

export async function openInCursor(target: OpenTarget, spawnImpl: SpawnLike = spawn, tmpDir = "/tmp"): Promise<void> {
	const remembered = { ...target, path: absPath(target.path, target.cwd) };
	const workspace = workspaceFor(remembered.path, remembered.cwd);
	const args = cursorArgs(remembered.path, remembered.line, workspace, remembered.column);
	const invocation = resolveCursorInvocation(args, tmpDir);
	const launch = (invocation: ReturnType<typeof resolveCursorInvocation>) => new Promise<void>((resolveOpen, reject) => {
		const child = spawnImpl(invocation.command, invocation.args, {
			cwd: workspace,
			detached: true,
			stdio: "ignore",
			env: invocation.env,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolveOpen();
		});
	});
	try {
		await launch(invocation);
	} catch (error) {
		// The running AppImage may have unmounted between discovery and spawn.
		if (!invocation.mounted) throw error;
		await launch({ command: cursorLauncher(), args, env: process.env });
	}
}
