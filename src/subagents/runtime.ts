/** Detect Herdr availability for the combined entrypoint; the engine remains the default runner in either environment. */
export function selectSubagentRuntime(env: NodeJS.ProcessEnv): "herdr" | "engine" {
	return env.HERDR_ENV === "1" ? "herdr" : "engine";
}
