import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { getCapabilities, Image, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { absPath } from "../navigation/open-in-cursor.ts";
import { sanitizeToolText } from "./diamond.ts";
import { playVideoFrames } from "./video-frames.ts";

const EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"]);
type VideoState = {
	open: boolean;
	expanded: boolean;
	frame?: string;
	image?: Image;
	error?: string;
	stop?: () => void;
	onUpdate?: () => void;
	showImages?: boolean;
};

/** A tool result stores the path, never the video or its decoded frames. */
export function createShowVideoTool(cwd: string) {
	const active = new Set<VideoState>();
	let disposed = false;
	function stop(state: VideoState) {
		state.stop?.();
		state.stop = undefined;
		active.delete(state);
	}
	function toggle(state: VideoState, invalidate: () => void) {
		state.open = !state.open;
		if (!state.open) stop(state);
		else { state.error = undefined; state.frame = undefined; state.image = undefined; }
		invalidate();
	}
	return {
		name: "show_video",
		label: "Show Video",
		description: "Play a local video to the user in a closable diamond. Use this to share a video clip. Playback is a silent, low-frame-rate terminal preview; provide the video file path in your reply so the user can open it in their default video player for full playback with sound. Supports MP4, M4V, MOV, MKV, WebM, and AVI. The tool does not provide video frames to the model.",
		promptSnippet: "Share a local video as a silent animated preview",
		parameters: Type.Object({ path: Type.String({ description: "Path to an existing local video file." }) }),
		renderShell: "self" as const,
		async execute(_id: string, args: { path: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) {
			const path = absPath(args.path, ctx.cwd ?? cwd);
			if (!EXTENSIONS.has(extname(path).toLowerCase())) throw new Error("Unsupported video format.");
			if (!(await stat(path)).isFile()) throw new Error("Video path must be a file.");
			return { content: [{ type: "text" as const, text: `Video preview: ${path}. Include this path in your reply for full playback with sound.` }], details: { path } };
		},
		renderCall(args: { path: string }, theme: { fg: (token: "toolTitle" | "text", text: string) => string }, context?: {
			state?: { grokVideo?: VideoState }; invalidate?: () => void;
		}) {
			const label = theme.fg("toolTitle", "◆ Play video") + " " + theme.fg("text", sanitizeToolText(args.path));
			return {
				invalidate() {},
				render(width: number) { return width > 0 ? [truncateToWidth(label, width)] : []; },
				handleMouse(event: TuiMouseEvent) {
				if (disposed || event.type !== "click" || event.button !== "left" || event.ctrl || !context?.state?.grokVideo || !context.invalidate) return undefined;
				toggle(context.state.grokVideo, context.invalidate);
				return { handled: true as const };
				},
			};
		},
		renderResult(result: { content: Array<{ type: string; text?: string }>; details?: { path: string } }, options: { expanded: boolean; isPartial?: boolean }, theme: { fg: (token: "toolOutput" | "error", text: string) => string }, context?: {
			state?: { grokVideo?: VideoState }; invalidate?: () => void; showImages?: boolean; isError?: boolean;
		}) {
			const owner = context?.state;
			if (owner) {
				owner.grokVideo ??= { open: true, expanded: options.expanded };
				if (owner.grokVideo.expanded !== options.expanded) {
					owner.grokVideo.expanded = options.expanded;
					owner.grokVideo.open = options.expanded;
					if (!options.expanded) stop(owner.grokVideo);
				}
				owner.grokVideo.onUpdate = context?.invalidate;
				owner.grokVideo.showImages = context?.showImages !== false;
				if (!owner.grokVideo.showImages || context?.isError) {
					stop(owner.grokVideo);
					owner.grokVideo.frame = undefined;
					owner.grokVideo.image = undefined;
				}
			}
			const state = owner?.grokVideo;
			const path = result.details?.path;
			return {
				invalidate() { state?.image?.invalidate(); },
				render(width: number) {
					if (options.isPartial || state?.open === false || width <= 0) return [];
					if (disposed) return [truncateToWidth(theme.fg("toolOutput", "Video preview is no longer active."), width)];
					const blocks = Array.isArray(result.content) ? result.content : [];
					const text = blocks.find(block => typeof block?.text === "string")?.text;
					if (context?.isError) return [truncateToWidth(theme.fg("error", sanitizeToolText(typeof text === "string" ? text : "error")), width)];
					const imagesEnabled = (state?.showImages ?? context?.showImages !== false) && Boolean(getCapabilities().images);
					if (!imagesEnabled && state) {
						stop(state);
						state.frame = undefined;
						state.image = undefined;
					}
					if (state && path && imagesEnabled && !state.stop && !state.error) {
						// Reconstructed transcript rows must not leave several decoders running.
						for (const playing of active) {
							if (playing === state) continue;
							playing.open = false;
							stop(playing);
							playing.onUpdate?.();
						}
						active.add(state);
						state.stop = playVideoFrames(path, (frame) => {
							state.frame = frame;
							state.image = new Image(frame, "image/png", { fallbackColor: text => theme.fg("toolOutput", text) },
								{ maxWidthCells: 60, maxHeightCells: 14, imageId: state.image?.getImageId() });
							state.onUpdate?.();
						}, (error) => { state.error = sanitizeToolText(error).slice(0, 500); stop(state); state.onUpdate?.(); });
						if (state.error) stop(state);
					}
					if (state?.error) return [truncateToWidth(theme.fg("error", state.error), width)];
					if (state?.image) return state.image.render(width);
					return [truncateToWidth(theme.fg("toolOutput", sanitizeToolText(!imagesEnabled ? "Terminal image playback unavailable; open the file in your video player." : path ? "Loading video preview…" : typeof text === "string" ? text : "Video unavailable")), width)];
				},
				handleMouse(event: TuiMouseEvent) {
					if (disposed || event.type !== "click" || event.button !== "left" || event.ctrl || !state || !context?.invalidate) return undefined;
					toggle(state, context.invalidate);
					return { handled: true as const };
				},
			};
		},
		startSession() { disposed = false; },
		pauseAll() {
			for (const state of active) {
				state.open = false;
				stop(state);
				state.frame = undefined;
				state.image = undefined;
				state.onUpdate = undefined;
			}
		},
		dispose() {
			disposed = true;
			for (const state of active) { stop(state); state.onUpdate = undefined; }
		},
	};
}
