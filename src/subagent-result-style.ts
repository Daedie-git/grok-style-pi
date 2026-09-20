import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { wrapWithDiamondRenderer } from "./tools.ts";

/** Decorate registration, preserving the owning extension's execution and metadata. */
export async function registerStyledSubagents(pi: ExtensionAPI, factory: ExtensionFactory, enabled: boolean) {
	await factory({
		...pi,
		registerTool(tool) {
			if (!enabled || !["Agent", "get_subagent_result"].includes(tool.name)) return pi.registerTool(tool);
			const { renderCall, renderResult, renderShell } = wrapWithDiamondRenderer(tool);
			pi.registerTool({ ...tool, renderCall, renderResult, renderShell });
		},
	});
}
