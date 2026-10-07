import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMediaExtension } from "../src/media/extension.ts";

export { createMediaExtension, type MediaExtensionDeps } from "../src/media/extension.ts";
export { installMediaTools } from "../src/media/tools.ts";

/** Load instead of a Grok entrypoint when only image and video diamonds are wanted. */
export default function media(pi: ExtensionAPI): void {
	createMediaExtension(pi);
}
