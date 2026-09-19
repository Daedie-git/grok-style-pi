import assert from "node:assert/strict";
import test from "node:test";
import { DIAMOND, extractResultText, formatToolCall, formatToolResult } from "../src/diamond.ts";

test("formatToolCall is a one-line Grok-style summary", () => {
	const call = formatToolCall("read", { path: "src/footer.ts" });
	assert.ok(call.startsWith(DIAMOND));
	assert.ok(call.startsWith("◆ "));
	assert.ok(call.includes("Read"));
	assert.ok(call.includes("src/footer.ts"));
	assert.equal(call, "◆ Read src/footer.ts");
	assert.equal(call.split("\n").length, 1);
});

test("formatToolCall uses command for bash and pattern for grep", () => {
	assert.equal(formatToolCall("bash", { command: "ls -la" }), "◆ Ran ls -la");
	assert.equal(formatToolCall("grep", { pattern: "TODO", glob: "*.ts" }), "◆ Searched TODO *.ts");
	assert.equal(formatToolCall("ls"), "◆ Listed");
});

test("collapsed result is shorter than expanded and omits full output", () => {
	const full = Array.from({ length: 20 }, (_, i) => `line-${i}-UNIQUE-BODY`).join("\n");
	const result = { content: [{ type: "text", text: full }] };
	const collapsed = formatToolResult(result, { expanded: false });
	const expanded = formatToolResult(result, { expanded: true });

	assert.equal(collapsed.collapsed, true);
	assert.equal(expanded.collapsed, false);
	assert.equal(collapsed.text, "");
	assert.ok(collapsed.text.length < expanded.text.length);
	assert.ok(!collapsed.text.includes("line-19-UNIQUE-BODY"));
	assert.ok(expanded.text.includes("line-19-UNIQUE-BODY"));
	assert.equal(expanded.text, full);
	assert.equal(extractResultText(result), full);
});

test("partial results stay collapsed with no extra line", () => {
	const partial = formatToolResult({ content: [{ type: "text", text: "streaming" }] }, { expanded: false, isPartial: true });
	assert.equal(partial.collapsed, true);
	assert.equal(partial.text, "");
});
