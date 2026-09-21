import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** GrokNight diff_insert_bg / diff_delete_bg. Syntax colors stay on the text. */
export const INSERT_BG = "6;56;6";
export const DELETE_BG = "66;14;20";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type DiffKind = "header" | "skip" | "context" | "add" | "remove";
export type RenderRow = { kind: DiffKind | "plain"; text: string };

export type DiffPaint = {
	paint(token: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", text: string): string;
	inverse?: (text: string) => string;
};

export function expandTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

function graphemes(text: string): string[] {
	return [...segmenter.segment(text)].map((part) => part.segment);
}

function changedRange(before: string, after: string): { start: number; beforeEnd: number; afterEnd: number } | undefined {
	const oldChars = graphemes(before);
	const newChars = graphemes(after);
	let start = 0;
	let end = 0;
	while (start < Math.min(oldChars.length, newChars.length) && oldChars[start] === newChars[start]) start++;
	while (end < Math.min(oldChars.length, newChars.length) - start && oldChars[oldChars.length - end - 1] === newChars[newChars.length - end - 1]) end++;
	if (start >= oldChars.length - end && start >= newChars.length - end) return undefined;
	return { start, beforeEnd: oldChars.length - end, afterEnd: newChars.length - end };
}

type Piece = { start: number; end: number };

function visiblePieces(colored: string, plain: string): Piece[] {
	const offsets: number[] = [];
	let text = "";
	let index = 0;
	while (index < colored.length) {
		if (colored[index] === "\x1b") {
			const stop = colored.indexOf("m", index);
			index = stop === -1 ? colored.length : stop + 1;
			continue;
		}
		offsets.push(index);
		text += colored[index++];
	}
	if (text !== plain) return [];
	// Segment the complete text: an ANSI boundary may occur inside one grapheme.
	return [...segmenter.segment(text)].map((part) => ({
		start: offsets[part.index],
		end: offsets[part.index + part.segment.length - 1] + 1,
	}));
}

/** Insert emphasis into already highlighted text without slicing through a grapheme. */
export function emphasizeSpan(colored: string, plain: string, start: number, end: number, wrap: (text: string) => string): string {
	const pieces = visiblePieces(colored, plain);
	if (start >= end || start >= pieces.length) return colored;
	const from = pieces[start]?.start;
	const to = pieces[Math.min(end, pieces.length) - 1]?.end;
	if (from === undefined || to === undefined) return colored;
	// Keep every original syntax sequence, wrapping text runs individually so
	// a highlighter reset cannot cancel emphasis or change the suffix's color.
	const emphasized = colored.slice(from, to).split(/(\x1b\[[0-9;:]*m)/)
		.map((part) => part && !part.startsWith("\x1b") ? wrap(part) : part).join("");
	return colored.slice(0, from) + emphasized + colored.slice(to);
}

function classify(line: string): { kind: DiffKind; prefix: string; content: string } {
	if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@") || /^ \s*\.\.\.$/.test(line)) {
		return { kind: line.startsWith(" ") ? "skip" : "header", prefix: line, content: "" };
	}
	const numbered = /^([-+ ])(\s*\d+ )(.*)$/.exec(line);
	if (numbered) {
		const sign = numbered[1];
		return { kind: sign === "+" ? "add" : sign === "-" ? "remove" : "context", prefix: sign + numbered[2], content: expandTabs(numbered[3]) };
	}
	if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
		const sign = line[0];
		return { kind: sign === "+" ? "add" : sign === "-" ? "remove" : "context", prefix: sign, content: expandTabs(line.slice(1)) };
	}
	return { kind: "header", prefix: line, content: "" };
}

function highlightSide(lines: string[], highlight: (text: string) => string[] | undefined): string[] {
	if (lines.length === 0) return [];
	const colored = highlight(lines.join("\n"));
	return colored && colored.length === lines.length ? colored : lines;
}

/** Build self-contained diff rows. Each row owns its kind; backgrounds are applied later, per physical line. */
export function buildDiffRows(diff: string, theme: DiffPaint, highlight: (text: string) => string[] | undefined): RenderRow[] {
	const rows = diff.split("\n").map(classify);
	const oldLines: string[] = [];
	const newLines: string[] = [];
	const oldAt: number[] = [];
	const newAt: number[] = [];
	for (const row of rows) {
		oldAt.push(row.kind === "remove" || row.kind === "context" ? oldLines.length : -1);
		if (row.kind === "remove" || row.kind === "context") oldLines.push(row.content);
		newAt.push(row.kind === "add" || row.kind === "context" ? newLines.length : -1);
		if (row.kind === "add" || row.kind === "context") newLines.push(row.content);
	}
	const oldColored = highlightSide(oldLines, highlight);
	const newColored = highlightSide(newLines, highlight);
	const highlighted = rows.map((row, index) => {
		if (row.kind === "remove" || row.kind === "context") return oldColored[oldAt[index]] ?? row.content;
		if (row.kind === "add") return newColored[newAt[index]] ?? row.content;
		return "";
	});
	for (let index = 0; index + 1 < rows.length; index++) {
		if (rows[index].kind !== "remove" || rows[index + 1].kind !== "add" || !theme.inverse) continue;
		const range = changedRange(rows[index].content, rows[index + 1].content);
		if (!range) continue;
		highlighted[index] = emphasizeSpan(highlighted[index], rows[index].content, range.start, range.beforeEnd, theme.inverse);
		highlighted[index + 1] = emphasizeSpan(highlighted[index + 1], rows[index + 1].content, range.start, range.afterEnd, theme.inverse);
	}
	return rows.map((row, index) => {
		const token = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "toolDiffContext";
		return { kind: row.kind, text: theme.paint(token, row.prefix) + highlighted[index] };
	});
}

export function createdRows(preview: string, theme: DiffPaint, highlight: (text: string) => string[] | undefined): RenderRow[] {
	const source = expandTabs(preview.replace(/\n$/, ""));
	if (!source) return [];
	const plain = source.split("\n");
	const colored = highlight(source);
	const lines = colored && colored.length === plain.length ? colored : plain;
	const width = String(lines.length).length;
	return lines.map((line, index) => ({
		kind: "add",
		text: theme.paint("toolDiffAdded", `+${String(index + 1).padStart(width, " ")} `) + line,
	}));
}

function finishRow(line: string, width: number, kind: RenderRow["kind"]): string {
	const rgb = kind === "add" ? INSERT_BG : kind === "remove" ? DELETE_BG : undefined;
	if (!rgb) return line;
	const body = line.replaceAll("\x1b[0m", "\x1b[39m");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(body)));
	return `\x1b[48;2;${rgb}m${body}${pad}\x1b[0m`;
}

/** Wrap each logical row on its own, then paint that row's background. No style crosses into the next row. */
export function paintRows(rows: RenderRow[], width: number, indent = ""): string[] {
	if (width <= 0) return [];
	const inner = Math.max(1, width - indent.length);
	const lines: string[] = [];
	for (const row of rows) {
		for (const wrapped of wrapTextWithAnsi(row.text, inner)) {
			lines.push(finishRow(indent + wrapped, width, row.kind));
		}
	}
	return lines;
}
