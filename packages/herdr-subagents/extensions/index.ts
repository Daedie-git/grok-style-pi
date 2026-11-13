import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrSubagents } from "../src/herdr/extension.ts";
import { terminalHost } from "herdr-runner/host.ts";

/** Standalone runner: no Grok theme, editor, footer, or tool styling. */
export default async function herdrSubagents(pi: ExtensionAPI) {
	if (!terminalHost(process.env)) return;
	await createHerdrSubagents()(pi);
}
