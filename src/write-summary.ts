import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { generateDiffString, type ToolsOptions } from "@earendil-works/pi-coding-agent";
import type { OriginalTool, ToolFactory } from "./tools.ts";

const MAX_BYTES = 64_000;
const MAX_DIFF_LINES = 1_000;
const MAX_PREVIEW = 16_000;

export type WriteSummary = {
	kind: "created" | "replaced" | "unknown";
	lines: number;
	preview: string;
	note?: string;
};

export function countLines(text: string): number {
	if (!text) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
	return lines;
}

async function snapshot(path: string): Promise<{ kind: WriteSummary["kind"]; text?: string }> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_BYTES) return { kind: "replaced" };
		const file = await open(path, "r");
		try {
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			return { kind: "replaced", ...(bytesRead <= MAX_BYTES ? { text: buffer.subarray(0, bytesRead).toString("utf8") } : {}) };
		} finally { await file.close(); }
	} catch (error) {
		return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "created" : "unknown" };
	}
}

/** Capture the previous contents inside Pi's write queue, immediately before writing. */
export function withWriteSummary(factory: ToolFactory<"write">, cwd: string, options?: ToolsOptions["write"]): OriginalTool {
	const original = factory(cwd, options);
	return { ...original, async execute(...args) {
		let summary: WriteSummary | undefined;
		let diff: string | undefined;
		const custom = options?.operations;
		const tracked = factory(cwd, { ...options, operations: {
			mkdir: custom?.mkdir ?? (async (dir) => { await mkdir(dir, { recursive: true }); }),
			async writeFile(path, content) {
				// Custom operations may target a remote filesystem; never inspect a local namesake.
				const before = custom ? { kind: "unknown" as const } : await snapshot(path);
				await (custom?.writeFile ?? writeFile)(path, content);
				summary = { kind: before.kind, lines: countLines(content), preview: content.slice(0, MAX_PREVIEW) };
				if (content.length > MAX_PREVIEW) summary.note = "Preview truncated; use read for the full file.";
				if (before.kind === "replaced") {
					if (before.text !== undefined && Buffer.byteLength(content) <= MAX_BYTES &&
						countLines(before.text) <= MAX_DIFF_LINES && summary.lines <= MAX_DIFF_LINES) {
						try {
							diff = generateDiffString(before.text, content).diff;
							summary.preview = "";
							summary.note = diff ? undefined : before.text === content ? "No content changes." : "File bytes changed without a line-level diff.";
						} catch { summary.note = "Diff unavailable; showing new contents."; }
					} else summary.note = "Diff unavailable or exceeds preview limits; showing new contents" + (content.length > MAX_PREVIEW ? " (truncated)." : ".");
				}
			},
		} });
		const result = await tracked.execute(...args);
		return summary ? { ...result, details: { ...(result.details as object ?? {}), grokWrite: summary, ...(diff ? { diff } : {}) } } : result;
	} };
}

export function writeSummary(details: unknown): WriteSummary | undefined {
	const value = (details as { grokWrite?: WriteSummary } | undefined)?.grokWrite;
	return value && ["created", "replaced", "unknown"].includes(value.kind) &&
		typeof value.lines === "number" && typeof value.preview === "string" ? value : undefined;
}
