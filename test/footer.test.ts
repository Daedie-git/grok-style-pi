import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { cwdBasename, footerFromContext, formatFooterLine, formatPercent } from "../src/footer.ts";

test("cwdBasename uses the last path segment", () => {
	assert.equal(cwdBasename("/home/aim/git/fury"), "fury");
	assert.equal(cwdBasename("/home/aim/git/fury/"), "fury");
	assert.equal(cwdBasename("fury"), "fury");
});

test("formatFooterLine is cwd │ model │ N% ctx", () => {
	const line = formatFooterLine({
		cwd: "/home/aim/git/grok-style-pi",
		model: "Grok 4.6",
		percent: 12.4,
	});
	assert.equal(line, `${basename("/home/aim/git/grok-style-pi")} │ Grok 4.6 │ 12% ctx`);
	assert.match(line, / │ /);
	assert.match(line, /% ctx$/);
	assert.ok(line.includes("Grok 4.6"));
	assert.ok(line.includes(cwdBasename("/home/aim/git/grok-style-pi")));
});

test("formatPercent rounds and uses ? when unknown", () => {
	assert.equal(formatPercent(12.4), "12");
	assert.equal(formatPercent(0), "0");
	assert.equal(formatPercent(null), "?");
	assert.equal(formatPercent(undefined), "?");
});

test("footerFromContext reads cwd, model display name, and usage percent", () => {
	const line = footerFromContext({
		cwd: "/tmp/demo-project",
		model: { name: "Grok 4.6", id: "grok-4.6" },
		getContextUsage: () => ({ percent: 41.9 }),
	});
	assert.equal(line, "demo-project │ Grok 4.6 │ 42% ctx");
	assert.ok(line.includes("demo-project"));
	assert.ok(line.includes("Grok 4.6"));
	assert.match(line, /42% ctx/);
	assert.equal(line.split(" │ ").length, 3);
});

test("footerFromContext falls back to model id and unknown percent", () => {
	const line = footerFromContext({
		cwd: "/tmp/x",
		model: { id: "grok-4.5" },
	});
	assert.equal(line, "x │ grok-4.5 │ ?% ctx");
});
