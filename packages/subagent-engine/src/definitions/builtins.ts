import type { AgentDefinition, BuiltInKind } from "../types.ts";

/** Applied to a conversation fork, independently of a fresh child's system prompt. */
export const FORK_DIRECTIVE = (task: string): string => [
	"Use the inherited conversation only as reference for the single assignment below. Do exactly this assignment, not the unfinished work of the parent conversation.",
	"Work directly: never delegate to another agent. Finish with one report; do not ask follow-up questions or propose next steps. If you make commits, include their hashes in that report.",
	"Assignment:", task,
].join("\n\n");

/** `claudeCode`: Herdr can launch Claude Code panes, which the adversarial reviewer needs. */
export function builtInDefinitions(options: { forkEnabled: boolean; claudeCode?: boolean }): AgentDefinition[] {
	const make = (agentType: BuiltInKind, description: string, prompt: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
		agentType, description, prompt, source: "built-in", builtIn: agentType,
		model: "inherit", disallowedTools: [], skills: [], diagnostics: [], ...extra,
	});
	const readOnly = "Use file reading, search and nonmutating shell commands only. Do not change files or delegate. Shell access is not a read-only security guarantee: you remain responsible for choosing commands without side effects.";
	const reviewPrompt = `${readOnly}\nReview work you did not produce. Do not implement changes or write or patch code. Read the actual files and diffs, challenge assumptions and incorrect claims, and look for missed edge cases, tests that do not prove the claimed change, hidden coupling, stale assumptions and anything the implementer would be biased to skip. Quote file paths and line numbers. If you cannot verify a claim, say so. Report findings with evidence and severity, what you checked that looks fine, and what you did not check.`;
	const reviewOptions: Partial<AgentDefinition> = { tools: ["read", "grep", "find", "ls", "bash"], disallowedTools: ["edit", "write", "Agent"], isolated: true, omitClaudeMd: true, effort: "high" };
	const definitions = [
		make("general-purpose", "Carry out a bounded research or implementation assignment that needs the available tools.",
			"Do what has been asked; nothing more, nothing less. Complete the assigned scope yourself and check the result. Prefer editing existing files to creating new ones, and create documentation files only when asked. Leave changes you did not make. When the task needs a decision beyond what it says, call needs_answer instead of deciding. Never hand your entire assignment to another worker. Report the outcome and any remaining limitations."),
		make("explore", "Locate relevant code, files and implementation relationships; not a code review or audit.",
			`${readOnly}\nLocate the code, files and relationships the task asks about. You find and explain code; you do not review or audit it. Honor the requested breadth: quick means a focused lookup, medium means following the main related paths, very thorough means inspecting every plausible location and reference. When the question needs a decision beyond what it says, call needs_answer instead of deciding. Report concrete paths and findings inline, with absolute file paths; never create report files.`,
			{ disallowedTools: ["edit", "write", "Agent"], omitClaudeMd: true }),
		make("plan", "Inspect existing code and propose an implementation plan with trade-offs and critical files.",
			`${readOnly}\nRead the supplied files and inspect nearby patterns before designing changes. Compare the material trade-offs. Return an ordered implementation sequence and identify 3–5 critical file paths, explaining their roles. Return the plan inline, not in a new file.`,
			{ disallowedTools: ["edit", "write", "Agent"], omitClaudeMd: true }),
		make("researcher", "Answer a question from high-trust primary sources such as official docs, specifications and release notes.",
			`${readOnly}\nInvestigate the question against high-trust primary sources: official documentation, specifications, release notes, source code and the authors' own statements. Prefer the source closest to the fact and check that it covers the version in question. When the question needs a decision beyond what it says, call needs_answer instead of deciding. Report the findings inline, cite each claim's source with its URL or absolute path, and say what you could not verify or where sources disagree.`,
			{ disallowedTools: ["edit", "write", "Agent"], omitClaudeMd: true }),
		make("review", "Read-only review of a change or plan on your own model. Attacks assumptions, missing tests, and incorrect claims. Does not implement.",
			reviewPrompt, reviewOptions),
	];
	if (options.claudeCode) definitions.push(make("adversarial-reviewer", "Read-only review of a change or plan by Claude Code (Opus 5.5), a model family other than yours. Same scope as review.",
		reviewPrompt, { ...reviewOptions, runtime: "claude-code", model: "claude-opus-5-5" }));
	if (options.forkEnabled) definitions.push(make("fork", "Perform one explicit assignment using a snapshot of the parent's conversation; never the default agent choice.",
		"The runtime supplies the parent's system prompt, model, effort and exact tools. Follow the separate single-assignment fork directive.", { maxTurns: 200 }));
	return definitions;
}
