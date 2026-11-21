import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeConfig } from "./location.ts";

/** Local half of Claude Code 2.1.330's feature lookup. A remote assignment held by Claude is process-private. */
export function usesMemorySelector({ env, home, configDir }: ClaudeConfig): boolean {
	if (env.CLAUDE_MEMORY_STORES?.trim()) return true;
	const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
	const primary = join(env.CLAUDE_CONFIG_DIR ? configDir : home, `.claude${suffix}.json`);
	const legacy = join(configDir, ".config.json");
	try {
		const old = statSync(legacy, { throwIfNoEntry: false });
		const current = statSync(primary, { throwIfNoEntry: false });
		const preferLegacy = old?.isFile() && (old.size > 0 || ((old.mode & 0o222) !== 0 && (!current || (current.size === 0 && !(current.mode & 0o222)))));
		const path = preferLegacy ? legacy : primary;
		if (!(preferLegacy ? old : current)?.isFile()) return false;
		const data = JSON.parse(readFileSync(path, "utf8"));
		return Boolean((data?.cachedGrowthBookFeatures ?? data?.cachedFeatureFlags)?.tengu_moth_copse);
	} catch { return false; }
}
