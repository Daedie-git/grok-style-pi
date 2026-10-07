import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { isMediaPath, openMedia } from "../navigation/open-media.ts";
import type { OpenTarget } from "../navigation/open-in-cursor.ts";
import { createSessionLinks } from "../navigation/session-links.ts";
import { installMediaTools } from "./tools.ts";

type MediaExtensionApi = Pick<ExtensionAPI, "on" | "registerTool"> & Partial<Pick<ExtensionAPI, "registerMarkdownTransformer">>;
export type MediaExtensionDeps = {
	openMedia?: (target: OpenTarget) => Promise<void>;
	hyperlinks?: () => boolean;
};

/** Media-only extension: no chrome, built-in overrides, or global prompt replacement. */
export function createMediaExtension(pi: MediaExtensionApi, deps: MediaExtensionDeps = {}): void {
	let generation = 0;
	let notify: ((message: string, kind: "error") => void) | undefined;
	let active = true;
	async function open(target: OpenTarget): Promise<boolean> {
		if (!active || !isMediaPath(target.path)) return false;
		const current = generation;
		try {
			await (deps.openMedia ?? openMedia)(target);
			return active && current === generation;
		} catch (error) {
			if (active && current === generation) notify?.(`Failed to open media: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	}
	const links = createSessionLinks(pi, {
		enabled: true, open, hyperlinks: deps.hyperlinks, accepts: isMediaPath,
		fallbackUrl: reference => pathToFileURL(reference.path).href,
	});
	installMediaTools(pi, { onModifierOpen(target) { void open(target); } });
	pi.on("session_start", (_event, ctx) => {
		generation++;
		active = true;
		notify = ctx.ui.notify?.bind(ctx.ui);
		links.startSession(ctx);
	});
	pi.on("session_shutdown", () => {
		generation++;
		active = false;
		notify = undefined;
		links.dispose();
	});
}
