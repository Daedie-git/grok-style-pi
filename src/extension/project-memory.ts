import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildProjectMemoryContent } from "./project-memory-policy.ts";

export type ProjectMemoryContext = {
	projectRoot: string;
	directory: string;
	indexPath: string;
	content: string;
};

export type ProjectMemoryLoadOptions = { signal?: AbortSignal };

const MAX_INDEX_LINES = 200;
const MAX_INDEX_UNITS = 25_000;
// A separate byte ceiling bounds disk reads even for an index with very long lines.
const MAX_INDEX_BYTES = 100_000;

type DirectoryIdentity = { path: string; stat: Stats };

/** Stop before starting more I/O; an operation already in the OS may still finish. */
async function checkedIO<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
	signal?.throwIfAborted();
	try {
		const value = await operation();
		signal?.throwIfAborted();
		return value;
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}
}

async function optionalStat(path: string, signal?: AbortSignal): Promise<Stats | undefined> {
	try {
		return await checkedIO(signal, () => lstat(path));
	} catch (error) {
		signal?.throwIfAborted();
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function projectIdentity(cwd: string, signal?: AbortSignal): Promise<string> {
	const canonical = await checkedIO(signal, () => realpath(resolve(cwd)));
	if (!(await checkedIO(signal, () => lstat(canonical))).isDirectory()) throw new Error("Project memory requires a directory cwd.");
	for (let candidate = canonical; ; candidate = dirname(candidate)) {
		const marker = await optionalStat(join(candidate, ".git"), signal);
		// A marker identifies this root only. Never trust .git pointers as authority
		// to share another repository's memory, including linked worktrees.
		if (marker && (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink())) return candidate;
		if (dirname(candidate) === candidate) return canonical;
	}
}

async function directoryIdentity(path: string, signal?: AbortSignal): Promise<DirectoryIdentity> {
	const stat = await checkedIO(signal, () => lstat(path));
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project memory directory must be a real directory, not a symlink or special file.");
	return { path, stat };
}

function sameFile(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

async function checkDirectory(identity: DirectoryIdentity, signal?: AbortSignal): Promise<void> {
	const current = await directoryIdentity(identity.path, signal);
	if (!sameFile(identity.stat, current.stat) || await checkedIO(signal, () => realpath(identity.path)) !== identity.path) {
		throw new Error("Project memory directory changed or escaped its canonical root.");
	}
}

async function prepareStorage(storageRoot: string, projectRoot: string, signal?: AbortSignal): Promise<{ root: DirectoryIdentity; project: DirectoryIdentity }> {
	const requestedRoot = resolve(storageRoot);
	await checkedIO(signal, () => mkdir(requestedRoot, { recursive: true, mode: 0o700 }));
	// User-selected ancestors may be symlinks, but the root itself and everything
	// created beneath its canonical location must not be symlinks.
	await directoryIdentity(requestedRoot, signal);
	const root = await directoryIdentity(await checkedIO(signal, () => realpath(requestedRoot)), signal);
	const slug = basename(projectRoot).normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
	const key = `${slug}-${createHash("sha256").update(projectRoot).digest("hex")}`;
	const path = join(root.path, key);
	await checkDirectory(root, signal);
	try {
		await checkedIO(signal, () => mkdir(path, { mode: 0o700 }));
	} catch (error) {
		signal?.throwIfAborted();
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const project = await directoryIdentity(path, signal);
	await checkDirectory(root, signal);
	await checkDirectory(project, signal);
	return { root, project };
}

async function readIndex(indexPath: string, root: DirectoryIdentity, project: DirectoryIdentity, signal?: AbortSignal): Promise<string | undefined> {
	await checkDirectory(root, signal);
	await checkDirectory(project, signal);
	const before = await optionalStat(indexPath, signal);
	if (!before) return undefined;
	if (before.isSymbolicLink() || !before.isFile()) throw new Error("Project memory index must be a regular file, not a symlink or special file.");
	if (before.size > MAX_INDEX_BYTES) throw new Error(`Project memory index exceeds the ${MAX_INDEX_BYTES}-byte file limit.`);
	// NOFOLLOW rejects a replaced final symlink; NONBLOCK avoids hanging if a
	// regular file is replaced with a FIFO between lstat and open.
	signal?.throwIfAborted();
	const file = await open(indexPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		// Unlike plain I/O results, an opened handle must be retained for cleanup
		// even if cancellation arrived while open was pending.
		signal?.throwIfAborted();
		const opened = await checkedIO(signal, () => file.stat());
		if (!opened.isFile() || !sameFile(before, opened)) throw new Error("Project memory index changed while opening it.");
		if (opened.size > MAX_INDEX_BYTES) throw new Error(`Project memory index exceeds the ${MAX_INDEX_BYTES}-byte file limit.`);
		await checkDirectory(root, signal);
		await checkDirectory(project, signal);
		if (await checkedIO(signal, () => realpath(indexPath)) !== indexPath) throw new Error("Project memory index escaped its project directory.");
		const buffer = Buffer.alloc(MAX_INDEX_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const result = await checkedIO(signal, () => file.read(buffer, bytes, buffer.length - bytes, bytes));
			if (!result.bytesRead) break;
			bytes += result.bytesRead;
		}
		if (bytes > MAX_INDEX_BYTES) throw new Error(`Project memory index exceeds the ${MAX_INDEX_BYTES}-byte file limit.`);
		const after = await checkedIO(signal, () => lstat(indexPath));
		await checkDirectory(root, signal);
		await checkDirectory(project, signal);
		if (after.isSymbolicLink() || !after.isFile() || !sameFile(opened, after)) throw new Error("Project memory index changed while reading it.");
		return buffer.subarray(0, bytes).toString("utf8");
	} finally {
		await file.close();
	}
}

function escapedCharacter(character: string): string {
	if (character === "&") return "&amp;";
	if (character === "<") return "&lt;";
	if (character === ">") return "&gt;";
	if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(character)) {
		return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
	}
	return character;
}

function boundedIndex(text: string): { text: string; truncated: boolean } {
	let result = "";
	let lines = 1;
	for (const character of text.replace(/\r\n/g, "\n").trim()) {
		const escaped = escapedCharacter(character);
		if ((character === "\n" && lines === MAX_INDEX_LINES) || result.length + escaped.length > MAX_INDEX_UNITS) {
			return { text: result, truncated: true };
		}
		if (character === "\n") lines++;
		result += escaped;
	}
	return { text: result, truncated: false };
}

/** Load only the small index. Cancellation stops new I/O and always closes open handles. */
export async function loadProjectMemory(cwd: string, storageRoot: string, { signal }: ProjectMemoryLoadOptions = {}): Promise<ProjectMemoryContext> {
	const projectRoot = await projectIdentity(cwd, signal);
	const { root, project } = await prepareStorage(storageRoot, projectRoot, signal);
	const directory = project.path;
	const indexPath = join(directory, "MEMORY.md");
	const rawIndex = await readIndex(indexPath, root, project, signal);
	const index = boundedIndex(rawIndex ?? "");
	signal?.throwIfAborted();
	const content = buildProjectMemoryContent({ projectRoot, directory, indexPath, index: index.text, missing: rawIndex === undefined, truncated: index.truncated });
	return { projectRoot, directory, indexPath, content };
}
