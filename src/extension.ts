import { inChildContext } from "../packages/subagent-engine/src/child-context.ts";
import { VisualPreparation } from "./rendering/visual-preparation.ts";
import type { ToolsOptions } from "@earendil-works/pi-coding-agent";
import { defaultFeatures } from "./extension/features.ts";
import { COMMUNICATION, installCommunication } from "./extension/communication.ts";
import { createProjectMemorySession } from "./extension/project-memory-session.ts";
import { BUILTIN_TOOL_NAMES, createDiamondTools, wrapWithDiamondRenderer, type BuiltinToolName, type OriginalTool } from "./tools/renderer.ts";
import { installMediaTools } from "./media/tools.ts";
import { createFileNavigation } from "./extension/file-navigation.ts";
import type { OpenTarget } from "./navigation/open-in-cursor.ts";
import { createSessionChrome } from "./extension/session-chrome.ts";
import type { ExtensionApiLike, GrokStyleDeps, GrokStyleRuntime, SessionContext } from "./extension/types.ts";

export type { SessionUi, SessionContext, ExtensionApiLike, CustomEditorCtor, GrokStyleDeps, GrokStyleRuntime } from "./extension/types.ts";

export function createGrokStyleExtension(pi: ExtensionApiLike, deps: GrokStyleDeps): GrokStyleRuntime {
	if (inChildContext()) return { styleTool: <T>(tool: T): T => tool };
	const features = { ...defaultFeatures, ...deps.features };
	const preparation = new VisualPreparation();
	let started = false;
	let activeContext: SessionContext | undefined;
	const projectMemory = createProjectMemorySession({ enabled: features.memory, storageRoot: deps.projectMemoryRoot });
	const navigation = createFileNavigation(pi, { ...deps, communication: features.communication });
	const chrome = createSessionChrome(pi, { CustomEditor: deps.CustomEditor, features });

	pi.on("before_agent_start", (event, ctx) => {
		const sections = (event.systemPromptOptions as { sections?: Record<string, string> } | undefined)?.sections;
		installCommunication(sections, features.communication);
		const prompt = !sections && features.communication ?
			`${event.systemPrompt}\n\n<communication>\n${COMMUNICATION}\n</communication>` : event.systemPrompt;
		return projectMemory.beforeAgentStart(event, ctx, prompt);
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
		const tools = features.toolStyling ? createDiamondTools(cwd, deps.tools, options, diamondHooks, deps.sections) :
			BUILTIN_TOOL_NAMES.map(<N extends BuiltinToolName>(name: N) => deps.tools[name](cwd, options?.[name]));
		for (const tool of tools) {
			const registered = deps.wrapTool ? deps.wrapTool(tool) : tool;
			pi.registerTool({ ...registered, label: registered.label ?? registered.name });
		}
	}
	// Pi rebuilds transcript rows before session_start on reload. Register the
	// renderers during extension load, then refresh execution options at startup.
	registerTools(process.cwd());
	if (features.toolStyling) installMediaTools(pi, {
		onModifierOpen(target) { void navigation.openLinkedTarget(target); },
	});

	pi.on("session_start", (_event, ctx) => {
		projectMemory.startSession();
		activeContext = ctx;
		if (started) preparation.reset();
		started = true;
		// Paint terminal colors before filesystem setup and tool settings can block.
		chrome.startSession(ctx);
		navigation.startSession(ctx);
		registerTools(ctx.cwd, deps.getToolOptions?.(ctx));
	});
	pi.on("session_shutdown", () => {
		projectMemory.dispose();
		activeContext = undefined;
		preparation.reset();
		navigation.dispose();
		chrome.dispose();
	});
	return {
		styleTool<T extends OriginalTool>(tool: T): T {
			return features.toolStyling ? wrapWithDiamondRenderer(tool, diamondHooks, deps.sections) : tool;
		},
	};
}
