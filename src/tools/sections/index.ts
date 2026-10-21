import { agentSummary, compactArgs, extractResultText } from "../diamond.ts";
import type { DiamondSection, SectionTable } from "../section.ts";
import { codemodeSection } from "./codemode.ts";
import { workflowSection } from "./workflow.ts";

export function textSection(title: string): DiamondSection {
	return {
		summary: (view) => ({ title, target: compactArgs(view.args, Infinity) }),
		body: (view) => view.isPartial || !view.result ? [] : [{ kind: "text", text: extractResultText(view.result), tone: view.isError ? "error" : "output" }],
	};
}

const agent = textSection("Agent");
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function taskSection(title: string): DiamondSection {
	return { ...textSection(title), summary(view) {
		const task = record(record(view.result?.details)?.task);
		const id = task?.id ?? view.args?.taskId;
		const status = task?.status ?? view.args?.status;
		return { title: id ? `Task #${String(id)}${status ? ` · ${String(status)}` : ""}` : title };
	} };
}
export const DEFAULT_SECTIONS: SectionTable = Object.freeze({
	codemode: codemodeSection,
	Workflow: workflowSection,
	RunWorkflow: workflowSection,
	Agent: { ...agent, summary: (view) => ({ title: agentSummary(view.args) }) },
	SendMessage: { ...textSection("Message"), summary: (view) => ({ title: `Message ${String(view.args?.to ?? "agent")}` }) },
	TaskStop: { ...textSection("Stop agent"), summary: (view) => ({ title: `Stop agent ${String(view.args?.task_id ?? view.args?.agent_id ?? "")}`.trim() }) },
	TaskCreate: taskSection("Create task"),
	TaskGet: taskSection("Read task"),
	TaskList: { ...textSection("List tasks"), summary: (view) => {
		const tasks = record(view.result?.details)?.tasks;
		return { title: Array.isArray(tasks) ? `Tasks · ${tasks.length}` : "List tasks" };
	} },
	TaskUpdate: taskSection("Update task"),
	get_subagent_result: textSection("Read agent result"),
	steer_subagent: textSection("Steer agent"),
	grep: textSection("Searched"),
	find: textSection("Found"),
	ls: textSection("Listed"),
});
