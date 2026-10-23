import { loadProjectMemory } from "./project-memory.ts";
import { sanitizeToolText } from "../tools/diamond.ts";

type MemoryPromptEvent = {
	systemPrompt: string;
	systemPromptOptions?: { sections?: Record<string, string> };
};

type MemorySessionContext = {
	cwd: string;
	ui: { notify?(message: string, kind: "warning"): void };
};

/** Owns memory prompt sections, cancellable loads, and session-scoped warnings. */
export function createProjectMemorySession(options: {
	enabled: boolean;
	storageRoot?: string;
	loadMemory?: typeof loadProjectMemory;
}) {
	const { enabled, storageRoot, loadMemory = loadProjectMemory } = options;
	let pending: AbortController | undefined;
	let warningShown = false;
	let disposed = false;

	function cancelPending() {
		const previous = pending;
		pending = undefined;
		previous?.abort();
	}

	// The caller may compose other legacy guidance first; publish it only if
	// this request remains current, comparing against the untouched event prompt.
	async function beforeAgentStart(event: MemoryPromptEvent, ctx: MemorySessionContext, candidatePrompt = event.systemPrompt): Promise<{ systemPrompt: string } | undefined> {
		cancelPending();
		const sections = event.systemPromptOptions?.sections;
		let prompt = candidatePrompt;
		if (sections) {
			// This section belongs to Grok, not another extension's project_memory.
			delete sections.grok_project_memory;
		} else {
			prompt = prompt.replace(/(?:^|\n\n)<grok_project_memory>\n[\s\S]*?\n<\/grok_project_memory>/g, "");
		}
		const result = () => !sections && prompt !== event.systemPrompt ? { systemPrompt: prompt } : undefined;
		if (!enabled || disposed) return result();

		const request = new AbortController();
		pending = request;
		const current = () => pending === request && !request.signal.aborted;
		try {
			if (!storageRoot) throw new Error("No project-memory storage root was configured");
			const memory = await loadMemory(ctx.cwd, storageRoot, { signal: request.signal });
			if (!current()) return;
			if (sections) sections.grok_project_memory = memory.content;
			else prompt += `\n\n<grok_project_memory>\n${memory.content}\n</grok_project_memory>`;
		} catch (error) {
			if (!current()) return;
			if (!warningShown) {
				warningShown = true;
				ctx.ui.notify?.(`Project memory unavailable; no memory context loaded: ${sanitizeToolText(String(error)).slice(0, 500)}`, "warning");
			}
		} finally {
			if (pending === request) pending = undefined;
		}
		return result();
	}

	return {
		beforeAgentStart,
		startSession() {
			cancelPending();
			warningShown = false;
			disposed = false;
		},
		dispose() {
			disposed = true;
			cancelPending();
		},
	};
}
