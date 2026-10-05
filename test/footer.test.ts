import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cwdDisplayPath, cwdBasename, formatPercent, modelDisplayName, renderFooter, type FooterInput } from "../src/chrome/footer.ts";

const line = (input: FooterInput, width = 200) => renderFooter(input, { width })[0];

test("cwdBasename uses the last path segment", () => {
	assert.equal(cwdBasename("/home/aim/git/fury"), "fury");
	assert.equal(cwdBasename("/home/aim/git/fury/"), "fury");
	assert.equal(cwdBasename("fury"), "fury");
});

test("footer shows only the active model's context and usage", () => {
	const usage = { percent: 12.4, grokPercent: 6, grokWeekly: "Weekly 63% left", subscription: "Weekly 88% left" };
	const grok = line({ cwd: join(homedir(), "git", "grok-style-pi"), model: "Grok 4.6", thinkingLevel: "high", provider: "xai", ...usage });
	assert.equal(grok, `${join("~", "git", "grok-style-pi")} │ Grok 4.6 high │ Context 6% used │ Weekly 63% left`);
	assert.equal(line({ cwd: "/tmp/project", model: "Codex", thinkingLevel: "high", provider: "openai-codex", ...usage }), "/tmp/project │ Codex high │ Context 12% used │ Weekly 88% left");
	assert.equal(line({ cwd: "/tmp/project", model: "Claude", thinkingLevel: "high", provider: "anthropic", ...usage }), "/tmp/project │ Claude high │ Context 12% used");
});

test("footer reserves space for fast mode only on OpenAI providers", () => {
	const input = { cwd: "/tmp/project", model: "GPT-6", provider: "openai-codex", percent: 12, fastMode: true };
	assert.match(line(input), /│ Fast: on │ Context 12% used/);
	assert.match(line({ ...input, provider: "openai" }), /Fast: on/);
	assert.match(line({ ...input, fastMode: false }), /Fast: off/);
	assert.doesNotMatch(line({ ...input, fastMode: undefined }), /Fast:/);
	for (const enabled of [true, false]) {
		const painted = renderFooter({ ...input, fastMode: enabled }, {
			width: 200, paint: (token, text) => `<${token}>${text}</${token}>`,
		})[0];
		assert.ok(painted.includes(enabled ? "<accent>Fast: on</accent>" : "<muted>Fast: off</muted>"));
	}
	assert.doesNotMatch(line({ ...input, provider: "xai" }), /Fast:/);
	assert.doesNotMatch(line({ ...input, provider: "anthropic" }), /Fast:/);
	assert.match(line(input, 30), /Fast: on/);
	for (const width of [0, 1, 10, 20, 30, 60, 100]) {
		assert.ok(visibleWidth(line(input, width)) <= width, `width ${width}`);
	}
});

test("footer marks unknown model, thinking level, and context", () => {
	assert.equal(line({ cwd: "/tmp/x", model: " ", percent: undefined }), "/tmp/x │ unknown ? │ Context ?% used");
	assert.equal(modelDisplayName({ id: "grok-4.5" }), "grok-4.5");
	assert.equal(modelDisplayName(null), "unknown");
});

test("footer clips the account before the model and drops it when it would be unreadable", () => {
	const input = { cwd: "/tmp/project", model: "Codex", thinkingLevel: "high", provider: "openai-codex", percent: 12, subscription: "Weekly 88% left", account: "person@example.com" };
	assert.equal(line(input), "/tmp/project │ Codex high │ Context 12% used │ Weekly 88% left │ Account person@example.com");
	assert.equal(line(input, 80), "/tmp/project │ Codex high │ Context 12% used │ Weekly 88% left │ Account person…");
	assert.equal(line(input, 76), "/tmp/project │ Codex high │ Context 12% used │ Weekly 88% left");
	assert.equal(line(input, 60), "/tmp/project │ Codex h… │ Context 12% used │ Weekly 88% left");
	for (const width of [0, 1, 20, 45, 60, 76, 77, 100]) {
		assert.ok(visibleWidth(line(input, width)) <= width, `width ${width}`);
	}
});

test("footer measures before painting and paints every item", () => {
	const input = { cwd: "/tmp/项目", model: "Codex", thinkingLevel: "high", provider: "openai-codex", percent: 12, account: "名前@example.com" };
	const painted = renderFooter(input, { width: 50, paint: (token, text) => `\x1b[${token === "muted" ? 2 : 1}m${text}\x1b[0m` })[0];
	assert.ok(visibleWidth(painted) <= 50);
	assert.equal(painted.replace(/\x1b\[\d+m/g, ""), line(input, 50));
	assert.doesNotMatch(painted.replace(/\x1b\[\d+m[^\x1b]*\x1b\[0m/g, ""), /\S/);
});

test("formatPercent rounds and uses ? when unknown", () => {
	assert.equal(formatPercent(12.4), "12");
	assert.equal(formatPercent(0), "0");
	assert.equal(formatPercent(null), "?");
	assert.equal(formatPercent(undefined), "?");
});

test("footer keeps usage on one row and clips identity first", () => {
	const input = { cwd: "/tmp/project", model: "Codex", thinkingLevel: "off", provider: "openai-codex", percent: 42, subscription: "Weekly ?% left" };
	const narrow = renderFooter(input, { width: 45 });
	assert.equal(narrow.length, 1);
	assert.match(narrow[0], /│ Context 42% used │ Weekly \?% left$/);
	assert.ok(visibleWidth(narrow[0]) <= 45);
	assert.ok(visibleWidth(line(input, 30)) <= 30);
	assert.deepEqual(renderFooter(input, { width: 0 }), [""]);
});


test("display path abbreviates only the home directory and its descendants", () => {
	assert.equal(cwdDisplayPath("/home/aim", "/home/aim"), "~");
	assert.equal(cwdDisplayPath("/home/aim/git/project", "/home/aim"), "~/git/project");
	assert.equal(cwdDisplayPath("/home/aim-other/project", "/home/aim"), "/home/aim-other/project");
	assert.equal(cwdDisplayPath("/tmp/project", "/home/aim"), "/tmp/project");
});


test("footer shows the branch beside the directory and omits it outside Git", () => {
	const input = { cwd: "/tmp/project", model: "GPT-6 Astra", thinkingLevel: "medium", percent: 12, branch: "feature/footer" };
	assert.equal(line(input), "/tmp/project (feature/footer) │ GPT-6 Astra medium │ Context 12% used");
	assert.doesNotMatch(line({ ...input, branch: null }), /\(feature/);
	assert.ok(visibleWidth(line(input, 30)) <= 30);
});
