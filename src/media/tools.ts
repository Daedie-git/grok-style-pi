import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenTarget } from "../navigation/open-in-cursor.ts";
import { createShowImageTool } from "../tools/show-image.ts";
import { createShowHtmlTool } from "../tools/show-html.ts";
import { createShowVideoTool } from "../tools/show-video.ts";

type MediaToolsApi = Pick<ExtensionAPI, "on" | "registerTool">;

/** Registers media before transcript restoration and owns every playback lifetime. */
export function installMediaTools(pi: MediaToolsApi, hooks: { onModifierOpen: (target: OpenTarget) => void }) {
	const image = createShowImageTool(process.cwd(), hooks);
	const html = createShowHtmlTool(process.cwd(), hooks);
	const video = createShowVideoTool(process.cwd(), hooks);
	let started = false;
	pi.registerTool(image);
	pi.registerTool(html);
	pi.registerTool(video);
	pi.on("session_start", (_event, ctx) => {
		if (started) video.pauseAll();
		started = true;
		// Restored transcript rows already reference these renderer owners.
		image.startSession(ctx.cwd);
		html.startSession(ctx.cwd);
		video.startSession(ctx.cwd);
	});
	pi.on("session_tree", () => video.pauseAll());
	pi.on("session_compact", () => video.pauseAll());
	pi.on("session_shutdown", () => video.dispose());
}
