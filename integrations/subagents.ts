import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadFeatures } from "../src/features.ts";
import { registerStyledSubagents } from "../src/subagent-result-style.ts";

/** Opt-in entrypoint replacing the npm package's direct extension entrypoint. */
export default async function subagents(pi: ExtensionAPI) {
	const entrypoint = join(getAgentDir(), "npm", "node_modules", "@tintinweb", "pi-subagents", "src", "index.ts");
	const loaded = await import(entrypoint) as { default: ExtensionFactory };
	await registerStyledSubagents(pi, loaded.default, loadFeatures().toolStyling);
}
