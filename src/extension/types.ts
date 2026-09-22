import type { ToolsOptions, ModelRegistry, ExtensionAPI, CustomEditor } from "@earendil-works/pi-coding-agent";
import type { FooterContext } from "../footer.ts";
import type { Features } from "../features.ts";
import type { OpenTarget } from "../open-in-cursor.ts";
import type { CursorWorkspaceDeps } from "../cursor-workspace.ts";
import type { OriginalTool, ToolFactoryMap } from "../tools.ts";

export type SessionUi = {
	theme?: { fg?(token: string, text: string): string };
	setFooter?(factory: unknown): void;
	setStatus?: (id: string, text: string | undefined) => void;
	setEditorComponent?(factory: unknown): void;
};

export type SessionContext = FooterContext & {
	cwd: string;
	modelRegistry?: Pick<ModelRegistry, "getApiKeyForProvider">;
	hasUI?: boolean;
	mode?: string;
	model?: { name?: string; id?: string; provider?: string } | null;
	getContextUsage?: () => { percent: number | null } | undefined;
	isProjectTrusted?: () => boolean;
	ui: SessionUi;
};

export type ExtensionApiLike = {
	on: ExtensionAPI["on"];
	registerTool: ExtensionAPI["registerTool"];
	registerCommand?: ExtensionAPI["registerCommand"];
	registerShortcut?: ExtensionAPI["registerShortcut"];
	registerMarkdownTransformer?: ExtensionAPI["registerMarkdownTransformer"];
	getThinkingLevel?: () => string;
};

export type CustomEditorCtor = typeof CustomEditor;

export type GrokStyleDeps = {
	CustomEditor: CustomEditorCtor;
	tools: ToolFactoryMap;
	getToolOptions?: (ctx: SessionContext) => ToolsOptions;
	wrapTool?: (tool: OriginalTool) => OriginalTool;
	features?: Partial<Features>;
	openCursor?: (target: OpenTarget) => Promise<void>;
	refreshCompileCommands?: CursorWorkspaceDeps["refresh"];
	hyperlinks?: () => boolean;
};
