import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ToolTransform = <T extends ToolDefinition<any, any, any>>(tool: T) => T;

/** Forward the owning extension's registrations; policy belongs to the caller. */
export async function registerToolExtension(pi: ExtensionAPI, factory: ExtensionFactory, transformTool: ToolTransform): Promise<void> {
	const descriptions = new Map<string, { original: string; transformed: string }>();
	await factory({
		...pi,
		registerTool(tool) {
			const transformed = transformTool(tool);
			descriptions.set(tool.name, { original: tool.description, transformed: transformed.description });
			pi.registerTool(transformed);
		},
		// Owners may use descriptions to recognize their own registrations.
		getAllTools() {
			return pi.getAllTools().map(tool => {
				const description = descriptions.get(tool.name);
				return description && tool.description === description.transformed
					? { ...tool, description: description.original }
					: tool;
			});
		},
	});
}
