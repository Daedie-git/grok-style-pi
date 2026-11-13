import { terminalHost, type TerminalHost } from "../../packages/herdr-runner/src/host.ts";

/** Detect a terminal host for the combined entrypoint; the engine remains the default runner in either environment. */
export function selectSubagentRuntime(env: NodeJS.ProcessEnv): TerminalHost | "engine" {
	return terminalHost(env) ?? "engine";
}

/** The environment as seen without any terminal host, which selects the engine. */
export function withoutTerminalHost(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...env, HERDR_ENV: undefined, HC_TERMINAL_ID: undefined, HERDR_SUBAGENTS_HOST: undefined };
}
