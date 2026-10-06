import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrSubagents } from "../src/herdr/extension.ts";

/** Standalone runner: no Grok theme, editor, footer, or tool styling. */
export default async function herdrSubagents(pi: ExtensionAPI) {
	if (process.env.HERDR_ENV !== "1") return;
	await createHerdrSubagents()(pi);
}
