import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, HookCommand, HookConfig, HookEventName, HookMatcherGroup } from "../types.ts";

export interface HookSources { agentDir: string; cwd: string; projectTrusted: boolean; definition?: AgentDefinition }
const events: HookEventName[] = ["SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"];
const mapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function loadHooks(sources: HookSources): { config: HookConfig; diagnostics: string[] } {
	const config: HookConfig = {};
	const diagnostics: string[] = [];
	function append(data: unknown, label: string): void {
		if (!mapping(data)) { diagnostics.push(`${label}: hooks must be an event mapping`); return; }
		if (Object.hasOwn(data, "hooks")) {
			if (!mapping(data.hooks)) { diagnostics.push(`${label}: hooks must be an event mapping`); return; }
			data = data.hooks;
		}
		for (const [event, groups] of Object.entries(data as Record<string, unknown>)) {
			if (!events.includes(event as HookEventName)) { diagnostics.push(`${label}: unsupported hook event ${event}`); continue; }
			if (!Array.isArray(groups)) { diagnostics.push(`${label}: ${event} must contain a list of matcher groups`); continue; }
			for (const group of groups) {
				if (!mapping(group) || !Array.isArray(group.hooks) || (group.matcher !== undefined && typeof group.matcher !== "string")) {
					diagnostics.push(`${label}: invalid ${event} matcher group`); continue;
				}
				if (group.matcher && group.matcher !== "*" && event.startsWith("Subagent")) {
					try { new RegExp(group.matcher as string); }
					catch { diagnostics.push(`${label}: invalid matcher regex ${group.matcher}; only exact matching is available`); }
				}
				const commands: HookCommand[] = [];
				for (const hook of group.hooks) {
					if (!mapping(hook) || hook.type !== "command") { diagnostics.push(`${label}: only command hooks are supported`); continue; }
					if (typeof hook.command !== "string" || !hook.command.trim()
						|| (hook.args !== undefined && (!Array.isArray(hook.args) || !hook.args.every((arg) => typeof arg === "string")))
						|| (hook.timeout !== undefined && (typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout) || hook.timeout <= 0))) {
						diagnostics.push(`${label}: invalid command hook`); continue;
					}
					commands.push({ type: "command", command: hook.command, ...(hook.args === undefined ? {} : { args: [...hook.args as string[]] }), ...(hook.timeout === undefined ? {} : { timeout: hook.timeout as number }) });
				}
				if (commands.length) {
					const entry: HookMatcherGroup = { ...(group.matcher === undefined ? {} : { matcher: group.matcher as string }), hooks: commands };
					(config[event as HookEventName] ??= []).push(entry);
				}
			}
		}
	}
	function file(path: string): void {
		try { append(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")), path); }
		catch (error) {
			if (!(mapping(error) && error.code === "ENOENT")) diagnostics.push(`${path}: ${String(error)}`);
		}
	}
	file(join(sources.agentDir, "hooks.json"));
	if (sources.projectTrusted) file(join(sources.cwd, ".pi", "hooks.json"));
	if (sources.definition?.hooks) {
		if (sources.definition.source === "package") diagnostics.push("Package definition hooks are ignored");
		else if (sources.definition.source === "project" && !sources.projectTrusted) diagnostics.push("Untrusted project definition hooks are ignored");
		else append(sources.definition.hooks, sources.definition.path ?? sources.definition.agentType);
	}
	return { config, diagnostics };
}

export function matching(config: HookConfig, event: HookEventName, matchValue?: string): HookCommand[] {
	return (config[event] ?? []).filter(({ matcher }) => {
		if (event === "TaskCreated" || event === "TaskCompleted" || !matcher || matcher === "*") return true;
		if (matchValue === undefined) return false;
		if (matcher === matchValue) return true;
		try { return new RegExp(matcher).test(matchValue); } catch { return false; }
	}).flatMap((group) => group.hooks);
}
