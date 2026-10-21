import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileBody } from "../src/workflow/compile.ts";
import { parseWorkflowSource } from "../src/workflow/meta.ts";

const skillDir = new URL("../skills/workflow-authoring/", import.meta.url);

test("the workflow-authoring skill is valid and its examples compile with this runtime", () => {
	// Windows checkouts (core.autocrlf) carry CRLF; the assertions are about content, not line endings.
	const skill = readFileSync(new URL("SKILL.md", skillDir), "utf8").replace(/\r\n/g, "\n");
	assert.match(skill, /^---\nname: workflow-authoring\ndescription: .+\n---\n/);
	const examples = readFileSync(new URL("references/examples.md", skillDir), "utf8").replace(/\r\n/g, "\n");
	const scripts = [...examples.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
	assert.ok(scripts.length >= 4);
	for (const script of scripts) {
		const parsed = parseWorkflowSource(script);
		assert.ok(parsed.meta && !parsed.error, `metadata: ${parsed.error}`);
		const compiled = compileBody(parsed.body);
		assert.ok(compiled.ok, `${parsed.meta.name}: ${compiled.error}`);
	}
});
