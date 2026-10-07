import { getCapabilities } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cursorFileUrl, linkifyCodeReferences, type FileReference } from "./code-links.ts";
import { createFileLinkBridge } from "./file-link-bridge.ts";
import { installFileLinkHandler } from "./file-link-handler.ts";
import type { OpenTarget } from "./open-in-cursor.ts";

type SessionLinksDeps = {
	enabled: boolean;
	open: (target: OpenTarget) => Promise<boolean>;
	hyperlinks?: () => boolean;
	accepts?: (path: string) => boolean;
	fallbackUrl?: (reference: FileReference) => string;
};

/** Owns reply-link rendering and the session's private desktop-opening transport. */
export function createSessionLinks(pi: { registerMarkdownTransformer?: ExtensionAPI["registerMarkdownTransformer"] }, deps: SessionLinksDeps) {
	let cwd = process.cwd();
	let generation = 0;
	let started = false;
	const bridge = createFileLinkBridge(deps.open);
	const enabled = deps.hyperlinks ?? (() => {
		try { return getCapabilities().hyperlinks; } catch { return false; }
	});
	pi.registerMarkdownTransformer?.((markdown, context) => {
		if (!deps.enabled || context.messageType === "assistant-thinking" || !enabled()) return markdown;
		return linkifyCodeReferences(markdown, cwd, undefined, reference => {
			if (deps.accepts && !deps.accepts(reference.path)) return undefined;
			return process.platform === "linux" ? bridge.urlFor({ ...reference, cwd })
				: deps.fallbackUrl?.(reference) ?? cursorFileUrl(reference.path, reference.line, reference.column);
		});
	});
	function startSession(ctx: ExtensionContext) {
		if (started) bridge.stop();
		started = true;
		cwd = ctx.cwd;
		const current = ++generation;
		if (process.platform !== "linux" || ctx.mode !== "tui" || !deps.enabled || !enabled()) return;
		const notify = ctx.ui.notify?.bind(ctx.ui);
		const onError = (error: Error) => {
			if (current === generation) notify?.(`Could not start file links: ${error.message}`, "error");
		};
		try {
			installFileLinkHandler();
			bridge.start(onError);
		} catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
	}
	function dispose() {
		generation++;
		started = false;
		bridge.stop();
	}
	return { startSession, dispose };
}
