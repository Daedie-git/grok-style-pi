import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import type { HerdrStore } from "../src/store.ts";

const SOURCES = fileURLToPath(new URL("../src/", import.meta.url));

function copySources(target: string) {
	mkdirSync(target, { recursive: true });
	for (const name of readdirSync(SOURCES)) copyFileSync(join(SOURCES, name), join(target, name));
}

async function listsNothing(store: HerdrStore) {
	try { assert.deepEqual(await store.listAgents(), []); }
	finally { await store.close(); }
}

test("the worker loads from an installed package path without Node TypeScript stripping", async () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-runner-package-"));
	const pkg = join(dir, "node_modules", "herdr-runner");
	copySources(join(pkg, "src"));
	writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
	symlinkSync(fileURLToPath(new URL(".", import.meta.resolve("jiti/package.json"))), join(dir, "node_modules", "jiti"), "dir");
	mkdirSync(join(dir, "node_modules", "@earendil-works"));
	symlinkSync(fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"))), join(dir, "node_modules", "@earendil-works", "pi-coding-agent"), "dir");
	try {
		const loaded = await createJiti(import.meta.url).import<{ HerdrStore: typeof HerdrStore }>(join(pkg, "src", "store.ts"));
		await listsNothing(new loaded.HerdrStore(join(dir, "state")));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a copy outside node_modules runs on Node's type stripping without jiti or Pi", async () => {
	// The Claude Code plugin carries the runner this way.
	const dir = mkdtempSync(join(tmpdir(), "herdr-runner-plain-"));
	copySources(join(dir, "src"));
	writeFileSync(join(dir, "package.json"), '{"type":"module"}');
	try {
		const loaded = await import(pathToFileURL(join(dir, "src", "store.ts")).href) as { HerdrStore: typeof HerdrStore };
		await listsNothing(new loaded.HerdrStore(join(dir, "state")));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
