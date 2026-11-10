import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

export type MemoryCandidate = { name: string; description: string; modified: number };
export type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;
const MAX_FILE_BYTES = 100_000;

export function escapeMemory(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
			char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function indexWarning(content: string): string | undefined {
	const text = content.trim();
	const lines = text ? text.split("\n").length : 0;
	if (lines > 200 || text.length > 25_000) return "The write succeeded, but MEMORY.md exceeds 200 lines or 25,000 UTF-16 units. Shorten the index; move details into topic files.";
	if (lines >= 160 || text.length >= 20_000) return "MEMORY.md is near its read limit. Shorten it below 140 lines and 17,500 UTF-16 units.";
	return undefined;
}

/** A memory-only filesystem. No symlinks, arbitrary paths, shell, or repository writes. */
export class MemoryStore {
	readonly directory: string;
	private identity: string | undefined;
	private queue: MutationQueue;
	private authorize: () => Promise<void>;
	constructor(directory: string, queue: MutationQueue = async (_path, operation) => operation(), authorize: () => Promise<void> = async () => {}) {
		this.directory = resolve(directory);
		this.queue = queue;
		this.authorize = authorize;
	}
	private async root(signal?: AbortSignal) {
		signal?.throwIfAborted();
		const stat = await lstat(this.directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(this.directory) !== this.directory) throw new Error("Unsafe memory directory");
		const identity = `${stat.dev}:${stat.ino}`;
		if (this.identity && identity !== this.identity) throw new Error("Memory directory changed");
		this.identity = identity;
		signal?.throwIfAborted();
	}
	private async path(name: string, signal?: AbortSignal): Promise<string> {
		await this.root(signal);
		if (!name.endsWith(".md") || name.includes("\\") || name.split("/").some(part => !part || part.startsWith("."))) throw new Error("Use a relative Markdown topic path inside memory");
		const target = resolve(this.directory, name);
		const suffix = relative(this.directory, target);
		if (suffix.startsWith(`..${sep}`) || suffix === ".." || suffix === "" || resolve(name) === name) throw new Error("Memory path escaped its directory");
		let current = this.directory;
		for (const part of suffix.split(sep)) {
			current = join(current, part);
			try {
				const stat = await lstat(current);
				if (stat.isSymbolicLink() || (current === target ? !stat.isFile() : !stat.isDirectory())) throw new Error("Memory paths must be regular files and directories");
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			signal?.throwIfAborted();
		}
		return target;
	}
	async read(name: string, signal?: AbortSignal): Promise<string | undefined> {
		await this.authorize();
		const target = await this.path(name, signal);
		let file;
		try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		try {
			signal?.throwIfAborted();
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Memory file must be regular and at most 100,000 bytes");
			const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				signal?.throwIfAborted();
				const result = await file.read(buffer, size, buffer.length - size, size);
				if (!result.bytesRead) break;
				size += result.bytesRead;
			}
			if (size > MAX_FILE_BYTES) throw new Error("Memory file grew beyond its read limit");
			await this.path(name, signal);
			const after = await lstat(target);
			if (after.dev !== stat.dev || after.ino !== stat.ino) throw new Error("Memory file changed while reading");
			return buffer.subarray(0, size).toString("utf8");
		} finally { await file.close(); }
	}
	/** Compare-and-swap prevents a background result overwriting newer foreground notes. */
	async mutate(name: string, content: string | null, expected: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
		await this.authorize();
		const target = await this.path(name, signal);
		return this.queue(target, async () => {
			const current = await this.read(name, signal);
			if (current !== expected) throw new Error("Memory changed since it was read; read it again before editing");
			if (content === null) { await this.authorize(); signal?.throwIfAborted(); if (current !== undefined) await unlink(target); return undefined; }
			if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Memory write exceeds 100,000 bytes");
			// Parent topic directories must already exist; the worker cannot create arbitrary trees.
			if (await realpath(dirname(target)) !== dirname(target)) throw new Error("Unsafe memory parent");
			const temporary = join(dirname(target), `.memory-${randomUUID()}`);
			const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try {
				await file.writeFile(content, "utf8");
				await file.close();
				await this.path(name, signal);
				if (await this.read(name, signal) !== expected) throw new Error("Memory changed before publication");
				signal?.throwIfAborted();
				await this.authorize();
				signal?.throwIfAborted();
				await rename(temporary, target);
			} finally { await file.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
			return name === "MEMORY.md" ? indexWarning(content) : undefined;
		});
	}
	async candidates(signal?: AbortSignal): Promise<MemoryCandidate[]> {
		await this.authorize();
		await this.root(signal);
		const result: MemoryCandidate[] = [];
		let visited = 0;
		const walk = async (directory: string, depth: number): Promise<void> => {
			if (depth > 8) return;
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries) {
				signal?.throwIfAborted();
				if (++visited > 5000) throw new Error("Memory directory exceeds scan budget");
				if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) { if (await realpath(path) === path) await walk(path, depth + 1); }
				else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md") {
					const stat = await lstat(path);
					if (!stat.isSymbolicLink() && stat.isFile()) result.push({ name: relative(this.directory, path).split(sep).join("/"), description: "", modified: stat.mtimeMs });
				}
			}
		};
		await walk(this.directory, 0);
		const candidates = result.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name)).slice(0, 200);
		for (const candidate of candidates) {
			try {
				const text = await this.read(candidate.name, signal);
				candidate.description = text?.match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 500) ?? "";
			} catch (error) { signal?.throwIfAborted(); candidate.description = "Unavailable topic"; }
		}
		return candidates;
	}
}
