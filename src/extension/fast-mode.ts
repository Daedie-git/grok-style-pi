import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY = "openai-fast";

function supported(model: ExtensionContext["model"]): boolean {
	return !!model && (model.provider === "openai" || model.provider === "openai-codex") && /^gpt-/i.test(model.id);
}

/** Shared by both full Grok entrypoints; never changes the model, provider, or transport. */
export function installFastMode(pi: ExtensionAPI) {
	let enabled = false;
	const status = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(KEY, enabled && supported(ctx.model) ? "Fast: priority requested" : undefined);
	};
	const restore = (ctx: ExtensionContext) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === KEY) {
				const data = entry.data as { enabled?: unknown } | undefined;
				if (typeof data?.enabled === "boolean") enabled = data.enabled;
			}
		}
		status(ctx);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => status(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(KEY, undefined));

	pi.registerCommand("fast", {
		description: "Request OpenAI GPT priority processing (may increase cost): /fast [on|off|status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			if (action !== "status") {
				const next = action === "on" || (action === "" && !enabled);
				pi.appendEntry(KEY, { enabled: next });
				enabled = next;
			}
			status(ctx);
			let message = "Fast mode off.";
			if (enabled) message = supported(ctx.model)
				? "Fast mode on: priority processing requested, not guaranteed; it may increase cost."
				: "Fast mode on; it applies only to OpenAI GPT models.";
			ctx.ui.notify(message, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supported(ctx.model) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return { ...event.payload, service_tier: "priority" };
	});
}
