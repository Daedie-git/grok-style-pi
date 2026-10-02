import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ToolTransform = <T extends ToolDefinition<any, any, any>>(tool: T) => T;

/** Forward the owning extension's registrations; policy belongs to the caller. */
export async function registerToolExtension(pi: ExtensionAPI, factory: ExtensionFactory, transformTool: ToolTransform): Promise<void> {
	await factory({
		...pi,
		registerTool(tool) { pi.registerTool(transformTool(tool)); },
	});
}
