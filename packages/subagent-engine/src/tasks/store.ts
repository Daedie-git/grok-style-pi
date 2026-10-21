import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, missing, object, StoreCorruptionError } from "../store/journal.ts";
import { lockDirectory } from "./lock.ts";

export interface SharedTask {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
	status: "pending" | "in_progress" | "completed";
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}
export interface TaskHooks {
	created?(task: SharedTask): Promise<{ block?: string }>;
	completed?(before: SharedTask): Promise<{ block?: string }>;
}
export interface TaskPatch {
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: SharedTask["status"] | "deleted";
	addBlocks?: string[];
	addBlockedBy?: string[];
	owner?: string;
	metadata?: Record<string, unknown>;
}
type UpdateResult = { task?: SharedTask | null; error?: string; updatedFields: string[] };

export function sanitizeListId(id: string): string {
	const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	// Windows reserves these basenames even when used as directories.
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? `_${safe}` : safe || "default";
}
export function resolveTaskListId(env: Record<string, string | undefined>, rootSessionId: string): string {
	return sanitizeListId(env.PI_TASK_LIST_ID || rootSessionId);
}
function taskId(id: string): string {
	if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error(`Invalid task id: ${id}`);
	return id;
}
function ascending(a: string, b: string): number { return Number(a) - Number(b); }

/** Compatibility semantics, hardened with atomic replacement and one shared lock domain.
 * List-before-task serialization also covers edge enumeration, preventing delete/add races.
 * Edges remain separate writes, not a crash-atomic multi-record transaction.
 */
export class TaskStore {
	private readonly dir: string;
	private readonly hooks: TaskHooks;
	private readonly now: () => number;
	constructor(input: { root: string; listId: string; hooks?: TaskHooks; now?: () => number }) {
		this.dir = join(input.root, sanitizeListId(input.listId));
		this.hooks = input.hooks ?? {};
		this.now = input.now ?? Date.now;
		mkdirSync(this.dir, { recursive: true });
	}
	private file(id: string): string { return join(this.dir, `${taskId(id)}.json`); }
	private ids(): string[] {
		return readdirSync(this.dir).filter(name => /^[1-9][0-9]*\.json$/.test(name)).map(name => name.slice(0, -5)).sort(ascending);
	}
	private read(id: string): SharedTask | null {
		const file = this.file(id);
		let text: string;
		try { text = readFileSync(file, "utf8"); } catch (error) { if (missing(error)) return null; throw error; }
		try {
			const value: unknown = JSON.parse(text);
			if (!object(value) || value.id !== id || typeof value.subject !== "string" || typeof value.description !== "string"
				|| !["pending", "in_progress", "completed"].includes(value.status as string)
				|| !Array.isArray(value.blocks) || !Array.isArray(value.blockedBy)
				|| ![...value.blocks, ...value.blockedBy].every(edge => typeof edge === "string")) throw new Error("Invalid task record");
			return value as unknown as SharedTask;
		} catch (error) { throw new StoreCorruptionError(file, error); }
	}
	private write(task: SharedTask): void { atomicWrite(this.file(task.id), JSON.stringify(task) + "\n"); }
	private watermark(): number {
		try {
			const text = readFileSync(join(this.dir, ".highwatermark"), "utf8").trim();
			if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new StoreCorruptionError(join(this.dir, ".highwatermark"));
			return Number(text);
		} catch (error) { if (missing(error)) return 0; throw error; }
	}
	private raiseWatermark(id: number): void {
		atomicWrite(join(this.dir, ".highwatermark"), String(Math.max(id, this.watermark())) + "\n");
	}
	private async transaction<T>(extraIds: string[], action: () => T, listLock = true): Promise<T> {
		const releaseList = listLock ? await lockDirectory(join(this.dir, ".lock"), this.now) : () => {};
		const releases: (() => void)[] = [];
		try {
			// Cross-record operations enumerate and lock under the list lock.
			const ids = listLock ? [...this.ids(), ...extraIds] : extraIds;
			for (const id of [...new Set(ids)].sort(ascending)) {
				releases.push(await lockDirectory(this.file(id) + ".lock", this.now));
			}
			return action();
		} finally {
			for (const release of releases.reverse()) release();
			releaseList();
		}
	}
	private remove(id: string): void {
		this.raiseWatermark(Number(id));
		try { unlinkSync(this.file(id)); } catch (error) { if (!missing(error)) throw error; }
		for (const otherId of this.ids()) {
			const other = this.read(otherId)!;
			if (!other.blocks.includes(id) && !other.blockedBy.includes(id)) continue;
			other.blocks = other.blocks.filter(edge => edge !== id);
			other.blockedBy = other.blockedBy.filter(edge => edge !== id);
			this.write(other);
		}
	}
	async create(input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): Promise<{ task?: SharedTask; error?: string }> {
		// Allocate under the list lock; the new task lock is acquired before writing.
		const releaseList = await lockDirectory(join(this.dir, ".lock"), this.now);
		let task: SharedTask;
		try {
			const id = String(Math.max(this.watermark(), ...this.ids().map(Number), 0) + 1);
			const releaseTask = await lockDirectory(this.file(id) + ".lock", this.now);
			try {
				task = structuredClone({ ...input, id, status: "pending", blocks: [], blockedBy: [] });
				this.raiseWatermark(Number(id));
				this.write(task);
			} finally { releaseTask(); }
		} finally { releaseList(); }
		const result = await this.hooks.created?.(structuredClone(task));
		if (result?.block !== undefined) {
			await this.transaction([task.id], () => this.remove(task.id));
			return { error: result.block };
		}
		return { task: await this.get(task.id) ?? undefined };
	}
	async get(id: string): Promise<SharedTask | null> { return this.read(id); }
	async list(): Promise<{ id: string; subject: string; status: string; owner?: string; blockedBy: string[] }[]> {
		const tasks = this.ids().map(id => this.read(id)).filter((task): task is SharedTask => task !== null);
		const completed = new Set(tasks.filter(task => task.status === "completed").map(task => task.id));
		return tasks.filter(task => !task.metadata?._internal).map(task => ({
			id: task.id, subject: task.subject, status: task.status,
			...(task.owner === undefined ? {} : { owner: task.owner }),
			blockedBy: task.blockedBy.filter(id => !completed.has(id)),
		}));
	}
	async update(id: string, patch: TaskPatch): Promise<UpdateResult> {
		taskId(id);
		// Hook decisions apply only to the exact stored snapshot they examined.
		for (let retry = 0; retry < 30; retry++) {
			const before = this.read(id);
			if (!before) return { task: null, error: "Task not found", updatedFields: [] };
			const completing = patch.status === "completed" && before.status !== "completed";
			const hook = completing ? await this.hooks.completed?.(structuredClone(before)) : undefined;
			const result = await this.transaction([id], (): UpdateResult | undefined => {
				const task = this.read(id);
				if (!task) return { task: null, error: "Task not found", updatedFields: [] };
				if (completing && JSON.stringify(task) !== JSON.stringify(before)) return undefined;
				// A concurrent reopening must not bypass completion admission either.
				if (!completing && patch.status === "completed" && task.status !== "completed") return undefined;
				if (hook?.block !== undefined) return { error: hook.block, updatedFields: [] };
				if (patch.status === "deleted") { this.remove(id); return { task: null, updatedFields: ["status"] }; }
				const fields: string[] = [];
				for (const key of ["subject", "description", "activeForm", "owner", "status"] as const) {
					if (patch[key] === undefined) continue;
					Object.assign(task, { [key]: patch[key] });
					this.write(task);
					fields.push(key);
				}
				if (patch.metadata !== undefined) {
					const metadata = { ...task.metadata };
					for (const [key, value] of Object.entries(patch.metadata)) {
						if (value === null) delete metadata[key];
						else Object.defineProperty(metadata, key, { value, writable: true, configurable: true, enumerable: true });
					}
					task.metadata = metadata;
					this.write(task);
					fields.push("metadata");
				}
				for (const key of ["addBlocks", "addBlockedBy"] as const) {
					if (patch[key] === undefined) continue;
					const ownEdge = key === "addBlocks" ? "blocks" : "blockedBy";
					const reciprocal = key === "addBlocks" ? "blockedBy" : "blocks";
					for (const endpoint of new Set(patch[key])) {
						if (!/^[1-9][0-9]*$/.test(endpoint)) continue;
						const other = endpoint === id ? task : this.read(endpoint);
						if (!other) continue;
						if (!task[ownEdge].includes(endpoint)) { task[ownEdge].push(endpoint); this.write(task); }
						if (!other[reciprocal].includes(id)) { other[reciprocal].push(id); this.write(other); }
					}
					fields.push(key);
				}
				return { task, updatedFields: fields };
			}, patch.status === "deleted" || patch.addBlocks !== undefined || patch.addBlockedBy !== undefined);
			if (result) return result;
		}
		return { error: "Task changed repeatedly during completion admission", updatedFields: [] };
	}
	async claim(id: string, owner: string, options?: { busyCheck?: boolean }): Promise<{ ok: boolean; reason?: string }> {
		return this.transaction([taskId(id)], () => {
			const task = this.read(id);
			if (!task) return { ok: false, reason: "Task not found" };
			if (task.owner && task.owner !== owner) return { ok: false, reason: "Task owned by another agent" };
			if (task.status === "completed") return { ok: false, reason: "Task completed" };
			if (task.blockedBy.some(blocker => { const other = this.read(blocker); return other && other.status !== "completed"; })) return { ok: false, reason: "Task has open blockers" };
			if (options?.busyCheck && this.ids().some(otherId => {
				const other = this.read(otherId)!;
				return otherId !== id && other.owner === owner && other.status !== "completed";
			})) return { ok: false, reason: "Owner already has unfinished work" };
			task.owner = owner;
			this.write(task);
			return { ok: true };
		}, options?.busyCheck === true);
	}
}
