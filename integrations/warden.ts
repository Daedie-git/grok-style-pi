import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadFeatures } from "../src/features.ts";
import { registerStyledJev } from "../src/jev-style.ts";

export default async function warden(pi: ExtensionAPI) {
	const loaded = await import(join(getAgentDir(), "npm/node_modules/pi-warden/extensions/index.js")) as { default: ExtensionFactory };
	await registerStyledJev(pi, loaded.default, loadFeatures().toolStyling);
}
