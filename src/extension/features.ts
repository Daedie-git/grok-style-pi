import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { colorLabels, featureSettingsPath, readSettingsObject, saveStyleColor, writeSettingsObject, type ColorKey } from "../chrome/style-colors.ts";

export { featureSettingsPath };

export const featureLabels = {
	footer: "Footer (model, and context and usage for the active model)",
	composer: "Composer frame",
	toolStyling: "Tool summaries and diamond styling",
	activity: "Active subagents and tasks panel",
	terminalColors: "Terminal background, text and cursor colors",
	communication: "Communication style and clickable file references",
} as const;
export type Features = Record<keyof typeof featureLabels, boolean>;
export const defaultFeatures: Features = { footer: true, composer: true, toolStyling: true, activity: true, terminalColors: true, communication: true };

export function loadFeatures(path = featureSettingsPath()): Features {
	const values = readSettingsObject(path);
	const result = { ...defaultFeatures };
	for (const key of Object.keys(featureLabels) as (keyof Features)[]) {
		if (key in values) {
			if (typeof values[key] !== "boolean") throw new Error(`Grok setting ${key} must be true or false`);
			result[key] = values[key] as boolean;
		}
	}
	return result;
}

export function saveFeatures(features: Features, path = featureSettingsPath()) {
	writeSettingsObject({ ...readSettingsObject(path), ...features }, path);
}

export function installFeatureSettings(pi: ExtensionAPI, path = featureSettingsPath()) {
	pi.registerCommand?.("grok-style", {
		description: "Toggle Grok features or set a diff/comment color: /grok-style [feature|all|color] ...",
		handler: async (args, ctx) => {
			try {
				const settings = loadFeatures(path);
				const keys = Object.keys(featureLabels) as (keyof Features)[];
				const colorKeys = Object.keys(colorLabels) as ColorKey[];
				const parts = args.trim().split(/\s+/);
				if (parts[0] === "color") {
					const [, key, value] = parts;
					if (parts.length !== 3 || !colorKeys.includes(key as ColorKey) || !value || (value !== "reset" && !/^#[0-9a-fA-F]{6}$/.test(value))) {
						ctx.ui.notify(`Usage: /grok-style color <${colorKeys.join("|")}> <#rrggbb|reset>`, "warning");
						return;
					}
					saveStyleColor(key as ColorKey, value === "reset" ? undefined : value, path);
					ctx.ui.notify("Grok color saved. Run /reload to apply.", "info");
					return;
				}
				if (!args.trim()) {
					const labels = keys.map((key) => `${settings[key] ? "On" : "Off"} · ${featureLabels[key]}`);
					const selected = await ctx.ui.select("Grok features — select to toggle (apply with /reload)", labels);
					if (selected === undefined) return;
					const key = keys[labels.indexOf(selected)];
					if (!key) return;
					settings[key] = !settings[key];
				} else {
					const [key, value] = parts;
					if (parts.length !== 2 || !(key === "all" || keys.includes(key as keyof Features)) || !["on", "off"].includes(value)) {
						ctx.ui.notify(`Usage: /grok-style <${keys.join("|")}|all> <on|off>`, "warning"); return;
					}
					for (const feature of key === "all" ? keys : [key as keyof Features]) settings[feature] = value === "on";
				}
				saveFeatures(settings, path);
				ctx.ui.notify("Grok settings saved. Run /reload to apply. Theme selection is available through /theme.", "info");
			} catch (error) { ctx.ui.notify(`Could not update Grok settings: ${String(error)}`, "error"); }
		},
	});
}
