import type { ToolRenderContext } from "./diamond.ts";

export function editDisplay(context: ToolRenderContext | undefined, expanded: boolean) {
	const state = context?.state;
	if (!state) return { open: true, expanded };
	state.grokEdit ??= { open: true, expanded };
	if (state.grokEdit.expanded !== expanded) {
		state.grokEdit.expanded = expanded;
		state.grokEdit.open = expanded;
	}
	return state.grokEdit;
}

export function toolDisplay(context: ToolRenderContext | undefined, expanded: boolean) {
	const state = context?.state;
	if (!state) return { open: expanded, expanded };
	state.grokTool ??= { open: expanded, expanded };
	if (state.grokTool.expanded !== expanded) {
		state.grokTool.expanded = expanded;
		state.grokTool.open = expanded;
	}
	return state.grokTool;
}
