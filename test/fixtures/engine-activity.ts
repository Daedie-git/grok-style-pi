import type { AgentSnapshot, EngineEvent } from "../../packages/subagent-engine/src/engine.ts";
import type { AgentMeta, RunOutcome } from "../../packages/subagent-engine/src/types.ts";
import type { ActivityEngine } from "../../src/subagents/adapter.ts";

export const outcome = (status: RunOutcome["status"] = "completed", resultText = "finished"): RunOutcome => ({
	status, classification: status === "killed" ? "killed" : status === "failed" ? "failed" : "completed", resultText,
	usage: { billable: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, latestFootprint: 0, liveMetric: 0, modelTransitions: [] },
	toolStats: { toolUses: 0, byTool: {} }, durationMs: 1,
});
export const meta = (agentId = "one", runId = "r1"): AgentMeta => ({
	agentId, agentType: "Explore", description: "inspect build", rootSessionId: "root", spawnDepth: 1, cwd: "/cwd", sessionFile: "/child.jsonl", taskListId: "root", backend: "in-process",
	definition: { agentType: "Explore", description: "Explore", prompt: "", source: "built-in", disallowedTools: [], skills: [], diagnostics: [] },
	model: { effective: "grok-4.6" }, effort: { effective: "high" }, stopGeneration: 0, runs: [{ runId, invocation: "spawn", startedAt: 1, status: "running" }],
});
export const agentSnapshot = (agentId = "one", runId = "r1"): AgentSnapshot => ({
	agentId, runId, agentType: "Explore", description: "inspect build", backend: "in-process", disposition: "running", running: true,
	status: "running", startedAt: 1, model: "grok-4.6", effort: "high", depth: 1,
});
export class FakeEngine implements ActivityEngine {
	snapshots: AgentSnapshot[] = [];
	agentSnapshots(): AgentSnapshot[] { return structuredClone(this.snapshots); }
	readonly listeners = new Set<(event: EngineEvent) => void>();
	readonly stops: string[] = [];
	stopError?: Error;
	subscribe(fn: (event: EngineEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
	async userStop(id: string) { if (this.stopError) throw this.stopError; this.stops.push(id); }
	emit(event: EngineEvent) { for (const fn of this.listeners) fn(event); }
	spawn(agentId = "one", runId = "r1") { this.emit({ type: "spawned", agentId, runId, meta: meta(agentId, runId) }); }
	text(delta: string, agentId = "one", runId = "r1") { this.emit({ type: "run-event", agentId, runId, event: { type: "text", delta } }); }
	settle(status: RunOutcome["status"] = "completed", agentId = "one", runId = "r1") { this.emit({ type: "settled", agentId, runId, outcome: outcome(status) }); }
}
