import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_COLOR_TOKENS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"selectedBg",
	"userMessageBg",
	"userMessageText",
	"customMessageBg",
	"customMessageText",
	"customMessageLabel",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
] as const;

export type ThemeJson = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

export function grokNightPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "themes", "groknight.json");
}

export function loadThemeJson(path: string): ThemeJson {
	return JSON.parse(readFileSync(path, "utf8")) as ThemeJson;
}

export function resolveThemeColors(theme: ThemeJson): Record<string, string | number> {
	const vars = theme.vars ?? {};
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(theme.colors)) {
		if (typeof value === "string" && value !== "" && !value.startsWith("#") && value in vars) {
			resolved[key] = vars[value] as string | number;
		} else {
			resolved[key] = value;
		}
	}
	return resolved;
}

export function missingRequiredTokens(theme: ThemeJson): string[] {
	return REQUIRED_COLOR_TOKENS.filter((token) => !(token in theme.colors));
}

export function unresolvedVarRefs(theme: ThemeJson): string[] {
	const vars = theme.vars ?? {};
	const bad: string[] = [];
	for (const [key, value] of Object.entries(theme.colors)) {
		if (typeof value === "string" && value !== "" && !value.startsWith("#") && !(value in vars) && Number.isNaN(Number(value))) {
			bad.push(`${key}=${value}`);
		}
	}
	return bad;
}
