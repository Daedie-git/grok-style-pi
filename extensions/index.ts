import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGrokStyle } from "./install.ts";

export { createGrokStyleExtension } from "../src/extension.ts";
export { renderFooter, type FooterInput } from "../src/chrome/footer.ts";
export { renderComposerFrame, composerBorderToken } from "../src/chrome/composer.ts";
export { formatToolCall, formatToolResult } from "../src/tools/diamond.ts";
export { wrapWithDiamondRenderer, BUILTIN_TOOL_NAMES } from "../src/tools/renderer.ts";

export default async function grokStylePi(pi: ExtensionAPI): Promise<void> {
	await installGrokStyle(pi);
}
