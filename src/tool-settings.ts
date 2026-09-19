import { SettingsManager, type ToolsOptions } from "@earendil-works/pi-coding-agent";
import type { SessionContext } from "./extension.ts";

/** Match the settings Pi passes to its built-in tool factories. */
export function loadToolOptions(ctx: SessionContext, agentDir?: string): ToolsOptions {
	const settings = SettingsManager.create(ctx.cwd, agentDir, {
		projectTrusted: ctx.isProjectTrusted?.() ?? false,
	});
	return {
		read: { autoResizeImages: settings.getImageAutoResize() },
		bash: {
			commandPrefix: settings.getShellCommandPrefix(),
			shellPath: settings.getShellPath(),
		},
	};
}
