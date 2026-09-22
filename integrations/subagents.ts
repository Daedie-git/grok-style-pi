import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadFeatures } from "../src/features.ts";
import { createHerdrSubagents } from "../src/herdr-subagents.ts";
import { selectSubagentRuntime } from "../src/herdr-subagent-runtime.ts";
import { registerStyledSubagents } from "../src/subagent-result-style.ts";

export async function loadSubagentExtension(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv,
	load: { herdr: ExtensionFactory; current: ExtensionFactory },
	styling: boolean,
) {
	await registerStyledSubagents(pi, selectSubagentRuntime(env) === "herdr" ? load.herdr : load.current, styling);
}

/** Opt-in entrypoint replacing the npm package's direct extension entrypoint. */
export default async function subagents(pi: ExtensionAPI) {
	const styling = loadFeatures().toolStyling;
	if (selectSubagentRuntime(process.env) === "herdr") {
		await loadSubagentExtension(pi, process.env, { herdr: createHerdrSubagents(), current: unavailable }, styling);
		return;
	}
	const entrypoint = join(getAgentDir(), "npm", "node_modules", "@tintinweb", "pi-subagents", "src", "index.ts");
	const loaded = await import(entrypoint) as { default: ExtensionFactory };
	await loadSubagentExtension(pi, process.env, { herdr: unavailable, current: loaded.default }, styling);
}

const unavailable: ExtensionFactory = () => {
	throw new Error("Subagent runtime was selected without its factory");
};
