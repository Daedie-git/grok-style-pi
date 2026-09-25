import { VisualPreparation } from "./rendering/visual-preparation.ts";
import type { ToolsOptions } from "@earendil-works/pi-coding-agent";
import { defaultFeatures } from "./extension/features.ts";
import { COMMUNICATION, installCommunication } from "./extension/communication.ts";
import { BUILTIN_TOOL_NAMES, createDiamondTools, type BuiltinToolName } from "./tools/renderer.ts";
import { createShowImageTool } from "./tools/show-image.ts";
import { createShowVideoTool } from "./tools/show-video.ts";
import { createFileNavigation } from "./extension/file-navigation.ts";
import type { OpenTarget } from "./navigation/open-in-cursor.ts";
import { createSessionChrome } from "./extension/session-chrome.ts";
import type { ExtensionApiLike, GrokStyleDeps, SessionContext } from "./extension/types.ts";

export type { SessionUi, SessionContext, ExtensionApiLike, CustomEditorCtor, GrokStyleDeps } from "./extension/types.ts";

export function createGrokStyleExtension(pi: ExtensionApiLike, deps: GrokStyleDeps): void {
	const features = { ...defaultFeatures, ...deps.features };
	const preparation = new VisualPreparation();
	let started = false;
	let activeContext: SessionContext | undefined;
	const videoTool = features.toolStyling ? createShowVideoTool(process.cwd()) : undefined;
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
	const diamondHooks = {
		preparation,
		onModifierOpen(target: OpenTarget) { void navigation.openTarget(target); },
		hasActiveSelection: () => chrome.hasActiveSelection(),
		onCodeLocation(path: string, line: number, endLine?: number) {
			const ui = activeContext?.ui;
			if (!ui?.getEditorText || !ui.pasteToEditor || activeContext?.mode && activeContext.mode !== "tui") return;
			const current = ui.getEditorText();
			// The public UI does not expose cursor position. Include separators on
			// both sides so insertion in the middle never joins a word.
			ui.pasteToEditor((current ? " " : "") + `${path}:${line}${endLine === undefined ? "" : `-${endLine}`} `);
		},
	};
	function registerTools(cwd: string, options?: ToolsOptions) {
		const tools = features.toolStyling ? createDiamondTools(cwd, deps.tools, options, diamondHooks) :
			BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => deps.tools[name](cwd, options?.[name]));
		for (const tool of tools) {
			const registered = deps.wrapTool ? deps.wrapTool(tool) : tool;
			pi.registerTool({ ...registered, label: registered.label ?? registered.name });
		}
		if (features.toolStyling) {
			pi.registerTool(createShowImageTool(cwd));
			if (videoTool) pi.registerTool(videoTool);
		}
	}
	// Pi rebuilds transcript rows before session_start on reload. Register the
	// renderers during extension load, then refresh execution options at startup.
	registerTools(process.cwd());

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		videoTool?.startSession();
		if (started) preparation.reset();
		started = true;
		// Paint terminal colors before filesystem setup and tool settings can block.
		chrome.startSession(ctx);
		navigation.startSession(ctx);
		registerTools(ctx.cwd, deps.getToolOptions?.(ctx));
	});
	pi.on("session_tree", () => videoTool?.pauseAll());
	pi.on("session_compact", () => videoTool?.pauseAll());
	pi.on("session_shutdown", () => {
		activeContext = undefined;
		videoTool?.dispose();
		preparation.reset();
		navigation.dispose();
		chrome.dispose();
	});
}
