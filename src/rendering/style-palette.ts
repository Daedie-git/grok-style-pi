export const colorLabels = {
	diffInsert: "Added-line background",
	diffDelete: "Removed-line background",
	diffInsertChar: "Added-character background",
	diffDeleteChar: "Removed-character background",
	comment: "Comment",
	commentDoc: "Documentation comment",
	commentDocEmphasized: "Emphasized documentation comment",
} as const;

export type ColorKey = keyof typeof colorLabels;
export type StyleColors = Record<ColorKey, string>;

export const defaultStyleColors: StyleColors = {
	diffInsert: "#063806",
	diffDelete: "#420e14",
	diffInsertChar: "#0c5b10",
	diffDeleteChar: "#6c1a22",
	comment: "#a0a8b8",
	commentDoc: "#aab4c6",
	commentDocEmphasized: "#b4bed4",
};

export function hexToRgb(color: string): string {
	return `${Number.parseInt(color.slice(1, 3), 16)};${Number.parseInt(color.slice(3, 5), 16)};${Number.parseInt(color.slice(5, 7), 16)}`;
}

