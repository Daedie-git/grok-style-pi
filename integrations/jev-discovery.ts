import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadFeatures } from "../src/features.ts";
import { registerStyledJev } from "../src/jev-style.ts";

/** Defaults to the sibling checkout; override for other installations. */
export default async function discovery(pi: ExtensionAPI) {
	const path = process.env.GROK_JEV_DISCOVERY_EXTENSION || resolve(fileURLToPath(new URL("../../pi-jev-discovery-pilot/extension.ts", import.meta.url)));
	const loaded = await import(path) as { default: ExtensionFactory };
	await registerStyledJev(pi, loaded.default, loadFeatures().toolStyling);
}
