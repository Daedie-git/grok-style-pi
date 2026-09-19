import { createGrokStyleExtension } from "../src/extension.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { createGrokStyleExtension } from "../src/extension.ts";
export { formatFooterLine, footerFromContext } from "../src/footer.ts";
export { renderComposerFrame, composerBorderToken } from "../src/composer.ts";
export { formatToolCall, formatToolResult } from "../src/diamond.ts";
export { wrapWithDiamondRenderer, BUILTIN_TOOL_NAMES } from "../src/tools.ts";

export default async function grokStylePi(pi: ExtensionAPI): Promise<void> {
	const agent = await import("@earendil-works/pi-coding-agent");
	createGrokStyleExtension(pi, {
		CustomEditor: agent.CustomEditor,
		tools: {
			read: agent.createReadTool,
			bash: agent.createBashTool,
			powershell: agent.createPowerShellTool,
			edit: agent.createEditTool,
			write: agent.createWriteTool,
			grep: agent.createGrepTool,
			find: agent.createFindTool,
			ls: agent.createLsTool,
		},
	});
}
