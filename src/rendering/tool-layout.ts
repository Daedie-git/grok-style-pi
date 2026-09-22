import { visibleWidth } from "@earendil-works/pi-tui";
import { textComponent } from "../tools/diamond.ts";
import { paintRows, type DiffPalette, type RenderRow } from "./diff-render.ts";

/** Pure layout shared by the immediate preview and the visual worker. */
export function layoutTool(prose: string, rows: RenderRow[], width: number, palette: DiffPalette, background?: string): string[] {
	if (width <= 0) return [];
	const indent = width > 2 ? "  " : "";
	const proseLines = prose ? textComponent(prose).render(Math.max(0, width - indent.length)).map((line) => indent + line) : [];
	const painted = paintRows(rows, width, indent, palette);
	const lines = proseLines.length && painted.length ? [...proseLines, "", ...painted] : [...proseLines, ...painted];
	return background ? lines.map((line) => background.replace("\0", () => line + " ".repeat(Math.max(0, width - visibleWidth(line))))) : lines;
}
