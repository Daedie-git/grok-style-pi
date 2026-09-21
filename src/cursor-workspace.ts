import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { refreshCompileCommands } from "./compile-commands.ts";
import { sanitizeToolText } from "./diamond.ts";
import { findGitRoot, openInCursor, workspaceFor, type OpenTarget } from "./open-in-cursor.ts";

export type CursorOpenContext = {
	cwd: string;
	isProjectTrusted?: () => boolean;
	ui: { notify?(message: string, kind?: "info" | "warning" | "error"): void };
};

export type CursorWorkspaceDeps = {
	open?: (target: OpenTarget) => Promise<void>;
	refresh?: typeof refreshCompileCommands;
};

async function canonical(path: string): Promise<string> {
	try { return await realpath(path); } catch { return resolve(path); }
}

/** Per-session ownership: concurrent first opens share regeneration, never a cached module-global job. */
export function createCursorWorkspaceOpener(deps: CursorWorkspaceDeps = {}) {
	const launch = deps.open ?? openInCursor;
	const refresh = deps.refresh ?? refreshCompileCommands;
	let lifetime = new AbortController();
	const workspaces = new Map<string, Promise<void>>();

	return {
		reset() {
			lifetime.abort();
			lifetime = new AbortController();
			workspaces.clear();
		},
		async open(target: OpenTarget, ctx?: CursorOpenContext): Promise<boolean> {
			const signal = lifetime.signal;
			const workspace = await canonical(workspaceFor(target.path, target.cwd));
			if (signal.aborted) return false;
			const notify = (message: string, kind: "info" | "warning") => {
				if (!signal.aborted) ctx?.ui.notify?.(sanitizeToolText(message).slice(0, 1000), kind);
			};
			// Without a session context (e.g. transcript reconstruction), just open the editor.
			if (ctx) {
				let pending = workspaces.get(workspace);
				if (!pending) {
					pending = (async () => {
						const sessionWorkspace = await canonical(findGitRoot(ctx.cwd) ?? ctx.cwd);
						if (signal.aborted) return;
						if (!ctx.isProjectTrusted?.() || sessionWorkspace !== workspace) {
							notify("Skipped compile_commands.json refresh: the target must be in the trusted session workspace.", "warning");
							return;
						}
						try {
							const result = await refresh(workspace, { signal, onProgress: message => notify(message, "info") });
							if (result.status === "refreshed") notify(result.message ?? "Refreshed compile_commands.json", "info");
							else if (result.message) notify(`${result.message} Opening Cursor without refresh; /reload to retry.`, "warning");
						} catch (error) {
							notify(`Could not refresh compile_commands.json: ${error instanceof Error ? error.message : String(error)}. Opening Cursor anyway; /reload to retry.`, "warning");
						}
					})();
					workspaces.set(workspace, pending);
				}
				await pending;
			}
			if (signal.aborted) return false;
			try { await launch(target); }
			catch (error) { if (!signal.aborted) throw error; }
			return !signal.aborted;
		},
	};
}
