import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { installGrokStyle } from "../extensions/install.ts";
import type { ToolTransform } from "../src/tools/register-extension.ts";
import { createHerdrSubagents } from "../src/herdr/extension.ts";
import { selectSubagentRuntime } from "../src/subagents/runtime.ts";
import { registerStyledSubagents } from "../src/subagents/result-style.ts";

export async function loadSubagentExtension(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv,
	load: { herdr: ExtensionFactory; current: ExtensionFactory },
	styling: boolean,
	styleTool?: ToolTransform,
) {
	await registerStyledSubagents(pi, selectSubagentRuntime(env) === "herdr" ? load.herdr : load.current, styling, styleTool);
}

/** Opt-in entrypoint replacing the npm package's direct extension entrypoint. */
export default async function subagents(pi: ExtensionAPI) {
	const { runtime, features } = await installGrokStyle(pi);
	if (selectSubagentRuntime(process.env) === "herdr") {
		await loadSubagentExtension(pi, process.env, { herdr: createHerdrSubagents(), current: unavailable }, features.toolStyling, runtime.styleTool);
		return;
	}
	const entrypoint = join(getAgentDir(), "npm", "node_modules", "@tintinweb", "pi-subagents", "src", "index.ts");
	const loaded = await import(entrypoint) as { default: ExtensionFactory };
	await loadSubagentExtension(pi, process.env, { herdr: unavailable, current: loaded.default }, features.toolStyling, runtime.styleTool);
}

const unavailable: ExtensionFactory = () => {
	throw new Error("Subagent runtime was selected without its factory");
};
