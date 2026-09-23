import { readFile, stat } from "node:fs/promises";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import { extname } from "node:path";
import { Image, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { absPath } from "../navigation/open-in-cursor.ts";
import { sanitizeToolText } from "./diamond.ts";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_BYTES = 10 * 1024 * 1024;

type ImageDetails = { data: string; mimeType: string; path: string };
type ImageState = { open: boolean; expanded: boolean };

/** A text-only tool result keeps Pi from appending an uncollapsible native image. */
export function createShowImageTool(cwd: string) {
	return {
		name: "show_image",
		label: "Show Image",
		description: "Show a local PNG, JPEG, GIF, or WebP image to the user in an expanded, closable diamond. Use this when sharing a screenshot. The tool displays the image to the user; it does not provide image pixels to the model. The path must point to an existing image file.",
		promptSnippet: "Share a local screenshot with the user in a closable image panel",
		parameters: Type.Object({ path: Type.String({ description: "Path to the image file to show." }) }),
		renderShell: "self" as const,
		async execute(_id: string, args: { path: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) {
			const path = absPath(args.path, ctx.cwd ?? cwd);
			const mimeType = MIME[extname(path).toLowerCase()];
			if (!mimeType) throw new Error("show_image supports PNG, JPEG, GIF, and WebP files.");
			const info = await stat(path);
			if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Image must be a file of at most 10 MB.");
			const data = (await readFile(path)).toString("base64");
			const image = mimeType === "image/png" ? { data, mimeType } : await convertToPng(data, mimeType);
			if (!image) throw new Error("Could not convert the image for terminal display.");
			return { content: [{ type: "text" as const, text: `Displayed image: ${path}` }], details: { path, ...image } };
		},
		renderCall(args: { path: string }, theme: { fg: (token: "toolTitle" | "text", text: string) => string }, context?: {
			state?: { grokImage?: ImageState }; expanded?: boolean; invalidate?: () => void;
		}) {
			const label = theme.fg("toolTitle", "◆ Show image") + " " + theme.fg("text", sanitizeToolText(args.path));
			return {
				invalidate() {},
				render(width: number) { return width > 0 ? [truncateToWidth(label, width)] : []; },
				handleMouse(event: TuiMouseEvent) {
				if (event.type !== "click" || event.button !== "left" || event.ctrl || !context?.state || !context.invalidate) return undefined;
				const display = context.state.grokImage;
				if (!display) return undefined;
				display.open = !display.open;
				context.invalidate();
				return { handled: true as const };
				},
			};
		},
		renderResult(result: { content: Array<{ type: string; text?: string }>; details?: ImageDetails }, options: { expanded: boolean; isPartial?: boolean }, theme: { fg: (token: "toolOutput" | "error", text: string) => string }, context?: {
			state?: { grokImage?: ImageState }; invalidate?: () => void; showImages?: boolean; isError?: boolean;
		}) {
			const state = context?.state;
			if (state) {
				state.grokImage ??= { open: true, expanded: options.expanded };
				if (state.grokImage.expanded !== options.expanded) {
					state.grokImage.expanded = options.expanded;
					state.grokImage.open = options.expanded;
				}
			}
			const details = result.details;
			const image = details?.data && details.mimeType && context?.showImages !== false && !context?.isError
				? new Image(details.data, details.mimeType, { fallbackColor: text => theme.fg("toolOutput", text) }, { maxWidthCells: 60 })
				: undefined;
			return {
				invalidate() { image?.invalidate(); },
				render(width: number) {
					if (options.isPartial || state?.grokImage?.open === false) return [];
					if (image) return image.render(width);
					return width > 0 ? [truncateToWidth(theme.fg(context?.isError ? "error" : "toolOutput", sanitizeToolText(result.content?.[0]?.text ?? "Image preview unavailable")), width)] : [];
				},
				handleMouse(event: TuiMouseEvent) {
					if (event.type !== "click" || event.button !== "left" || event.ctrl || !state?.grokImage || !context?.invalidate) return undefined;
					state.grokImage.open = !state.grokImage.open;
					context.invalidate();
					return { handled: true as const };
				},
			};
		},
	};
}
