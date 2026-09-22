import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const IDLE_BORDER_TOKEN = "borderMuted";
export const FOCUS_BORDER_TOKEN = "borderAccent";

export type ComposerPaint = (token: ThemeColor, text: string) => string;

export function composerBorderToken(focused: boolean): typeof IDLE_BORDER_TOKEN | typeof FOCUS_BORDER_TOKEN {
	return focused ? FOCUS_BORDER_TOKEN : IDLE_BORDER_TOKEN;
}

function padVisible(line: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(line, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderComposerFrame(
	contentLines: string[],
	options: { focused: boolean; width: number; paint: ComposerPaint },
): string[] {
	const width = Math.max(2, Math.floor(options.width));
	const inner = width - 2;
	const token = composerBorderToken(options.focused);
	const paint = (text: string) => options.paint(token, text);
	const body = (contentLines.length > 0 ? contentLines : [""]).map(
		(line) => paint("│") + padVisible(line, inner) + paint("│"),
	);
	return [paint("╭" + "─".repeat(inner) + "╮"), ...body, paint("╰" + "─".repeat(inner) + "╯")];
}

/** Frame Pi's editor output, keeping autocomplete outside the input box. */
export function frameEditorLines(lines: string[], bottomIndex: number, width: number, paint: ComposerPaint, focused: boolean): string[] {
	const border = (text: string) => paint(composerBorderToken(focused), text);
	return lines.map((line, index) => {
		if (index === 0) return border("╭───") + line + border("╮");
		if (index === bottomIndex) return border("╰───") + line + border("╯");
		if (index > bottomIndex) return "    " + padVisible(line, width - 5) + " ";
		const prefix = index === 1 ? paint(focused ? "text" : "muted", " ❯ ") : "   ";
		return border("│") + prefix + padVisible(line, width - 5) + border("│");
	});
}

export function applyComposerBorderColor(
	setBorderColor: (fn: (text: string) => string) => void,
	focused: boolean,
	paint: ComposerPaint,
): void {
	const token = composerBorderToken(focused);
	setBorderColor((text) => paint(token, text));
}
