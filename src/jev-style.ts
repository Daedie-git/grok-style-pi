import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionFactory, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { DIAMOND, sanitizeToolText, textComponent } from "./diamond.ts";
import { wrapWithDiamondRenderer } from "./tools.ts";

const labels: Record<string, string> = {
	"pi-warden-steer": "Jev · Warden intervention",
	"pi-warden-status": "Jev · Warden status",
	"jev-discovery-evidence": "Jev · Discovery guidance and source evidence",
};
const expansion = new WeakMap<object, { open: boolean; global: boolean }>();
const known = (type: string) => Object.hasOwn(labels, type);

/** Display only: never change intervention contents or delivery/turn semantics. */
export const renderJevMessage: MessageRenderer = (message, options, theme) => {
	let state = expansion.get(message);
	if (!state) { state = { open: options.expanded, global: options.expanded }; expansion.set(message, state); }
	if (state.global !== options.expanded) { state.open = options.expanded; state.global = options.expanded; }
	const display = state;
	const body = sanitizeToolText(typeof message.content === "string" ? message.content :
		message.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
	const firstLine = body.split("\n").map(line => line.trim()).find(Boolean)?.replace(/^pi-warden:\s*/i, "") ?? "";
	const summary = message.customType === "jev-discovery-evidence" ? labels[message.customType] :
		`${labels[message.customType] ?? "Jev intervention"}${firstLine ? `: ${firstLine.slice(0, 160)}` : ""}`;
	const header = textComponent(theme.fg("accent", `${DIAMOND} ${summary}`), true);
	const contents = textComponent(theme.fg("toolOutput", body));
	return {
		render(width) {
			return [...header.render(width), ...(display.open ? contents.render(Math.max(0, width - 2)).map(line => `  ${line}`) : [])];
		},
		handleMouse(event) {
			if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
			display.open = !display.open;
			return { handled: true };
		},
		invalidate() {},
	};
};

/** Load the owner once, decorating its public API instead of patching installed files. */
export async function registerStyledJev(pi: ExtensionAPI, factory: ExtensionFactory, enabled: boolean) {
	if (!enabled) return factory(pi);
	for (const type of Object.keys(labels)) pi.registerMessageRenderer(type, renderJevMessage);
	const sendMessage: ExtensionAPI["sendMessage"] = (message, options) =>
		pi.sendMessage(known(message.customType) ? { ...message, display: true } : message, options);
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		if (tool.name !== "jev_advisory_assess") return pi.registerTool(tool);
		const { renderCall, renderResult, renderShell } = wrapWithDiamondRenderer(tool);
		pi.registerTool({ ...tool, renderCall, renderResult, renderShell });
	};
	await factory(new Proxy(pi, {
		get(target, key, receiver) {
			if (key === "sendMessage") return sendMessage;
			if (key === "registerTool") return registerTool;
			if (key === "on") return (event: string, handler: unknown) => {
				if (event !== "before_agent_start") return Reflect.apply(target.on, target, [event, handler]);
				return target.on("before_agent_start", async (event, ctx) => {
					const result = await (handler as (event: unknown, ctx: unknown) => Promise<BeforeAgentStartEventResult | void> | BeforeAgentStartEventResult | void)(event, ctx);
					return result?.message && known(result.message.customType) ?
						{ ...result, message: { ...result.message, display: true } } : result;
				});
			};
			return Reflect.get(target, key, receiver);
		},
	}));
}
