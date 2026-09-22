import { getCapabilities } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { linkifyCodeReferences } from "../navigation/code-links.ts";
import { createFileLinkBridge } from "../navigation/file-link-bridge.ts";
import { installFileLinkHandler } from "../navigation/file-link-handler.ts";
import { createOpenHistory, absPath, type OpenTarget } from "../navigation/open-in-cursor.ts";
import { createCursorWorkspaceOpener, type CursorOpenContext } from "../navigation/cursor-workspace.ts";
import type { ExtensionApiLike, GrokStyleDeps } from "./types.ts";

type FileNavigationDeps = Pick<GrokStyleDeps, "openCursor" | "refreshCompileCommands" | "hyperlinks"> & {
	communication: boolean;
};

/** Owns file-opening commands, links, history, and their session lifetime. */
export function createFileNavigation(pi: ExtensionApiLike, deps: FileNavigationDeps) {
	const { rememberOpen, lastOpen, recentOpens, clear } = createOpenHistory();
	const cursor = createCursorWorkspaceOpener({ open: deps.openCursor, refresh: deps.refreshCompileCommands });
	let openContext: CursorOpenContext | undefined;
	let sessionGeneration = 0;
	let linkCwd = process.cwd();
	const fileLinks = createFileLinkBridge(target => openTarget(target));
	const linksEnabled = deps.hyperlinks ?? (() => {
		try { return getCapabilities().hyperlinks; } catch { return false; }
	});
	pi.registerMarkdownTransformer?.((markdown, context) => {
		if (!deps.communication || context.messageType === "assistant-thinking" || !linksEnabled()) return markdown;
		return linkifyCodeReferences(markdown, linkCwd, undefined, process.platform === "linux"
			? reference => fileLinks.urlFor({ ...reference, cwd: linkCwd })
			: undefined);
	});
	async function openTarget(target: OpenTarget, ctx = openContext): Promise<boolean> {
		const generation = sessionGeneration;
		const notify = ctx?.ui.notify?.bind(ctx.ui);
		try { return await cursor.open(target, ctx); }
		catch (error) {
			if (generation === sessionGeneration) notify?.(`Failed to open Cursor: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	}
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const path = typeof event.input.path === "string" ? event.input.path : undefined;
		if (!path) return;
		const details = event.details as { firstChangedLine?: unknown } | undefined;
		const line = event.toolName === "edit" && typeof details?.firstChangedLine === "number" ? details.firstChangedLine : 1;
		rememberOpen({ path: absPath(path, ctx.cwd), line, cwd: ctx.cwd });
	});
	async function openLast(ctx: CursorOpenContext) {
		const target = lastOpen();
		if (!target) {
			ctx.ui.notify?.("No edited files in this session yet", "warning");
			return;
		}
		if (await openTarget(target, ctx)) ctx.ui.notify?.(`Cursor ${target.path}:${target.line}`, "info");
	}
	pi.registerShortcut?.("ctrl+alt+o", {
		description: "Open last edited file in Cursor at the change line",
		handler: async (ctx) => { await openLast(ctx); },
	});
	pi.registerCommand?.("open", {
		description: "Open last edited file in Cursor (usage: /open [pick])",
		handler: async (args, ctx) => {
			if (args.trim() === "pick") {
				const generation = sessionGeneration;
				const recents = recentOpens();
				if (recents.length === 0) {
					ctx.ui.notify("No edited files in this session yet", "warning");
					return;
				}
				const labels = recents.map((target) => `${target.path}:${target.line}`);
				const selected = await ctx.ui.select("Open in Cursor", labels);
				if (!selected || generation !== sessionGeneration) return;
				const target = recents[labels.indexOf(selected)];
				if (target && await openTarget(target, ctx)) ctx.ui.notify(`Cursor ${target.path}:${target.line}`, "info");
				return;
			}
			await openLast(ctx);
		},
	});

	function startSession(ctx: ExtensionContext) {
		linkCwd = ctx.cwd;
		cursor.reset();
		openContext = ctx;
		clear();
		sessionGeneration++;
		if (process.platform === "linux" && ctx.mode === "tui" && deps.communication && linksEnabled()) {
			const generation = sessionGeneration;
			const notify = ctx.ui.notify?.bind(ctx.ui);
			const onError = (error: Error) => {
				if (generation === sessionGeneration) notify?.(`Could not start file links: ${error.message}`, "error");
			};
			try {
				installFileLinkHandler();
				fileLinks.start(onError);
			} catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
		}
	}

	function dispose() {
		fileLinks.stop();
		cursor.reset();
		openContext = undefined;
		clear();
		sessionGeneration++;
	}

	return { openTarget, startSession, dispose };
}
