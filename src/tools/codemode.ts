import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { wrapWithDiamondRenderer } from "./renderer.ts";
import { registerToolExtension, type ToolTransform } from "./register-extension.ts";

/** Use Pi's public factory; preserve its sandbox, store, loadout, and inactive default. */
export async function registerStyledCodemode(pi: ExtensionAPI, factory: ExtensionFactory | undefined, enabled: boolean, styleTool: ToolTransform = wrapWithDiamondRenderer): Promise<void> {
	if (!enabled || !factory) return;
	await registerToolExtension(pi, factory, (tool) => tool.name === "codemode" ? styleTool(tool) : tool);
}
