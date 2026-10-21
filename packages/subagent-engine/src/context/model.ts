export interface ModelLite { provider: string; id: string; name?: string }
interface ModelInput {
	invocation?: string;
	definition?: string;
	env: Record<string, string | undefined>;
	parent: ModelLite;
	available: ModelLite[];
	isFork: boolean;
}
interface ModelResolution { model: ModelLite; requested?: string; source: string; note?: string }

const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;
function newest(models: ModelLite[]): ModelLite | undefined {
	// Compare version numbers before release-date suffixes, including older
	// Claude ids that put the version before the family name.
	const version = (id: string): number[] => (id.match(/\d+/g) ?? []).filter((part) => part.length !== 8).map(Number);
	return [...models].sort((a, b) => {
		const av = version(a.id), bv = version(b.id);
		for (let i = 0; i < Math.max(av.length, bv.length); i++) {
			const difference = (bv[i] ?? 0) - (av[i] ?? 0);
			if (difference) return difference;
		}
		return b.id.localeCompare(a.id, "en", { numeric: true }) || a.provider.localeCompare(b.provider);
	})[0];
}

function matchModel(requested: string, available: ModelLite[]): ModelLite | undefined {
	const exact = available.find((model) => `${model.provider}/${model.id}` === requested)
		?? available.find((model) => model.id === requested);
	if (exact) return exact;
	const lower = requested.toLowerCase();
	if (["sonnet", "opus", "haiku", "fable"].includes(lower)) {
		return newest(available.filter((model) => model.id.toLowerCase().includes(lower)));
	}
	return newest(available.filter((model) => model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower)));
}

function family(id: string): string | undefined {
	return /^[a-z]+(?:-[a-z]+)*/i.exec(id)?.[0].toLowerCase();
}

function familyModel(requested: string, input: ModelInput): ModelLite | undefined {
	const slash = requested.indexOf("/");
	const provider = slash < 0 ? input.parent.provider : requested.slice(0, slash);
	const token = family(slash < 0 ? requested : requested.slice(slash + 1));
	return token ? newest(input.available.filter((model) => model.provider === provider && family(model.id) === token)) : undefined;
}

export function resolveModel(input: ModelInput): ModelResolution {
	if (input.isFork) return { model: input.parent, source: "fork" };
	const force = clean(input.env.PI_SUBAGENT_MODEL_FORCE);
	const invocation = clean(input.invocation);
	const definition = clean(input.definition);
	const envDefault = clean(input.env.PI_SUBAGENT_MODEL);
	let requested: string | undefined;
	let source: string;
	if (force) { requested = force; source = "force"; }
	else if (invocation) { requested = invocation; source = "invocation"; }
	else if (definition) { requested = definition; source = "definition"; }
	else if (envDefault) { requested = envDefault; source = "env"; }
	else return { model: input.parent, source: "parent" };
	if (requested.toLowerCase() === "inherit") return { model: input.parent, requested, source };
	const matched = matchModel(requested, input.available);
	if (matched) return { model: matched, requested, source };
	const related = familyModel(requested, input);
	if (related) return { model: related, requested, source, note: `Model ${requested} is unavailable; using family fallback ${related.provider}/${related.id}.` };
	const fallback = envDefault && envDefault !== requested ? matchModel(envDefault, input.available) : undefined;
	if (fallback) return { model: fallback, requested, source, note: `Model ${requested} is unavailable; using PI_SUBAGENT_MODEL (${fallback.provider}/${fallback.id}).` };
	return { model: input.parent, requested, source, note: `Model ${requested} is unavailable; using the parent model (${input.parent.provider}/${input.parent.id}).` };
}

interface EffortInput {
	invocation?: string;
	definition?: string;
	roleDefault?: string;
	parent?: string;
	env: Record<string, string | undefined>;
	isFork: boolean;
}
interface EffortResolution { requested?: string; effort?: string; source: string; note?: string }
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function resolveEffort(input: EffortInput): EffortResolution {
	if (input.isFork) return { effort: input.parent, source: "fork" };
	const notes: string[] = [];
	const candidates = [
		["env", input.env.PI_SUBAGENT_EFFORT], ["invocation", input.invocation],
		["definition", input.definition], ["role", input.roleDefault], ["parent", input.parent],
	] as const;
	for (const [source, raw] of candidates) {
		const requested = clean(raw);
		if (!requested) continue;
		if (!EFFORTS.has(requested)) {
			notes.push(`Ignored unsupported ${source} effort ${JSON.stringify(requested)}.`);
			continue;
		}
		return { requested, effort: requested, source, ...(notes.length ? { note: notes.join(" ") } : {}) };
	}
	return { source: "parent", ...(notes.length ? { note: notes.join(" ") } : {}) };
}

export function roleDefaultEffort(agentType: string): string | undefined {
	const words = agentType.toLowerCase().split(/[^a-z]+/);
	if (words.some((word) => ["review", "reviewer", "reviewing"].includes(word))) return "high";
	if (words.some((word) => ["explore", "explorer", "exploration", "exploring", "implement", "implementer", "implementation", "implementing"].includes(word))) return "medium";
	return undefined;
}
