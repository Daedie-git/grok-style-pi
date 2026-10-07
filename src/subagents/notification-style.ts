import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeToolText, textComponent } from "../tools/diamond.ts";
import { handleDiamondClick } from "../tools/interaction.ts";

/** Keep display-only expansion per message, without changing the runner's stored notice. */
export function createHerdrNotificationRenderer(): MessageRenderer {
	const states = new WeakMap<object, { open: boolean; expanded: boolean }>();
	return (message, { expanded }, theme) => {
		let display = states.get(message);
		if (!display) {
			display = { open: expanded, expanded };
			states.set(message, display);
		} else if (display.expanded !== expanded) {
			display.expanded = expanded;
			display.open = expanded;
		}
		const state = display;
		const content = typeof message.content === "string" ? message.content : message.content
			.filter(part => part.type === "text").map(part => part.text).join("\n");
		const clean = sanitizeToolText(content).replace(/\t/g, "    ").trim();
		const [first, ...rest] = clean.split("\n");
		const title = first.trim() || "Background agent notification";
		const body = textComponent(rest.join("\n"));
		return {
			render(width) {
				if (width <= 0) return [];
				const header = truncateToWidth(theme.fg("toolTitle", `◆ ${title}`), width);
				if (!state.open) return [header];
				const padding = " ".repeat(Math.min(2, width - 1));
				return [header, ...body.render(width - padding.length).map(line =>
					truncateToWidth(padding + theme.fg("toolOutput", line), width, ""))];
			},
			handleMouse(event) {
				return handleDiamondClick(event, event.y === 0 ? "header" : "body", { display: state });
			},
			invalidate() { body.invalidate(); },
		};
	};
}
