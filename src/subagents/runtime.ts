/** Herdr panes get the pane runner. Every other Pi session keeps Pi Subagents. */
export function selectSubagentRuntime(env: NodeJS.ProcessEnv): "herdr" | "pi-subagents" {
	return env.HERDR_ENV === "1" ? "herdr" : "pi-subagents";
}
