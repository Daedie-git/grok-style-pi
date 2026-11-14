/** Claude models subagents may run unless the host configures `claudeModels`; the first is Claude Code's default. */
export const DEFAULT_CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];
const FAMILIES = ["opus", "sonnet", "haiku", "fable"];

const isClaude = (name: string) => /claude|opus|sonnet|haiku|fable|^anthropic\//i.test(name);
const bare = (name: string) => name.replace(/^anthropic\//i, "").toLowerCase();

/**
 * A Claude request normalized to an allowed model id (`opus` names the first allowed Opus), or an error; other models pass
 * through. `claudeCode`: every name is a Claude model, so Claude Code's own aliases such as `default` are refused.
 */
export function allowedModel(requested: string | undefined, models: string[], claudeCode = false): { model?: string; error?: string } {
	const name = requested?.trim();
	if (!name || name.toLowerCase() === "inherit" || (!claudeCode && !isClaude(name))) return { model: requested };
	const id = bare(name);
	const model = FAMILIES.includes(id) ? models.find((item) => bare(item).includes(id)) : models.find((item) => bare(item) === id);
	return model ? { model: name.toLowerCase().startsWith("anthropic/") ? `anthropic/${bare(model)}` : bare(model) } : { error: notAllowed(name, models) };
}

export const allowedListing = (id: string, models: string[]) => !isClaude(id) || models.some((item) => bare(item) === bare(id));
export const notAllowed = (name: string, models: string[]) => `Model ${name} is not allowed; Claude subagents run ${models.join(" or ") || "no Claude model"}.`;
