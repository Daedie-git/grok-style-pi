import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { installGrokStyle, type InstallDeps } from "../extensions/install.ts";
import type { ToolTransform } from "../src/tools/register-extension.ts";
import { createHerdrSubagents } from "../packages/herdr-subagents/src/herdr/extension.ts";
import type { HerdrBackendHandle } from "../packages/herdr-subagents/src/herdr/backend.ts";
import { HerdrBackendAdapter } from "../packages/subagent-engine/src/backends/herdr.ts";
import type { Engine } from "../packages/subagent-engine/src/engine.ts";
import { createSubagentEngine, inChildContext, type SubagentEngineOptions } from "../packages/subagent-engine/src/extension.ts";
import { selectSubagentRuntime } from "../src/subagents/runtime.ts";
import { registerStyledSubagents } from "../src/subagents/result-style.ts";
import { createHerdrNotificationRenderer } from "../src/subagents/notification-style.ts";

export async function loadSubagentExtension(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv,
	load: { herdr: ExtensionFactory; current: ExtensionFactory },
	styling: boolean,
	styleTool?: ToolTransform,
) {
	const herdr = selectSubagentRuntime(env) === "herdr";
	if (styling) {
		for (const type of herdr ? ["herdr-subagent-notification"] : ["subagent-notification", "subagent-message", "agent-message", "subagent-stop-feedback"]) {
			pi.registerMessageRenderer(type, createHerdrNotificationRenderer());
		}
	}
	await registerStyledSubagents(pi, herdr ? load.herdr : load.current, styling, styleTool, herdr);
}

/** Preserve the implicit remote worker path of existing combined installations. */
export function herdrIntegrationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		GROK_HERDR_REMOTE_PACKAGE: env.GROK_HERDR_REMOTE_PACKAGE || fileURLToPath(new URL("..", import.meta.url)),
	};
}

/** The same entrypoint with injectable engine services for embedding and offline SDK tests. */
export function createGrokSubagents(options: { engine?: SubagentEngineOptions; style?: InstallDeps; env?: NodeJS.ProcessEnv } = {}): ExtensionFactory {
	return async (pi) => {
		if (inChildContext()) return;
		const { runtime, features, activity } = await installGrokStyle(pi, options.style);
		const env = options.env ?? process.env;
		const inHerdr = selectSubagentRuntime(env) === "herdr";
		// Inside Herdr the engine stays the runner (in-process by default); Herdr becomes its pane backend, used only when an
		// Agent call asks for a pane, a saved machine or the Claude Code runtime. Its headless mode also keeps this Pi working as
		// a pane child (child lifecycle, tool scope) for parents that launch it.
		let current: Engine | undefined;
		let handle: HerdrBackendHandle | undefined;
		let detach: (() => void) | undefined;
		const connect = () => {
			if (!current || !handle) return;
			detach?.();
			detach = current.attachHerdr(new HerdrBackendAdapter(handle));
		};
		if (inHerdr) {
			await createHerdrSubagents({ env: herdrIntegrationEnvironment(env), mode: "backend", onBackend(created) { handle = created; connect(); } })(pi);
		}
		const engine = createSubagentEngine({
			...options.engine,
			panes: inHerdr || options.engine?.panes,
			autonomy: features.autonomy ? "positive" : "explicit",
			onEngine(created) { activity?.attachEngine(created); current = created; connect(); options.engine?.onEngine?.(created); },
		});
		await loadSubagentExtension(pi, { ...env, HERDR_ENV: undefined }, { herdr: unavailable, current: engine }, features.toolStyling, runtime.styleTool);
		if (inHerdr && features.toolStyling) pi.registerMessageRenderer("herdr-subagent-notification", createHerdrNotificationRenderer());
	};
}

/** Load instead of the default Grok extension, never alongside it. */
export default createGrokSubagents();

const unavailable: ExtensionFactory = () => {
	throw new Error("Subagent runtime was selected without its factory");
};
