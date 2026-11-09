/** Where subagent terminals open: a herdr server's panes, or the Herdr app's hc terminals. */
export type TerminalHost = "herdr" | "hc";

/**
 * The innermost host this process runs in: a herdr TUI started inside an app terminal uses herdr.
 * HERDR_SUBAGENTS_HOST=herdr|hc picks one of the hosts present.
 */
export function terminalHost(env: NodeJS.ProcessEnv): TerminalHost | undefined {
	const herdr = env.HERDR_ENV === "1";
	const hc = !!env.HC_TERMINAL_ID;
	if (env.HERDR_SUBAGENTS_HOST === "herdr") return herdr ? "herdr" : undefined;
	if (env.HERDR_SUBAGENTS_HOST === "hc") return hc ? "hc" : undefined;
	if (herdr && (env.HERDR_PANE_ID || !hc)) return "herdr";
	return hc ? "hc" : undefined;
}

/** This process's pane or terminal, empty outside one. */
export function hostPaneId(env: NodeJS.ProcessEnv, host: TerminalHost): string {
	return (host === "hc" ? env.HC_TERMINAL_ID : env.HERDR_PANE_ID) ?? "";
}
