import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_EXTS = new Set([".ts", ".js", ".mjs", ".cjs", ".md"]);

const FORBIDDEN = [
	/prototype\s*\./,
	/AssistantMessageComponent/,
	/node_modules\/@earendil-works/,
];

function walk(dir: string, files: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		const stat = statSync(path);
		if (stat.isDirectory()) walk(path, files);
		else if (SOURCE_EXTS.has(extname(name))) files.push(path);
	}
	return files;
}

test("first-party sources do not patch Pi internals", () => {
	const files = walk(ROOT).filter((path) => !path.includes("/test/"));
	const hits: string[] = [];
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		for (const pattern of FORBIDDEN) {
			if (pattern.test(text)) {
				hits.push(`${file}: ${pattern}`);
			}
		}
	}
	assert.deepEqual(hits, []);
});
