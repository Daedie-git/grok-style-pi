export interface WorkflowAgentRequest {
	prompt: string;
	label?: string;
	phase?: string;
	schema?: Record<string, unknown>;
	model?: string;
	effort?: string;
	isolation?: "worktree";
	agentType?: string;
	disallowedTools?: string[];
	bashCommandClamp?: string[];
	runId: string;
	taskId: string;
	logicalIndex: number;
	attempt: number;
	signal: AbortSignal;
}
export interface WorkflowAgentResult {
	status: "completed" | "failed" | "killed";
	agentId: string;
	text: string;
	structured?: { ok: true; value: unknown } | { ok: false; error: string };
	outputTokens: number;
	stalled?: boolean;
	error?: string;
}
export interface WorkflowHost {
	runAgent(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>;
	sessionOutputTokens(): number;
	loadNamed(name: string): Promise<{ source: string; path: string } | undefined>;
	readScriptPath(path: string): Promise<{ source: string; canonicalPath: string }>;
	progress(event: WorkflowProgress): void;
}
export type WorkflowProgress =
	| { type: "agent"; logicalIndex: number; label?: string; phase?: string; state: "queued" | "start" | "done" | "failed" | "cached"; agentId?: string }
	| { type: "phase"; index: number; title: string }
	| { type: "log"; message: string };
