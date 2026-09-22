import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cwdDisplayPath, cwdBasename, footerFromContext, footerLinesFromContext, formatFooterLine, formatPercent } from "../src/chrome/footer.ts";

test("cwdBasename uses the last path segment", () => {
	assert.equal(cwdBasename("/home/aim/git/fury"), "fury");
	assert.equal(cwdBasename("/home/aim/git/fury/"), "fury");
	assert.equal(cwdBasename("fury"), "fury");
});

test("formatFooterLine shows only the active model's context and usage", () => {
	const grok = formatFooterLine({
		cwd: join(homedir(), "git", "grok-style-pi"),
		model: "Grok 4.6",
		provider: "xai",
		percent: 12.4,
		grokPercent: 6,
		grokWeekly: "Weekly 63% left",
		subscription: "Weekly 88% left",
	});
	assert.equal(grok, `${join("~", "git", "grok-style-pi")} │ Grok 4.6 │ Context 6% used │ Weekly 63% left`);
	assert.doesNotMatch(grok, /Codex/);
	const codex = formatFooterLine({
		cwd: "/tmp/project", model: "Codex", provider: "openai-codex", percent: 12.4,
		grokPercent: 6, grokWeekly: "Weekly 63% left", subscription: "Weekly 88% left",
	});
	assert.equal(codex, "/tmp/project │ Codex │ Context 12% used │ Weekly 88% left");
	assert.doesNotMatch(codex, /Grok/);
	assert.equal(formatFooterLine({ cwd: "/tmp/project", model: "Claude", provider: "anthropic", percent: 12.4, grokPercent: 6, grokWeekly: "Weekly 63% left", subscription: "Weekly 88% left" }), "/tmp/project │ Claude │ Context 12% used");
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
		cwd: "/tmp/project", model: { name: "Codex", provider: "openai-codex" }, thinkingLevel: "high",
		getContextUsage: () => ({ percent: 42 }),
	};
	assert.deepEqual(footerLinesFromContext(ctx, 200, "high", "Weekly 88% left", undefined, { contextPercent: 6, weekly: "Weekly 63% left" }), [
		"/tmp/project │ Codex high │ Context 42% used │ Weekly 88% left",
	]);
	const grok = { ...ctx, model: { name: "Grok 4.7", provider: "xai" } };
	assert.deepEqual(footerLinesFromContext(grok, 200, "medium", "Weekly 88% left", undefined, { contextPercent: 30, weekly: "Weekly 42% left" }), [
		"/tmp/project │ Grok 4.7 medium │ Context 30% used │ Weekly 42% left",
	]);
	const narrow = footerLinesFromContext(ctx, 30, "off", "Weekly ?% left");
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
	assert.deepEqual(footerLinesFromContext(ctx, 160), ["/tmp/project │ GPT-6 Astra medium │ Context 12% used"]);
});

test("footer shows the branch beside the directory and omits it outside Git", () => {
	const ctx = { cwd: "/tmp/project", model: { name: "GPT-6 Astra" }, thinkingLevel: "medium", branch: "feature/footer" };
	assert.match(footerFromContext(ctx), /^\/tmp\/project \(feature\/footer\) │/);
	assert.match(footerLinesFromContext(ctx, 160)[0], /^\/tmp\/project \(feature\/footer\) │/);
	assert.doesNotMatch(footerLinesFromContext(ctx, 160, "medium", undefined, null)[0], /\(feature/);
	assert.ok(visibleWidth(footerLinesFromContext(ctx, 30)[0]) <= 30);
});
