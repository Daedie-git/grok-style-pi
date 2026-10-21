import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentEngine } from "../src/extension.ts";

/** Standalone engine: no Grok theme, editor, footer, or tool styling. */
export default async function subagentEngine(pi: ExtensionAPI) {
	await createSubagentEngine()(pi);
}
