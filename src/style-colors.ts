import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const featureSettingsPath = () => join(getAgentDir(), "grok-style.json");

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

const hexColor = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(color: string): string {
	return `${Number.parseInt(color.slice(1, 3), 16)};${Number.parseInt(color.slice(3, 5), 16)};${Number.parseInt(color.slice(5, 7), 16)}`;
}

export function readSettingsObject(path = featureSettingsPath()): Record<string, unknown> {
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Grok settings must be a JSON object");
		return data as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export function writeSettingsObject(values: Record<string, unknown>, path = featureSettingsPath()) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
	renameSync(temporary, path);
}

export function loadStyleColors(path = featureSettingsPath()): StyleColors {
	const colors = readSettingsObject(path).colors;
	if (colors === undefined) return { ...defaultStyleColors };
	if (!colors || typeof colors !== "object" || Array.isArray(colors)) throw new Error("Grok colors must be an object");
	const values = colors as Record<string, unknown>;
	const result = { ...defaultStyleColors };
	for (const key of Object.keys(colorLabels) as ColorKey[]) {
		if (!(key in values)) continue;
		const value = values[key];
		if (typeof value !== "string" || !hexColor.test(value)) throw new Error(`Grok color ${key} must be a #rrggbb color`);
		result[key] = value.toLowerCase();
	}
	return result;
}

export function saveStyleColor(key: ColorKey, value: string | undefined, path = featureSettingsPath()) {
	const settings = readSettingsObject(path);
	const current = settings.colors && typeof settings.colors === "object" && !Array.isArray(settings.colors) ? settings.colors as Record<string, string> : {};
	const colors = { ...current };
	if (value === undefined) delete colors[key];
	else colors[key] = value.toLowerCase();
	writeSettingsObject({ ...settings, colors }, path);
}

let active = { ...defaultStyleColors };

export function useStyleColors(colors: StyleColors) {
	active = colors;
}

export function styleColors(): StyleColors {
	return active;
}
