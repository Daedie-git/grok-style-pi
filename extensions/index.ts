import { loadFeatures, installFeatureSettings } from "../src/extension/features.ts";
import { loadStyleColors, useStyleColors } from "../src/chrome/style-colors.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { loadToolOptions } from "../src/tools/settings.ts";
import { installActivityPanel } from "../src/activity/panel.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { createGrokStyleExtension } from "../src/extension.ts";
export { formatFooterLine, footerFromContext } from "../src/chrome/footer.ts";
export { renderComposerFrame, composerBorderToken } from "../src/chrome/composer.ts";
export { formatToolCall, formatToolResult } from "../src/tools/diamond.ts";
export { wrapWithDiamondRenderer, BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";

export default async function grokStylePi(pi: ExtensionAPI): Promise<void> {
	const agent = await import("@earendil-works/pi-coding-agent");
	const features = loadFeatures();
	useStyleColors(loadStyleColors());
	installFeatureSettings(pi);
	const activity = features.activity ? installActivityPanel(pi) : undefined;
	createGrokStyleExtension(pi, {
		features,
		wrapTool: activity?.wrapTool,
		CustomEditor: agent.CustomEditor,
		getToolOptions: loadToolOptions,
		tools: {
			read: agent.createReadToolDefinition,
			bash: agent.createBashToolDefinition,
			powershell: agent.createPowerShellToolDefinition,
			edit: agent.createEditToolDefinition,
			write: agent.createWriteToolDefinition,
			grep: agent.createGrepToolDefinition,
			find: agent.createFindToolDefinition,
			ls: agent.createLsToolDefinition,
		},
	});
}
