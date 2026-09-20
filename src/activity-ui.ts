import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";

export type Activity = {
	id: string;
	kind: "command" | "agent";
	title: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	output: string;
	detail?: string;
	transcript?: () => string;
	stop?: () => void | Promise<void>;
};

export const isActive = (entry: Activity) => ["running", "queued", "stopping"].includes(entry.status);
export const plainText = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const oneLine = (text: string) => plainText(text).replace(/\s+/g, " ").trim();
type Theme = { fg: (token: any, text: string) => string; bg?: (token: any, text: string) => string };
type Hit = { y: number; x: number; end: number; action: () => void };

export class ActivityPanel {
	private hits: Hit[] = [];
	private entries: () => Activity[];
	private theme: Theme;
	private view: (entry: Activity) => void;
	private action: (entry: Activity) => void;
	private all: () => void;
	private dismiss: (entry: Activity) => void;
	constructor(
		entries: () => Activity[], theme: Theme, view: (entry: Activity) => void,
		action: (entry: Activity) => void, all: () => void, dismiss: (entry: Activity) => void,
	) { this.entries = entries; this.theme = theme; this.view = view; this.action = action; this.all = all; this.dismiss = dismiss; }
	invalidate() {}
	render(width: number): string[] {
		this.hits = [];
		if (width <= 0) return [];
		const entries = this.entries().filter(isActive);
		if (!entries.length) return [];
		const lines: string[] = [];
		for (const [kind, heading] of [["agent", "Active subagents"], ["command", "Active tasks"]] as const) {
			const group = entries.filter((entry) => entry.kind === kind);
			if (!group.length) continue;
			this.hits.push({ y: lines.length, x: 0, end: width, action: this.all });
			const title = `─ ${heading} · ${group.length} `;
			lines.push(truncateToWidth(this.theme.fg("muted", title + "─".repeat(Math.max(0, width - visibleWidth(title)))), width));
			for (const entry of group.slice(0, 3)) {
				const buttons = [
					{ label: "[View]", token: "accent", action: () => this.view(entry) },
					...(isActive(entry) && entry.stop ? [{ label: "[Stop]", token: "error", action: () => this.action(entry) }] : []),
					{ label: "[Close]", token: "accent", action: () => this.dismiss(entry) },
				];
				// Keep Close reachable when the terminal is too narrow for all controls.
				while (buttons.length > 1 && buttons.map((button) => button.label).join(" ").length > width) buttons.shift();
				const controls = buttons.map((button) => button.label).join(" ");
				const elapsed = Math.max(0, Math.floor(((entry.endedAt ?? Date.now()) - entry.startedAt) / 1000));
				const time = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
				const label = `${oneLine(entry.title)} · ${entry.status} · ${time}${entry.detail ? ` · ${oneLine(entry.detail)}` : ""}`;
				const leftWidth = Math.max(0, width - controls.length - 1);
				const left = truncateToWidth(label, leftWidth, "…");
				const prefix = leftWidth ? left + " ".repeat(leftWidth - visibleWidth(left) + 1) : "";
				let x = visibleWidth(prefix);
				const y = lines.length;
				lines.push(truncateToWidth(
					this.theme.fg("muted", prefix) + buttons.map((button) => this.theme.fg(button.token, button.label)).join(" "), width,
				));
				for (const button of buttons) {
					if (x + button.label.length <= width) this.hits.push({ y, x, end: x + button.label.length, action: button.action });
					x += button.label.length + 1;
				}
			}
			if (group.length > 3) {
				this.hits.push({ y: lines.length, x: 0, end: width, action: this.all });
				lines.push(truncateToWidth(this.theme.fg("accent", `[${group.length - 3} more · open /activity]`), width));
			}
		}
		return this.theme.bg ? lines.map((line) => this.theme.bg!("toolPendingBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))))) : lines;
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const hit = this.hits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.end);
		if (!hit) return undefined;
		hit.action();
		return { handled: true };
	}
}

/** A bounded, live output viewer. Scrolling up pauses follow; End resumes it. */
export class ActivityViewer {
	private offset = Infinity;
	private maxCharacters: number;
	private wrappedText: string | undefined;
	private wrappedWidth = 0;
	private wrappedLines: string[] = [];
	private maxOffset = 0;
	private pageSize = 10;
	private hits: Hit[] = [];
	private scrollbar?: { x: number; top: number; height: number };
	private draggingScrollbar = false;
	private entry: Activity;
	private theme: Theme;
	private rows: () => number;
	private redraw: () => void;
	private close: () => void;
	private stop: () => void;
	constructor(
		entry: Activity, theme: Theme, rows: () => number, redraw: () => void,
		close: () => void, stop: () => void, options: { maxCharacters?: number } = {},
	) { this.maxCharacters = options.maxCharacters ?? 64000; this.entry = entry; this.theme = theme; this.rows = rows; this.redraw = redraw; this.close = close; this.stop = stop; }
	invalidate() {}
	render(width: number): string[] {
		this.hits = [];
		this.scrollbar = undefined;
		if (width <= 0) return [];
		if (width < 4) {
			this.hits.push({ y: 0, x: 0, end: width, action: this.close });
			return [truncateToWidth("×", width, "")];
		}
		const inner = width - 2;
		const inset = inner >= 4 ? 1 : 0;
		const contentWidth = inner - inset * 2;
		const outputWidth = Math.max(1, contentWidth - (inset ? 0 : 1));
		const maxHeight = Math.max(3, Math.floor(this.rows() * 0.7));
		this.pageSize = Math.max(1, maxHeight - 6);
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const frame = (text: string, scrollbar = "") => {
			const available = scrollbar && !inset ? outputWidth : contentWidth;
			const clipped = truncateToWidth(text, available, "");
			return border("│") + " ".repeat(inset) + clipped + " ".repeat(contentWidth - visibleWidth(clipped) + inset - (scrollbar ? 1 : 0)) + scrollbar + border("│");
		};
		const closeLabel = contentWidth >= 7 ? "[Close]" : contentWidth >= 3 ? "[x]" : "×";
		const titleWidth = Math.max(0, contentWidth - closeLabel.length - 1);
		const title = truncateToWidth(`${oneLine(this.entry.title)} · ${this.entry.status}`, titleWidth, "…");
		const closeX = 1 + inset + contentWidth - visibleWidth(closeLabel);
		this.hits.push({ y: 1, x: closeX, end: closeX + visibleWidth(closeLabel), action: this.close });
		const lines = [
			border("╭" + "─".repeat(inner) + "╮"),
			frame(this.theme.fg("accent", title) + " ".repeat(contentWidth - visibleWidth(title) - visibleWidth(closeLabel)) + this.theme.fg("accent", closeLabel)),
		];
		const text = this.entry.transcript?.() || this.entry.output || "Waiting for output…";
		const clipped = text.length > this.maxCharacters ? `[Earlier activity omitted]\n${text.slice(-this.maxCharacters)}` : text;
		if (clipped !== this.wrappedText || outputWidth !== this.wrappedWidth) {
			this.wrappedLines = wrapTextWithAnsi(plainText(clipped).replace(/\t/g, "   "), outputWidth).map((line) => truncateToWidth(line, outputWidth, ""));
			this.wrappedText = clipped;
			this.wrappedWidth = outputWidth;
		}
		const content = this.wrappedLines;
		this.maxOffset = Math.max(0, content.length - this.pageSize);
		const start = Math.min(this.offset, this.maxOffset);
		if (maxHeight >= 7) {
			lines.push(border("├" + "─".repeat(inner) + "┤"));
			if (this.maxOffset) this.scrollbar = { x: width - 2, top: lines.length, height: this.pageSize };
			const thumbSize = Math.max(1, Math.round(this.pageSize * this.pageSize / content.length));
			const thumbStart = this.maxOffset ? Math.round(start / this.maxOffset * (this.pageSize - thumbSize)) : 0;
			for (const [row, line] of content.slice(start, start + this.pageSize).entries()) {
				const scrollbar = this.maxOffset ? this.theme.fg(row >= thumbStart && row < thumbStart + thumbSize ? "accent" : "muted",
					row >= thumbStart && row < thumbStart + thumbSize ? "┃" : "│") : "";

				lines.push(frame(this.theme.fg("toolOutput", line), scrollbar));
			}
			lines.push(border("├" + "─".repeat(inner) + "┤"));
			const y = lines.length;
			const stopLabel = isActive(this.entry) && this.entry.stop ? "[Stop: x]  " : "";
			const stopWidth = stopLabel.length;
			if (stopWidth && contentWidth >= 9) this.hits.push({ y, x: 1 + inset, end: 1 + inset + 9, action: this.stop });
			if (contentWidth >= stopWidth + 12) this.hits.push({ y, x: 1 + inset + stopWidth, end: 1 + inset + stopWidth + 12, action: this.close });
			lines.push(frame(
				(stopLabel ? this.theme.fg("error", stopLabel) : "") +
				this.theme.fg("accent", "[Close: Esc]") + this.theme.fg("muted", "  ↑↓ scroll · End follow"),
			));
		}
		lines.push(border("╰" + "─".repeat(inner) + "╯"));
		return this.theme.bg ? lines.map((line) => this.theme.bg!("toolPendingBg", line)) : lines;
	}
	handleInput(data: string) {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) return this.close();
		if (matchesKey(data, "x") && isActive(this.entry) && this.entry.stop) return this.stop();
		if (matchesKey(data, "end")) this.offset = Infinity;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
		this.redraw();
	}
	private scroll(delta: number) { this.offset = Math.max(0, Math.min(this.offset, this.maxOffset) + delta); }
	private scrollToTrack(y: number) {
		const bar = this.scrollbar;
		if (!bar) return;
		const row = Math.max(0, Math.min(bar.height - 1, y - bar.top));
		this.offset = row === bar.height - 1 ? Infinity : Math.round(row / Math.max(1, bar.height - 1) * this.maxOffset);
		this.redraw();
	}
	handleMouse(event: TuiMouseEvent) {
		if (this.draggingScrollbar && (event.type === "drag" || event.type === "release")) {
			this.scrollToTrack(event.y);
			if (event.type === "release") this.draggingScrollbar = false;
			return { handled: true };
		}
		const bar = this.scrollbar;
		if (bar && event.button === "left" && (event.type === "press" || event.type === "click") &&
			event.x >= bar.x && event.x <= bar.x + 1 && event.y >= bar.top && event.y < bar.top + bar.height) {
			this.scrollToTrack(event.y);
			this.draggingScrollbar = event.type === "press";
			return { handled: true, capture: event.type === "press" };
		}
		if (event.type === "wheel") {
			this.scroll((event.wheelDelta ?? 0) * 3);
			this.redraw();
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left") {
			const hit = this.hits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.end);
			if (hit) { hit.action(); return { handled: true }; }
		}
		return undefined;
	}
}
