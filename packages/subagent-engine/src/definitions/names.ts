/** Normalize renamed built-in types without changing unrelated custom names. */
export function canonicalAgentType(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "adversarial-review") return "review";
	return ["explore", "plan", "review"].includes(lower) ? lower : name;
}
