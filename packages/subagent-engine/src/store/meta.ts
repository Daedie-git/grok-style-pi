import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMeta } from "../types.ts";
import { atomicWrite, missing, object, StoreCorruptionError } from "./journal.ts";

export { StoreCorruptionError } from "./journal.ts";

function validMeta(value: unknown): value is AgentMeta {
	if (!object(value)) return false;
	return ["agentId", "agentType", "description", "rootSessionId", "cwd", "sessionFile", "taskListId"].every(key => typeof value[key] === "string")
		&& Number.isInteger(value.spawnDepth) && Number.isInteger(value.stopGeneration)
		&& (value.backend === "in-process" || value.backend === "herdr")
		&& object(value.definition) && typeof value.definition.agentType === "string"
		&& Array.isArray(value.runs);
}

export function writeMeta(file: string, meta: AgentMeta): void {
	atomicWrite(file, JSON.stringify(meta, null, 2) + "\n");
}

export function readMeta(file: string): AgentMeta | undefined {
	let text: string;
	try { text = readFileSync(file, "utf8"); } catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (!validMeta(value)) throw new Error("Invalid agent metadata");
		return value;
	} catch (error) { throw new StoreCorruptionError(file, error); }
}

export function listMetas(dir: string): AgentMeta[] {
	let names: string[];
	try { names = readdirSync(dir); } catch (error) {
		if (missing(error)) return [];
		throw error;
	}
	const metas: AgentMeta[] = [];
	for (const name of names.sort()) {
		if (!/^agent-.+\.meta\.json$/.test(name)) continue;
		const meta = readMeta(join(dir, name));
		if (meta) metas.push(meta);
	}
	return metas;
}
