import { readFileSync } from "node:fs";
import { join } from "node:path";
import { limitsFromEnv, type ControlLimits } from "./control.ts";

export interface DelegationLimits extends ControlLimits { workflowsEnabled: boolean }

/** Only the host profile supplies defaults; a project cannot lift delegation limits. */
export function delegationLimits(env: Record<string, string | undefined>, agentDir?: string): DelegationLimits {
	let settings: Record<string, unknown> = {};
	if (agentDir) {
		const path = join(agentDir, "subagents.json");
		try {
			settings = JSON.parse(readFileSync(path, "utf8"));
			if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read delegation settings from ${path}; expected a JSON object.`);
		}
	}
	const depth = settings.maxSubagentDepth;
	const workflows = settings.workflowsEnabled;
	if (depth !== undefined && (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 1)) throw new Error("subagents.json: maxSubagentDepth must be a positive integer.");
	if (workflows !== undefined && typeof workflows !== "boolean") throw new Error("subagents.json: workflowsEnabled must be a boolean.");
	return {
		...limitsFromEnv(env, depth),
		workflowsEnabled: env.PI_SUBAGENT_WORKFLOW === undefined ? workflows ?? true : env.PI_SUBAGENT_WORKFLOW !== "0",
	};
}
