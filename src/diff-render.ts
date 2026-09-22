import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** GrokNight diff_insert_bg / diff_delete_bg. Syntax colors stay on the text. */
export const INSERT_BG = "6;56;6";
export const DELETE_BG = "66;14;20";
/** Stronger than the row background. The last accepted character pair before the darker experiment. */
export const INSERT_CHAR_BG = "12;91;16";
export const DELETE_CHAR_BG = "108;26;34";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type DiffKind = "header" | "skip" | "context" | "add" | "remove";
export type RenderRow = { kind: DiffKind | "plain"; text: string };

export type DiffPaint = {
	paint(token: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", text: string): string;
};

export function expandTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

function graphemes(text: string): string[] {
	return [...segmenter.segment(text)].map((part) => part.segment);
}

type Range = { start: number; end: number };
type SeqDiff = { a: Range; b: Range };

const MAX_DIFF_CELLS = 200_000;

function diffChanges(a: string[], b: string[]): SeqDiff[] {
	const n = a.length;
	const m = b.length;
	if (n === 0 && m === 0) return [];
	if (n === 0) return [{ a: { start: 0, end: 0 }, b: { start: 0, end: m } }];
	if (m === 0) return [{ a: { start: 0, end: n }, b: { start: 0, end: 0 } }];
	if (n * m > 1_000_000) return edgeDiff(a, b);
	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] = a[i] === b[j]
				? dp[(i + 1) * width + j + 1] + 1
				: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}
	const changes: SeqDiff[] = [];
	let i = 0;
	let j = 0;
	let changeA = 0;
	let changeB = 0;
	let open = false;
	const close = (endA: number, endB: number) => {
		if (!open) return;
		changes.push({ a: { start: changeA, end: endA }, b: { start: changeB, end: endB } });
		open = false;
	};
	while (i < n && j < m) {
		if (a[i] === b[j] && dp[i * width + j] === dp[(i + 1) * width + j + 1] + 1) {
			close(i, j);
			i++;
			j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			if (!open) { changeA = i; changeB = j; open = true; }
			i++;
		} else {
			if (!open) { changeA = i; changeB = j; open = true; }
			j++;
		}
	}
	if (i < n || j < m) {
		if (!open) { changeA = i; changeB = j; open = true; }
		close(n, m);
	}
	return changes;
}

function shiftDelta(diff: SeqDiff, amount: number): SeqDiff {
	return {
		a: { start: diff.a.start + amount, end: diff.a.end + amount },
		b: { start: diff.b.start + amount, end: diff.b.end + amount },
	};
}

function joinDiff(left: SeqDiff, right: SeqDiff): SeqDiff {
	return {
		a: { start: Math.min(left.a.start, right.a.start), end: Math.max(left.a.end, right.a.end) },
		b: { start: Math.min(left.b.start, right.b.start), end: Math.max(left.b.end, right.b.end) },
	};
}

function inRange(seq: string[], index: number): boolean {
	return index >= 0 && index < seq.length;
}

/** Slide a pure insertion or deletion onto a punctuation or whitespace boundary, then join neighbors that meet. */
function joinByShifting(a: string[], b: string[], diffs: SeqDiff[]): SeqDiff[] {
	if (diffs.length === 0) return diffs;
	const shifted: SeqDiff[] = [diffs[0]];
	for (let index = 1; index < diffs.length; index++) {
		const previous = shifted[shifted.length - 1];
		let current = diffs[index];
		if (current.a.start === current.a.end || current.b.start === current.b.end) {
			const gap = current.a.start - previous.a.end;
			let distance = 1;
			for (; distance <= gap; distance++) {
				const aLeft = current.a.start - distance;
				const aRight = current.a.end - distance;
				const bLeft = current.b.start - distance;
				const bRight = current.b.end - distance;
				if (!inRange(a, aLeft) || !inRange(a, aRight) || !inRange(b, bLeft) || !inRange(b, bRight)) break;
				if (a[aLeft] !== a[aRight] || b[bLeft] !== b[bRight]) break;
			}
			distance--;
			if (distance === gap) {
				shifted[shifted.length - 1] = {
					a: { start: previous.a.start, end: current.a.end - gap },
					b: { start: previous.b.start, end: current.b.end - gap },
				};
				continue;
			}
			current = shiftDelta(current, -distance);
		}
		shifted.push(current);
	}
	const result: SeqDiff[] = [];
	for (let index = 0; index < shifted.length - 1; index++) {
		const next = shifted[index + 1];
		let current = shifted[index];
		if (current.a.start === current.a.end || current.b.start === current.b.end) {
			const gap = next.a.start - current.a.end;
			let distance = 0;
			for (; distance < gap; distance++) {
				const aLeft = current.a.start + distance;
				const aRight = current.a.end + distance;
				const bLeft = current.b.start + distance;
				const bRight = current.b.end + distance;
				if (!inRange(a, aLeft) || !inRange(a, aRight) || !inRange(b, bLeft) || !inRange(b, bRight)) break;
				if (a[aLeft] !== a[aRight] || b[bLeft] !== b[bRight]) break;
			}
			if (distance === gap) {
				shifted[index + 1] = {
					a: { start: current.a.start + gap, end: next.a.end },
					b: { start: current.b.start + gap, end: next.b.end },
				};
				continue;
			}
			if (distance > 0) current = shiftDelta(current, distance);
		}
		result.push(current);
	}
	if (shifted.length > 0) result.push(shifted[shifted.length - 1]);
	return result;
}

const Boundary = {
	WordLower: 0,
	WordUpper: 1,
	WordNumber: 2,
	End: 3,
	Other: 4,
	Separator: 5,
	Space: 6,
	CarriageReturn: 7,
	LineFeed: 8,
} as const;

type Boundary = (typeof Boundary)[keyof typeof Boundary];

function boundaryCategory(grapheme: string | undefined): Boundary {
	if (grapheme === undefined) return Boundary.End;
	if (grapheme === "\n") return Boundary.LineFeed;
	if (grapheme === "\r") return Boundary.CarriageReturn;
	if (grapheme === " " || grapheme === "\t") return Boundary.Space;
	if (grapheme === "," || grapheme === ";") return Boundary.Separator;
	const code = grapheme.codePointAt(0) ?? -1;
	if (code >= 97 && code <= 122) return Boundary.WordLower;
	if (code >= 65 && code <= 90) return Boundary.WordUpper;
	if (code >= 48 && code <= 57) return Boundary.WordNumber;
	if (/^\p{L}/u.test(grapheme)) return Boundary.WordLower;
	if (/^\p{N}/u.test(grapheme)) return Boundary.WordNumber;
	return Boundary.Other;
}

const boundaryWeight: Record<Boundary, number> = {
	[Boundary.WordLower]: 0,
	[Boundary.WordUpper]: 0,
	[Boundary.WordNumber]: 0,
	[Boundary.End]: 10,
	[Boundary.Other]: 2,
	[Boundary.Separator]: 30,
	[Boundary.Space]: 3,
	[Boundary.CarriageReturn]: 10,
	[Boundary.LineFeed]: 10,
};

function boundaryScore(seq: string[], position: number): number {
	const previous = boundaryCategory(position > 0 ? seq[position - 1] : undefined);
	const next = boundaryCategory(position < seq.length ? seq[position] : undefined);
	if (previous === Boundary.CarriageReturn && next === Boundary.LineFeed) return 0;
	if (previous === Boundary.LineFeed) return 150;
	let score = 0;
	if (previous !== next) {
		score += 10;
		if (previous === Boundary.WordLower && next === Boundary.WordUpper) score += 1;
	}
	score += boundaryWeight[previous] + boundaryWeight[next];
	return score;
}

function shiftEmptyDiffs(a: string[], b: string[], diffs: SeqDiff[]): SeqDiff[] {
	return diffs.map((diff, index) => {
		const previous = diffs[index - 1];
		const next = diffs[index + 1];
		const aValid = {
			start: previous ? previous.a.end + 1 : 0,
			end: next ? next.a.start - 1 : a.length,
		};
		const bValid = {
			start: previous ? previous.b.end + 1 : 0,
			end: next ? next.b.start - 1 : b.length,
		};
		if (diff.a.start === diff.a.end) return shiftToBoundary(diff, a, b, aValid, bValid);
		if (diff.b.start === diff.b.end) {
			const swapped = shiftToBoundary({ a: diff.b, b: diff.a }, b, a, bValid, aValid);
			return { a: swapped.b, b: swapped.a };
		}
		return diff;
	});
}

function shiftToBoundary(diff: SeqDiff, anchor: string[], moved: string[], anchorValid: Range, movedValid: Range): SeqDiff {
	let before = 1;
	while (
		diff.a.start - before >= anchorValid.start &&
		diff.b.start - before >= movedValid.start &&
		before < 100 &&
		inRange(moved, diff.b.start - before) &&
		inRange(moved, diff.b.end - before) &&
		moved[diff.b.start - before] === moved[diff.b.end - before]
	) before++;
	before--;
	let after = 0;
	while (
		diff.a.start + after < anchorValid.end &&
		diff.b.end + after < movedValid.end &&
		after < 100 &&
		inRange(moved, diff.b.start + after) &&
		inRange(moved, diff.b.end + after) &&
		moved[diff.b.start + after] === moved[diff.b.end + after]
	) after++;
	if (before === 0 && after === 0) return diff;
	let best = 0;
	let bestScore = -1;
	for (let amount = -before; amount <= after; amount++) {
		const score = boundaryScore(anchor, diff.a.start + amount)
			+ boundaryScore(moved, diff.b.start + amount)
			+ boundaryScore(moved, diff.b.end + amount);
		if (score > bestScore) {
			bestScore = score;
			best = amount;
		}
	}
	return shiftDelta(diff, best);
}

function isWord(grapheme: string): boolean {
	const code = grapheme.codePointAt(0) ?? -1;
	if (code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122) return true;
	return /^\p{L}/u.test(grapheme) || /^\p{N}/u.test(grapheme);
}

function isMidWord(seq: string[], index: number): boolean {
	return index > 0 && index < seq.length && isWord(seq[index - 1]) && isWord(seq[index]);
}

function growToWord(seq: string[], range: Range): Range {
	let { start, end } = range;
	if (isMidWord(seq, start)) {
		while (start > 0 && isWord(seq[start - 1])) start--;
	}
	if (isMidWord(seq, end)) {
		while (end < seq.length && isWord(seq[end])) end++;
	}
	return { start, end };
}

function extendToWords(a: string[], b: string[], diffs: SeqDiff[]): SeqDiff[] {
	const grown = diffs.map((diff) => ({ a: growToWord(a, diff.a), b: growToWord(b, diff.b) }));
	const merged: SeqDiff[] = [];
	for (const diff of grown) {
		const previous = merged[merged.length - 1];
		if (previous && (previous.a.end >= diff.a.start || previous.b.end >= diff.b.start)) merged[merged.length - 1] = joinDiff(previous, diff);
		else merged.push(diff);
	}
	return merged;
}

/** VS Code's removeShortMatches: an unchanged gap of two graphemes or fewer is part of the change. */
function mergeShortGaps(diffs: SeqDiff[]): SeqDiff[] {
	const merged: SeqDiff[] = [];
	for (const diff of diffs) {
		const previous = merged[merged.length - 1];
		if (previous && (diff.a.start - previous.a.end <= 2 || diff.b.start - previous.b.end <= 2)) merged[merged.length - 1] = joinDiff(previous, diff);
		else merged.push(diff);
	}
	return merged;
}

function edgeDiff(a: string[], b: string[]): SeqDiff[] {
	let start = 0;
	const limit = Math.min(a.length, b.length);
	while (start < limit && a[start] === b[start]) start++;
	let end = 0;
	while (end < limit - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	if (start >= a.length - end && start >= b.length - end) return [];
	return [{ a: { start, end: a.length - end }, b: { start, end: b.length - end } }];
}

function sharedEdges(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let start = 0;
	while (start < limit && a[start] === b[start]) start++;
	let end = 0;
	while (end < limit - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	return start + end;
}

function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0 || b.length === 0) return a.length + b.length;
	const prev = new Uint16Array(b.length + 1);
	const next = new Uint16Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		next[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const keep = a[i - 1] === b[j - 1] ? 0 : 1;
			next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + keep);
		}
		prev.set(next);
	}
	return prev[b.length];
}

/** Edit distance when the lines are short enough; otherwise shared ends plus an interior window. */
function substitutionCost(a: string, b: string): number {
	const indel = a.length + b.length;
	let distance: number;
	// An empty side makes the size product zero, so it must not enter the 16-bit distance table.
	if (a.length > 0 && b.length > 0 && a.length <= 8_000 && b.length <= 8_000 && a.length * b.length <= 8_000) distance = editDistance(a, b);
	else {
		const windows = new Map<string, number>();
		for (let i = 0; i <= a.length - 4; i++) {
			const key = a.slice(i, i + 4);
			windows.set(key, (windows.get(key) ?? 0) + 1);
		}
		let interior = 0;
		const used = new Map<string, number>();
		for (let i = 0; i <= b.length - 4; i++) {
			const key = b.slice(i, i + 4);
			const seen = used.get(key) ?? 0;
			if (seen < (windows.get(key) ?? 0)) {
				used.set(key, seen + 1);
				interior++;
			}
		}
		const shared = Math.min(a.length, b.length, Math.max(sharedEdges(a, b), interior));
		distance = indel - 2 * shared;
	}
	// A longer line that merely shares a short tail must not outrank a closer match.
	return distance * 2 < indel ? distance : indel;
}

/** Pair changed lines by edit cost so an insertion in the middle does not shift later replacements. */
function alignPairs(oldLines: string[], newLines: string[]): Array<{ old: number; new: number }> {
	const n = oldLines.length;
	const m = newLines.length;
	if (n === 1 && m === 1) return [{ old: 0, new: 0 }];
	if (n === 0 || m === 0 || n * m > 10_000) return [];
	const del = oldLines.map((line) => Math.max(1, line.length));
	const ins = newLines.map((line) => Math.max(1, line.length));
	const sub = oldLines.map((old) => newLines.map((line) => substitutionCost(old, line)));
	const dp = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
	const choice = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		dp[i][0] = dp[i - 1][0] + del[i - 1];
		choice[i][0] = 1;
	}
	for (let j = 1; j <= m; j++) {
		dp[0][j] = dp[0][j - 1] + ins[j - 1];
		choice[0][j] = 2;
	}
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			let cost = dp[i - 1][j] + del[i - 1];
			let how = 1;
			const insert = dp[i][j - 1] + ins[j - 1];
			if (insert < cost) { cost = insert; how = 2; }
			const replace = dp[i - 1][j - 1] + sub[i - 1][j - 1];
			// A tie stays a gap so an equally costly later line does not steal an earlier match.
			if (replace < cost) { cost = replace; how = 3; }
			dp[i][j] = cost;
			choice[i][j] = how;
		}
	}
	const pairs: Array<{ old: number; new: number }> = [];
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		const how = choice[i][j];
		if (how === 3) {
			pairs.push({ old: i - 1, new: j - 1 });
			i--;
			j--;
		} else if (how === 2) j--;
		else i--;
	}
	pairs.reverse();
	return pairs;
}

function refineDiff(a: string[], b: string[]): SeqDiff[] {
	let diffs = diffChanges(a, b);
	diffs = joinByShifting(a, b, diffs);
	diffs = joinByShifting(a, b, diffs);
	diffs = shiftEmptyDiffs(a, b, diffs);
	diffs = extendToWords(a, b, diffs);
	diffs = mergeShortGaps(diffs);
	return extendToWords(a, b, diffs);
}

type Slice = { tokens: string[]; line: number[]; index: number[] };

function sliceOf(lines: string[]): Slice {
	const tokens: string[] = [];
	const line: number[] = [];
	const index: number[] = [];
	lines.forEach((text, lineNumber) => {
		graphemes(text).forEach((token, tokenIndex) => {
			tokens.push(token);
			line.push(lineNumber);
			index.push(tokenIndex);
		});
		if (lineNumber < lines.length - 1) {
			tokens.push("\n");
			line.push(-1);
			index.push(-1);
		}
	});
	return { tokens, line, index };
}

function addLineRange(ranges: Range[][], slice: Slice, range: Range) {
	let cursor = range.start;
	while (cursor < range.end) {
		if (slice.line[cursor] < 0) {
			cursor++;
			continue;
		}
		const lineNumber = slice.line[cursor];
		const start = slice.index[cursor];
		while (cursor < range.end && slice.line[cursor] === lineNumber) cursor++;
		const end = slice.index[cursor - 1] + 1;
		const list = ranges[lineNumber];
		const previous = list[list.length - 1];
		if (previous && previous.end >= start) previous.end = Math.max(previous.end, end);
		else list.push({ start, end });
	}
}

function characterRanges(oldLines: string[], newLines: string[]): { old: Range[][]; new: Range[][] } {
	const oldRanges = oldLines.map(() => [] as Range[]);
	const newRanges = newLines.map(() => [] as Range[]);
	const oldSlice = sliceOf(oldLines);
	const newSlice = sliceOf(newLines);
	// A single oversized pair must not recurse: the same two lines would exceed the cap again.
	if ((oldLines.length > 1 || newLines.length > 1) && oldSlice.tokens.length * newSlice.tokens.length > MAX_DIFF_CELLS) {
		const paired = Math.min(oldLines.length, newLines.length);
		for (let index = 0; index < paired; index++) {
			const part = characterRanges([oldLines[index]], [newLines[index]]);
			oldRanges[index] = part.old[0] ?? [];
			newRanges[index] = part.new[0] ?? [];
		}
		return { old: oldRanges, new: newRanges };
	}
	for (const diff of refineDiff(oldSlice.tokens, newSlice.tokens)) {
		addLineRange(oldRanges, oldSlice, diff.a);
		addLineRange(newRanges, newSlice, diff.b);
	}
	return { old: oldRanges, new: newRanges };
}

function withoutLeadingWhitespace(line: string, ranges: Range[]): Range[] {
	const chars = graphemes(line);
	let indent = 0;
	while (indent < chars.length && (chars[indent] === " " || chars[indent] === "\t")) indent++;
	return ranges.flatMap((range) => {
		const start = Math.max(range.start, indent);
		return start < range.end ? [{ start, end: range.end }] : [];
	});
}

function paintRanges(colored: string, plain: string, ranges: Range[], charBg: string, lineBg: string): string {
	let text = colored;
	for (const range of [...ranges].reverse()) {
		text = emphasizeSpan(text, plain, range.start, range.end, (part) => `\x1b[48;2;${charBg}m${part}\x1b[48;2;${lineBg}m`);
	}
	return text;
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
export type DiffPalette = { insert: string; delete: string; insertChar: string; deleteChar: string };

export const defaultDiffPalette: DiffPalette = {
	insert: INSERT_BG,
	delete: DELETE_BG,
	insertChar: INSERT_CHAR_BG,
	deleteChar: DELETE_CHAR_BG,
};

export function buildDiffRows(diff: string, theme: DiffPaint, highlight: (text: string) => string[] | undefined, palette: DiffPalette = defaultDiffPalette): RenderRow[] {
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
	// Line diff first. Character ranges are painted only where a removed line maps to an added line.
	for (let index = 0; index < rows.length;) {
		if (rows[index].kind !== "remove" && rows[index].kind !== "add") {
			index++;
			continue;
		}
		const hunkStart = index;
		while (index < rows.length && (rows[index].kind === "remove" || rows[index].kind === "add")) index++;
		const removed: number[] = [];
		const added: number[] = [];
		for (let row = hunkStart; row < index; row++) {
			if (rows[row].kind === "remove") removed.push(row);
			else added.push(row);
		}
		if (removed.length === 0 || added.length === 0) continue;
		const oldLines = removed.map((row) => rows[row].content);
		const newLines = added.map((row) => rows[row].content);
		for (const block of diffChanges(oldLines, newLines)) {
			if (block.a.start === block.a.end || block.b.start === block.b.end) continue;
			const oldSlice = oldLines.slice(block.a.start, block.a.end);
			const newSlice = newLines.slice(block.b.start, block.b.end);
			for (const pair of alignPairs(oldSlice, newSlice)) {
				const ranges = characterRanges([oldSlice[pair.old]], [newSlice[pair.new]]);
				const oldRow = removed[block.a.start + pair.old];
				const newRow = added[block.b.start + pair.new];
				highlighted[oldRow] = paintRanges(highlighted[oldRow], rows[oldRow].content, withoutLeadingWhitespace(rows[oldRow].content, ranges.old[0] ?? []), palette.deleteChar, palette.delete);
				highlighted[newRow] = paintRanges(highlighted[newRow], rows[newRow].content, withoutLeadingWhitespace(rows[newRow].content, ranges.new[0] ?? []), palette.insertChar, palette.insert);
			}
		}
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

function finishRow(line: string, width: number, kind: RenderRow["kind"], palette: DiffPalette): string {
	const rgb = kind === "add" ? palette.insert : kind === "remove" ? palette.delete : undefined;
	if (!rgb) return line;
	const body = line.replaceAll("\x1b[0m", "\x1b[39m");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(body)));
	// A wrapped character span can still be active at the end of the body. Restore the row color before padding.
	return `\x1b[48;2;${rgb}m${body}${pad ? `\x1b[48;2;${rgb}m${pad}` : ""}\x1b[0m`;
}

/** Wrap each logical row on its own, then paint that row's background. No style crosses into the next row. */
export function paintRows(rows: RenderRow[], width: number, indent = "", palette: DiffPalette = defaultDiffPalette): string[] {
	if (width <= 0) return [];
	const inner = Math.max(1, width - indent.length);
	const lines: string[] = [];
	for (const row of rows) {
		for (const wrapped of wrapTextWithAnsi(row.text, inner)) {
			lines.push(finishRow(indent + wrapped, width, row.kind, palette));
		}
	}
	return lines;
}
