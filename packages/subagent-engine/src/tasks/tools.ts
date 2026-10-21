import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "./store.ts";

export const TASK_TOOL_NAMES = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"] as const;

function result<T extends object>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

/** Bind the same task list to root and child tool runtimes. A getter supports session rebinding. */
export function registerTaskTools(pi: ExtensionAPI, input: {
	store: () => TaskStore;
	caller: { agentId?: string };
	tools?: ("TaskCreate" | "TaskGet" | "TaskList" | "TaskUpdate")[];
}): void {
	const current = input.store;
	const allowed = new Set<string>(input.tools ?? TASK_TOOL_NAMES);
	const register: ExtensionAPI["registerTool"] = tool => {
		if (allowed.has(tool.name)) pi.registerTool(tool);
	};
	register(defineTool({
		name: "TaskCreate",
		label: "Create Task",
		description: "Record a unit of work in the shared task list. Supply a concise subject and a description of the expected outcome. New tasks are pending and unassigned. Optional metadata stores task-specific data; activeForm describes ongoing work for display. A creation hook may refuse the task.",
		parameters: Type.Object({
			subject: Type.String({ description: "A short task title." }),
			description: Type.String({ description: "The work and its expected outcome." }),
			activeForm: Type.Optional(Type.String({ description: "A present-tense progress label." })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Additional task data keyed by name." })),
		}),
		execute: async (_toolCallId, params) => {
			const created = await current().create(params);
			if (created.error !== undefined) throw new Error(created.error);
			if (!created.task) throw new Error("Task was removed before creation completed.");
			return result({ task: created.task });
		},
	}));
	register(defineTool({
		name: "TaskGet",
		label: "Get Task",
		description: "Read one shared task by its taskId, including its description, owner, status, dependencies and metadata. A missing task returns task: null. Task identifiers refer to work items, not subagent runs.",
		parameters: Type.Object({ taskId: Type.String({ description: "The task identifier to read." }) }),
		execute: async (_toolCallId, params) => result({ task: await current().get(params.taskId) }),
	}));
	register(defineTool({
		name: "TaskList",
		label: "List Tasks",
		description: "Read summaries from the shared task list in numeric identifier order. Summaries include subject, status, owner when assigned, and unfinished dependencies. Internal tasks and completed blockers are hidden from these summaries. Use TaskGet for full task details. This lists work items, not running agents.",
		parameters: Type.Object({}),
		execute: async () => result({ tasks: await current().list() }),
	}));
	register(defineTool({
		name: "TaskUpdate",
		label: "Update Task",
		description: "Change fields of a shared task by taskId. Owner is a direct assignment, not a claim. Add dependency edges with addBlocks or addBlockedBy; existing edges are retained and missing endpoints are ignored. Metadata merges by key, with null removing a key. Completed tasks retain dependencies; deleted tasks are removed and their references cleaned up. A completion hook can refuse the entire update.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The task identifier to change." }),
			subject: Type.Optional(Type.String({ description: "Replacement task title." })),
			description: Type.Optional(Type.String({ description: "Replacement work description." })),
			activeForm: Type.Optional(Type.String({ description: "Replacement progress label." })),
			status: Type.Optional(Type.Union([
				Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted"),
			])),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Tasks that depend on this task." })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Tasks this task depends on." })),
			owner: Type.Optional(Type.String({ description: "Replacement owner identity." })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Keys to merge; null removes a key." })),
		}),
		execute: async (_toolCallId, params) => {
			const { taskId, ...patch } = params;
			const updated = await current().update(taskId, patch);
			if (updated.error !== undefined) throw new Error(updated.error);
			return result({ task: updated.task ?? null, updatedFields: updated.updatedFields });
		},
	}));
}
