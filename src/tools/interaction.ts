import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { openInCursor, type OpenTarget } from "../navigation/open-in-cursor.ts";
import type { ToolArgs } from "./diamond.ts";

/**
 * Pi toggles a tool's expansion for any left click a diamond leaves unhandled,
 * so a click that must do nothing is "inert": consumed without a state change.
 *
 * One gesture table for every diamond. A header is the control and a body is
 * content: a plain click never changes a body, Alt-click closes it, and
 * Ctrl-click opens the surface's file target (consumed even without one).
 */
export type ClickSurface = "header" | "body";
export type ClickAction = "toggle" | "close" | "open-target" | "inert" | "none";

// Pi builds a click from the release event, so a modifier let go before the
// button is missing from it. The press that started the click still has it.
const PRESS_MEMORY_MS = 5000;
let lastPress: { x: number; y: number; ctrl: boolean; alt: boolean; at: number } | undefined;
const spot = (event: TuiMouseEvent) => ({ x: event.screenX ?? event.x, y: event.screenY ?? event.y });

/** Records a left press, and gives a click the modifiers held when it began. */
export function withPressModifiers(event: TuiMouseEvent): TuiMouseEvent {
	if (event.button !== "left") return event;
	if (event.type === "press") {
		lastPress = { ...spot(event), ctrl: Boolean(event.ctrl), alt: Boolean(event.alt), at: Date.now() };
		return event;
	}
	if (event.type !== "click" || !lastPress) return event;
	const press = lastPress;
	const here = spot(event);
	if (press.x !== here.x || press.y !== here.y || Date.now() - press.at > PRESS_MEMORY_MS) return event;
	return { ...event, ctrl: event.ctrl || press.ctrl, alt: event.alt || press.alt };
}

export function classifyClick(
	raw: TuiMouseEvent,
	surface: ClickSurface,
	state: { open: boolean; closeNeedsAlt?: boolean },
): ClickAction {
	const event = withPressModifiers(raw);
	if (event.type !== "click" || event.button !== "left") return "none";
	if (event.ctrl) return "open-target";
	if (surface === "body") return event.alt ? "close" : "inert";
	if (event.alt) return "toggle";
	return state.closeNeedsAlt && state.open ? "inert" : "toggle";
}

type Display = { open: boolean };

/** Applies the shared rules to a diamond whose open state is a plain flag. */
export function handleDiamondClick(event: TuiMouseEvent, surface: ClickSurface, options: {
	display?: Display;
	closeNeedsAlt?: boolean;
	invalidate?: () => void;
	openTarget?: () => void;
}): { handled: true } | undefined {
	const display = options.display;
	const action = classifyClick(event, surface, { open: display?.open ?? false, closeNeedsAlt: options.closeNeedsAlt });
	if (action === "none") return undefined;
	if (action === "open-target") {
		// Ctrl-click always wins over a plain click, even where there is nothing to open.
		options.openTarget?.();
		return { handled: true };
	}
	if (action === "inert" || action === "close" && display && !display.open) return { handled: true };
	// Without display state, Pi's own expansion toggle is the fallback.
	if (!display) return undefined;
	display.open = action === "toggle" ? !display.open : false;
	options.invalidate?.();
	return { handled: true };
}

export function defaultModifierOpen(target: OpenTarget): void {
	// Standalone renderers have no notification UI. Never leak a launcher rejection.
	void openInCursor(target).catch(() => {});
}

/** The file a tool call names, or undefined when it names none. */
export function fileTarget(
	args: ToolArgs,
	line: number,
	cwd: string | undefined,
	open: (target: OpenTarget) => void,
): (() => void) | undefined {
	const path = typeof args?.path === "string" && args.path.trim() ? args.path : undefined;
	return path ? () => open({ path, line: Math.max(1, Math.trunc(line)), cwd: cwd ?? process.cwd() }) : undefined;
}
