import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "@sinclair/typebox";
import { captureHtmlPreview } from "../media/html-preview.ts";
import { absPath, type OpenTarget } from "../navigation/open-in-cursor.ts";
import { createShowImageTool } from "./show-image.ts";

/** HTML shares the image diamond and gesture contract; its target remains the original page. */
export function createShowHtmlTool(cwd: string, hooks: { onModifierOpen?: (target: OpenTarget) => void } = {}, capture = captureHtmlPreview) {
	const image = createShowImageTool(cwd, hooks, "Show HTML");
	return {
		...image,
		name: "show_html",
		label: "Show HTML",
		description: "Show a local HTML file to the user as a static screenshot in an expanded, closable diamond. Ctrl+click opens the original file in the default browser for interaction. Requires Chromium or Chrome. Only use trusted HTML: previewing runs its scripts and may load network resources. The preview is not sent to the model.",
		promptSnippet: "Share a local HTML page with a static preview and browser opening",
		promptGuidelines: ["After sharing HTML, include its path as a standalone inline-code reference so the user can open the interactive page in their browser."],
		parameters: Type.Object({ path: Type.String({ description: "Path to an existing local .html or .htm file." }) }),
		async execute(_id: string, args: { path: string }, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) {
			const path = absPath(args.path, ctx.cwd ?? cwd);
			if (![".html", ".htm"].includes(extname(path).toLowerCase())) throw new Error("show_html supports HTML and HTM files.");
			const info = await stat(path);
			if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error("HTML must be a file of at most 10 MB.");
			signal?.throwIfAborted();
			const data = await capture(path, signal);
			return { content: [{ type: "text" as const, text: `Displayed HTML: ${path}` }], details: { path, data, mimeType: "image/png" } };
		},
		startSession(nextCwd = cwd) { cwd = nextCwd; image.startSession(nextCwd); },
	};
}
