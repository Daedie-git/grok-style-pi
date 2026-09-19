import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cwdDisplayPath, cwdBasename, footerFromContext, footerLinesFromContext, formatFooterLine, formatPercent } from "../src/footer.ts";

test("cwdBasename uses the last path segment", () => {
	assert.equal(cwdBasename("/home/aim/git/fury"), "fury");
	assert.equal(cwdBasename("/home/aim/git/fury/"), "fury");
	assert.equal(cwdBasename("fury"), "fury");
});

test("formatFooterLine is cwd │ model │ Context N% used", () => {
	const line = formatFooterLine({
		cwd: join(homedir(), "git", "grok-style-pi"),
		model: "Grok 4.6",
		percent: 12.4,
	});
	assert.equal(line, `${join("~", "git", "grok-style-pi")} │ Grok 4.6 │ Context 12% used`);
	assert.match(line, / │ /);
	assert.match(line, /% used$/);
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
	assert.equal(line, "/tmp/demo-project │ Grok 4.6 │ Context 42% used");
	assert.ok(line.includes("demo-project"));
	assert.ok(line.includes("Grok 4.6"));
	assert.match(line, /Context 42% used/);
	assert.equal(line.split(" │ ").length, 3);
});

test("footerFromContext falls back to model id and unknown percent", () => {
	const line = footerFromContext({
		cwd: "/tmp/x",
		model: { id: "grok-4.5" },
	});
	assert.equal(line, "/tmp/x │ grok-4.5 │ Context ?% used");
});

test("footer keeps subscription usage on one row without token or cost totals", () => {
	const ctx = {
		cwd: "/tmp/project", model: { name: "Codex" }, thinkingLevel: "high",
		getContextUsage: () => ({ percent: 42 }),
	};
	assert.deepEqual(footerLinesFromContext(ctx, 120, "high", "Codex weekly 88% left"), [
		"/tmp/project │ Codex high │ Context 42% used │ Codex weekly 88% left",
	]);
	const narrow = footerLinesFromContext(ctx, 30, "off", "Codex weekly ? left");
	assert.equal(narrow.length, 1);
	assert.ok(visibleWidth(narrow[0]) <= 30);
	assert.deepEqual(footerLinesFromContext(ctx, 0), [""]);
});


test("display path abbreviates only the home directory and its descendants", () => {
	assert.equal(cwdDisplayPath("/home/aim", "/home/aim"), "~");
	assert.equal(cwdDisplayPath("/home/aim/git/project", "/home/aim"), "~/git/project");
	assert.equal(cwdDisplayPath("/home/aim-other/project", "/home/aim"), "/home/aim-other/project");
	assert.equal(cwdDisplayPath("/tmp/project", "/home/aim"), "/tmp/project");
});


test("footer combines the model and thinking level in a single field", () => {
	const ctx = { cwd: "/tmp/project", model: { name: "GPT-6 Astra" }, thinkingLevel: "medium", getContextUsage: () => ({ percent: 12 }) };
	assert.equal(footerFromContext(ctx), "/tmp/project │ GPT-6 Astra medium │ Context 12% used");
	assert.deepEqual(footerLinesFromContext(ctx, 120), ["/tmp/project │ GPT-6 Astra medium │ Context 12% used"]);
});

test("footer shows the branch beside the directory and omits it outside Git", () => {
	const ctx = { cwd: "/tmp/project", model: { name: "GPT-6 Astra" }, thinkingLevel: "medium", branch: "feature/footer" };
	assert.match(footerFromContext(ctx), /^\/tmp\/project \(feature\/footer\) │/);
	assert.match(footerLinesFromContext(ctx, 160)[0], /^\/tmp\/project \(feature\/footer\) │/);
	assert.doesNotMatch(footerLinesFromContext(ctx, 160, "medium", undefined, null)[0], /\(feature/);
	assert.ok(visibleWidth(footerLinesFromContext(ctx, 30)[0]) <= 30);
});
