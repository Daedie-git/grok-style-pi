import { layoutTool } from "./tool-layout.ts";
import { parentPort } from "node:worker_threads";
import { buildDiffRows, defaultDiffPalette } from "./diff-render.ts";
import { highlightWithBat } from "./bat-highlight.ts";
import type { VisualRequest, VisualResult } from "./visual-preparation.ts";

parentPort!.on("message", (request: VisualRequest) => {
	try {
		const fallbacks = new Map(request.fallbacks);
		let retry = false;
		const highlight = (text: string) => {
			const lines = highlightWithBat(text, request.filePath, request.lang, request.colors);
			if (!lines) retry = true;
			return lines ?? fallbacks.get(text);
		};
		const result: VisualResult = request.kind === "layout" ? {
			lines: layoutTool(request.text, request.rows ?? [], request.width ?? 0, request.palette ?? defaultDiffPalette, request.background),
		} : request.kind === "highlight" ? { lines: highlight(request.text) } : {
			rows: buildDiffRows(request.text, {
				paint: (token, text) => request.paint?.[token]?.replace("\0", () => text) ?? text,
			}, highlight, request.palette),
		};
		parentPort!.postMessage({ result: retry ? { ...result, retry: true } : result });
	} catch (error) { parentPort!.postMessage({ error: String(error) }); }
});
