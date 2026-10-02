import { agentSummary, compactArgs, extractResultText } from "../diamond.ts";
import type { DiamondSection, SectionTable } from "../section.ts";
import { codemodeSection } from "./codemode.ts";

export function textSection(title: string): DiamondSection {
	return {
		summary: (view) => ({ title, target: compactArgs(view.args, Infinity) }),
		body: (view) => view.isPartial || !view.result ? [] : [{ kind: "text", text: extractResultText(view.result), tone: view.isError ? "error" : "output" }],
	};
}

const agent = textSection("Agent");
export const DEFAULT_SECTIONS: SectionTable = Object.freeze({
	codemode: codemodeSection,
	Agent: { ...agent, summary: (view) => ({ title: agentSummary(view.args) }) },
	get_subagent_result: textSection("Read agent result"),
	grep: textSection("Searched"),
	find: textSection("Found"),
	ls: textSection("Listed"),
});
