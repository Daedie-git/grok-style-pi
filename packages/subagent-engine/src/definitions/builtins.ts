import type { AgentDefinition, BuiltInKind } from "../types.ts";

/** Applied to a conversation fork, independently of a fresh child's system prompt. */
export const FORK_DIRECTIVE = (task: string): string => [
	"Use the inherited conversation only as reference for the single assignment below. Do exactly this assignment, not the unfinished work of the parent conversation.",
	"Work directly: never delegate to another agent. Finish with one report; do not ask follow-up questions or propose next steps. If you make commits, include their hashes in that report.",
	"Assignment:", task,
].join("\n\n");

export function builtInDefinitions(options: { forkEnabled: boolean }): AgentDefinition[] {
	const make = (agentType: BuiltInKind, description: string, prompt: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
		agentType, description, prompt, source: "built-in", builtIn: agentType,
		model: "inherit", disallowedTools: [], skills: [], diagnostics: [], ...extra,
	});
	const readOnly = "Use file reading, search and nonmutating shell commands only. Do not change files or delegate. Shell access is not a read-only security guarantee: you remain responsible for choosing commands without side effects.";
	const definitions = [
		make("general-purpose", "Carry out a bounded research or implementation assignment that needs the available tools.",
			"Complete the assigned scope yourself and check the result. Create new files only when the work requires them, and do not add documentation that was not requested. Never hand your entire assignment to another worker. Report the outcome and any remaining limitations."),
		make("Explore", "Locate relevant code, files and implementation relationships; not a code review or audit.",
			`${readOnly}\nLocate code rather than reviewing or auditing it. Honor the requested search breadth: quick means a focused lookup, medium means follow the main related paths, and very thorough means inspect the wider set of plausible locations and references. Return concrete paths and findings inline in your answer; never create report files.`,
			{ disallowedTools: ["edit", "write", "Agent"], omitClaudeMd: true }),
		make("Plan", "Inspect existing code and propose an implementation plan with trade-offs and critical files.",
			`${readOnly}\nRead the supplied files and inspect nearby patterns before designing changes. Compare the material trade-offs. Return an ordered implementation sequence and identify 3–5 critical file paths, explaining their roles. Return the plan inline, not in a new file.`,
			{ disallowedTools: ["edit", "write", "Agent"], omitClaudeMd: true }),
	];
	if (options.forkEnabled) definitions.push(make("fork", "Perform one explicit assignment using a snapshot of the parent's conversation; never the default agent choice.",
		"The runtime supplies the parent's system prompt, model, effort and exact tools. Follow the separate single-assignment fork directive.", { maxTurns: 200 }));
	return definitions;
}
