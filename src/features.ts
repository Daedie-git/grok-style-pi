import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const featureLabels = {
	footer: "Footer (model, Codex context, and Grok context and weekly usage)",
	composer: "Composer frame",
	toolStyling: "Tool summaries and diamond styling",
	activity: "Active subagents and tasks panel",
	terminalColors: "Terminal background, text and cursor colors",
} as const;
export type Features = Record<keyof typeof featureLabels, boolean>;
export const defaultFeatures: Features = { footer: true, composer: true, toolStyling: true, activity: true, terminalColors: true };
export const featureSettingsPath = () => join(getAgentDir(), "grok-style.json");

export function loadFeatures(path = featureSettingsPath()): Features {
	let data: unknown;
	try { data = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultFeatures }; throw error; }
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Grok settings must be a JSON object");
	const values = data as Record<string, unknown>;
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
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(features, null, 2) + "\n", { mode: 0o600 });
	renameSync(temporary, path);
}

export function installFeatureSettings(pi: ExtensionAPI, path = featureSettingsPath()) {
	pi.registerCommand?.("grok-style", {
		description: "Toggle Grok features: /grok-style [feature|all] [on|off]",
		handler: async (args, ctx) => {
			try {
				const settings = loadFeatures(path);
				const keys = Object.keys(featureLabels) as (keyof Features)[];
				const parts = args.trim().split(/\s+/);
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
