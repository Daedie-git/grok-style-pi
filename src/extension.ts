import { VisualPreparation } from "./rendering/visual-preparation.ts";
import type { ToolsOptions } from "@earendil-works/pi-coding-agent";
import { defaultFeatures } from "./extension/features.ts";
import { COMMUNICATION, installCommunication } from "./extension/communication.ts";
import { BUILTIN_TOOL_NAMES, createDiamondTools, type BuiltinToolName } from "./tools/renderer.ts";
import { createFileNavigation } from "./extension/file-navigation.ts";
import { createSessionChrome } from "./extension/session-chrome.ts";
import type { ExtensionApiLike, GrokStyleDeps } from "./extension/types.ts";

export type { SessionUi, SessionContext, ExtensionApiLike, CustomEditorCtor, GrokStyleDeps } from "./extension/types.ts";

export function createGrokStyleExtension(pi: ExtensionApiLike, deps: GrokStyleDeps): void {
	const features = { ...defaultFeatures, ...deps.features };
	const preparation = new VisualPreparation();
	let started = false;
	const navigation = createFileNavigation(pi, { ...deps, communication: features.communication });
	const chrome = createSessionChrome(pi, { CustomEditor: deps.CustomEditor, features });

	pi.on("before_agent_start", (event) => {
		if (!features.communication) return;
		const options = event.systemPromptOptions as { sections?: Record<string, string> };
		if (options.sections) {
			installCommunication(options.sections, true);
			return;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n<communication>\n${COMMUNICATION}\n</communication>`,
		};
	});
	function registerTools(cwd: string, options?: ToolsOptions) {
		const tools = features.toolStyling ? createDiamondTools(cwd, deps.tools, options, {
			preparation,
			onModifierOpen(target) { void navigation.openTarget(target); },
		}) :
			BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => deps.tools[name](cwd, options?.[name]));
		for (const tool of tools) {
			const registered = deps.wrapTool ? deps.wrapTool(tool) : tool;
			pi.registerTool({ ...registered, label: registered.label ?? registered.name });
		}
	}
	// Pi rebuilds transcript rows before session_start on reload. Register the
	// renderers during extension load, then refresh execution options at startup.
	registerTools(process.cwd());

	pi.on("session_start", (_event, ctx) => {
		if (started) preparation.reset();
		started = true;
		// Paint terminal colors before filesystem setup and tool settings can block.
		chrome.startSession(ctx);
		navigation.startSession(ctx);
		registerTools(ctx.cwd, deps.getToolOptions?.(ctx));
	});
	pi.on("session_shutdown", () => {
		preparation.reset();
		navigation.dispose();
		chrome.dispose();
	});
}
