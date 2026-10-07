import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenTarget } from "../navigation/open-in-cursor.ts";
import { createShowImageTool } from "../tools/show-image.ts";
import { createShowVideoTool } from "../tools/show-video.ts";

type MediaToolsApi = Pick<ExtensionAPI, "on" | "registerTool">;

/** Registers media before transcript restoration and owns every playback lifetime. */
export function installMediaTools(pi: MediaToolsApi, hooks: { onModifierOpen: (target: OpenTarget) => void }) {
	const video = createShowVideoTool(process.cwd(), hooks);
	let started = false;
	function register(cwd: string) {
		pi.registerTool(createShowImageTool(cwd, hooks));
		pi.registerTool(video);
	}
	register(process.cwd());
	pi.on("session_start", (_event, ctx) => {
		if (started) video.pauseAll();
		started = true;
		video.startSession(ctx.cwd);
		// Keep the same video owner: restored transcript rows already reference it.
		register(ctx.cwd);
	});
	pi.on("session_tree", () => video.pauseAll());
	pi.on("session_compact", () => video.pauseAll());
	pi.on("session_shutdown", () => video.dispose());
}
