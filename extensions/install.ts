import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadFeatures, installFeatureSettings, type Features } from "../src/extension/features.ts";
import { loadStyleColors, useStyleColors } from "../src/chrome/style-colors.ts";
import { createGrokStyleExtension } from "../src/extension.ts";
import { loadToolOptions } from "../src/tools/settings.ts";
import { installActivityPanel } from "../src/activity/panel.ts";
import { registerStyledCodemode } from "../src/tools/codemode.ts";

type PiObjects = Pick<typeof import("@earendil-works/pi-coding-agent"), "CustomEditor" | "createReadToolDefinition" | "createBashToolDefinition" | "createPowerShellToolDefinition" | "createEditToolDefinition" | "createWriteToolDefinition" | "createGrepToolDefinition" | "createFindToolDefinition" | "createLsToolDefinition"> & { createCodemodeExtension?: () => ExtensionFactory };
type InstallDeps = { loadAgent?: () => Promise<PiObjects>; features?: Features };

/** Each alternative entrypoint installs one core runtime and shares its rendering hooks. */
export async function installGrokStyle(pi: ExtensionAPI, deps: InstallDeps = {}) {
	const agent = await (deps.loadAgent ?? (() => import("@earendil-works/pi-coding-agent")))();
	const features = deps.features ?? loadFeatures();
	useStyleColors(loadStyleColors());
	installFeatureSettings(pi);
	const activity = features.activity ? installActivityPanel(pi) : undefined;
	const runtime = createGrokStyleExtension(pi, {
		features,
		wrapTool: activity?.wrapTool,
		CustomEditor: agent.CustomEditor,
		getToolOptions: loadToolOptions,
		tools: {
			read: agent.createReadToolDefinition,
			bash: agent.createBashToolDefinition,
			powershell: agent.createPowerShellToolDefinition,
			edit: agent.createEditToolDefinition,
			write: agent.createWriteToolDefinition,
			grep: agent.createGrepToolDefinition,
			find: agent.createFindToolDefinition,
			ls: agent.createLsToolDefinition,
		},
	});
	// Older Pi releases have no codemode factory. Do not construct it when styling is off.
	const codemode = (agent as PiObjects).createCodemodeExtension;
	if (features.toolStyling && codemode) await registerStyledCodemode(pi, codemode(), true, runtime.styleTool);
	return { runtime, features };
}
