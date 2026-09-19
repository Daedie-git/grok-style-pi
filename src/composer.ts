export const IDLE_BORDER_TOKEN = "borderMuted";
export const FOCUS_BORDER_TOKEN = "borderAccent";

export type ComposerPaint = (token: string, text: string) => string;

export function composerBorderToken(focused: boolean): typeof IDLE_BORDER_TOKEN | typeof FOCUS_BORDER_TOKEN {
	return focused ? FOCUS_BORDER_TOKEN : IDLE_BORDER_TOKEN;
}

function padVisible(line: string, width: number): string {
	if (width <= 0) return "";
	if (line.length >= width) return line.slice(0, width);
	return line + " ".repeat(width - line.length);
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
	return [paint("┌" + "─".repeat(inner) + "┐"), ...body, paint("└" + "─".repeat(inner) + "┘")];
}

export function applyComposerBorderColor(
	setBorderColor: (fn: (text: string) => string) => void,
	focused: boolean,
	paint: ComposerPaint,
): void {
	const token = composerBorderToken(focused);
	setBorderColor((text) => paint(token, text));
}
