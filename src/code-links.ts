import { existsSync } from "node:fs";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Parent, RootContent } from "mdast";
import { absPath } from "./open-in-cursor.ts";

export type FileReference = { path: string; line: number; column: number };

const LINE_SUFFIX = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/;

/** Cursor URL-handler target. Pi opens this with the system handler; do not spawn the Cursor CLI. */
export function cursorFileUrl(absolutePath: string, line = 1, column = 1): string {
	const slash = absolutePath.replaceAll("\\", "/");
	const rooted = slash.startsWith("/") ? slash : `/${slash}`;
	const encoded = rooted.split("/").map((segment) => segment.endsWith(":") ? segment : encodeURIComponent(segment)).join("/");
	return `cursor://file${encoded}:${Math.max(1, line)}:${Math.max(1, column)}`;
}

export function parseFileReference(text: string): FileReference | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > 300 || trimmed.includes("`")) return undefined;
	if (/^(?:https?|file|cursor|vscode):/i.test(trimmed)) return undefined;
	const suffix = LINE_SUFFIX.exec(trimmed);
	const body = suffix?.index ? trimmed.slice(0, suffix.index) : trimmed;
	if (!body || body.endsWith(":") || body.endsWith("#")) return undefined;
	const line = Number(suffix?.[1] ?? suffix?.[3] ?? 1);
	const column = Number(suffix?.[2] ?? suffix?.[4] ?? 1);
	if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return undefined;
	return { path: body, line, column };
}

function ambiguous(path: string): boolean {
	const name = path.split(/[\\/]/).pop() ?? path;
	return /\s/.test(path) || !/\.[A-Za-z0-9]{1,12}$/.test(name);
}

function resolveReference(reference: FileReference, cwd: string, exists: (path: string) => boolean): string | undefined {
	const raw = reference.path;
	const options = [raw];
	if (/^[ab][/\\]/.test(raw)) options.push(raw.slice(2));
	for (const option of options) {
		const absolute = absPath(option, cwd);
		if (exists(absolute)) return absolute;
	}
	if (ambiguous(raw)) return undefined;
	if (/[\\/]/.test(raw) || raw.startsWith("~")) return absPath(/^[ab][/\\]/.test(raw) ? raw.slice(2) : raw, cwd);
	return undefined;
}

function markdownLink(label: string, url: string): string {
	return `[${label}](<${url}>)`;
}

type Span = { start: number; end: number; text: string };

function inlineCodeSpans(markdown: string): Span[] {
	const spans: Span[] = [];
	const visit = (node: RootContent) => {
		if (node.type === "link" || node.type === "linkReference") return;
		if (node.type === "inlineCode" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
			spans.push({ start: node.position.start.offset, end: node.position.end.offset, text: node.value });
		}
		if ("children" in node) {
			for (const child of (node as Parent).children) visit(child);
		}
	};
	const tree = fromMarkdown(markdown);
	for (const child of tree.children) visit(child);
	return spans;
}

/** Turn standalone inline-code file references into cursor:// links. Code blocks stay plain. */
export function linkifyCodeReferences(
	markdown: string,
	cwd: string,
	exists: (path: string) => boolean = existsSync,
): string {
	const replacements = inlineCodeSpans(markdown).flatMap((span) => {
		const reference = parseFileReference(span.text);
		const absolute = reference && resolveReference(reference, cwd, exists);
		return absolute ? [{ ...span, replacement: markdownLink(markdown.slice(span.start, span.end), cursorFileUrl(absolute, reference.line, reference.column)) }] : [];
	});
	let result = markdown;
	for (const span of replacements.sort((left, right) => right.start - left.start)) {
		result = result.slice(0, span.start) + span.replacement + result.slice(span.end);
	}
	return result;
}
