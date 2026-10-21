import { createHash } from "node:crypto";

export interface JournalResult { type: "result"; key: string; agentId: string; result: unknown }
export interface JournalStarted { type: "started"; key: string; agentId: string; label?: string; phase?: string }
export interface ReplayState {
	previousKey: string;
	liveTail: boolean;
	loadedResults: Map<string, JournalResult>;
	loadedStarted: Map<string, JournalStarted[]>;
	loadedFailed: Set<string>;
}
export function createReplayState(input?: { results: Map<string, JournalResult>; started: Map<string, JournalStarted[]>; failed: Set<string> }): ReplayState {
	return { previousKey: "", liveTail: false, loadedResults: input?.results ?? new Map(), loadedStarted: input?.started ?? new Map(), loadedFailed: input?.failed ?? new Set() };
}
const fields = ["schema", "model", "effort", "isolation", "agentType", "disallowedTools", "bashCommandClamp"];
function sorted(value: unknown, active = new Set<object>()): unknown {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value === null || typeof value !== "object") return value;
	if (active.has(value)) throw new TypeError("Cyclic workflow options");
	active.add(value);
	try {
		if (Array.isArray(value)) return value.map(item => sorted(item, active));
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value).sort()) if (key !== "__proto__") result[key] = sorted((value as Record<string, unknown>)[key], active);
		return result;
	} finally { active.delete(value); }
}
export function canonicalOptions(opts: Record<string, unknown> = {}): string {
	const selected: Record<string, unknown> = Object.create(null);
	for (const key of fields) if (Object.hasOwn(opts, key)) selected[key] = opts[key];
	return JSON.stringify(sorted(selected));
}
export function chainKey(previous: string, prompt: string, opts: Record<string, unknown> = {}): string {
	return `v2:${createHash("sha256").update(previous).update("\0").update(prompt).update("\0").update(canonicalOptions(opts)).digest("hex")}`;
}
export function chooseReplay(prompt: string, opts: Record<string, unknown>, state: ReplayState): { key: string; cached: unknown } | { key: string; executeLive: true } {
	const key = chainKey(state.previousKey, prompt, opts);
	state.previousKey = key;
	if (!state.liveTail && state.loadedResults.has(key)) return { key, cached: structuredClone(state.loadedResults.get(key)!.result) };
	const interrupted = !state.liveTail && (state.loadedStarted.get(key)?.length ?? 0) > 0 && !state.loadedFailed.has(key);
	if (!interrupted) state.liveTail = true;
	return { key, executeLive: true };
}
