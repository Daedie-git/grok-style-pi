import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentDefaults } from "../../packages/subagent-engine/src/engine.ts";
import { featureSettingsPath, readSettingsObject } from "../chrome/style-colors.ts";

const efforts = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const mapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Read only model/effort preferences; prompts and tool restrictions stay in agent definitions. */
export function loadSubagentSettings(path = featureSettingsPath()): AgentDefaults {
	const values = readSettingsObject(path).subagents;
	if (values === undefined) return {};
	if (!mapping(values)) throw new Error("Grok subagents must be an object keyed by agent type");
	return Object.fromEntries(Object.entries(values).map(([name, value]) => {
		const label = `Grok subagents.${name}`;
		if (!name.trim() || name !== name.trim()) throw new Error("Grok subagent types must be non-empty names without surrounding whitespace");
		if (!mapping(value)) throw new Error(`${label} must be an object`);
		for (const key of Object.keys(value)) {
			if (key !== "model" && key !== "effort") throw new Error(`${label}.${key} is unsupported; use model or effort`);
		}
		if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) throw new Error(`${label}.model must be a non-empty model name or inherit`);
		if (value.effort !== undefined && !efforts.has(value.effort as ThinkingLevel)) throw new Error(`${label}.effort must be ${[...efforts].join(", ")}`);
		return [name, {
			...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
			...(value.effort !== undefined ? { effort: value.effort as ThinkingLevel } : {}),
		}];
	}));
}
