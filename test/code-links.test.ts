import assert from "node:assert/strict";
import test from "node:test";
import { cursorFileUrl, linkifyCodeReferences, parseFileReference } from "../src/navigation/code-links.ts";

test("cursor file URLs keep the line and column for the URL handler", () => {
	assert.equal(cursorFileUrl("/repo/src/app.ts", 42, 3), "cursor://file/repo/src/app.ts:42:3");
	assert.equal(cursorFileUrl("C:\\repo\\project\\main.rs", 12, 5), "cursor://file/C:/repo/project/main.rs:12:5");
	assert.equal(cursorFileUrl("/repo/my file.ts", 1, 1), "cursor://file/repo/my%20file.ts:1:1");
});

test("file references use the supplied transport without changing web links", () => {
	const targets: unknown[] = [];
	const linked = linkifyCodeReferences("See `my file #1?.ts:42:3` and [web](https://example.com).", "/repo", () => true, reference => {
		targets.push(reference);
		return "grok-pi-file://open/session/target";
	});
	assert.deepEqual(targets, [{ path: "/repo/my file #1?.ts", line: 42, column: 3 }]);
	assert.equal(linked, "See [`my file #1?.ts:42:3`](<grok-pi-file://open/session/target>) and [web](https://example.com).");
});

test("existing links and reference links preserve their entire formatted labels", () => {
	const markdown = [
		"[**`src/app.ts`**](https://example.com)",
		"[*bold **`src/app.ts`***][target]",
		"[`src/app.ts`][target]",
		"[`src/app.ts`][]",
		"[`src/app.ts`]",
		"",
		"[target]: https://example.com",
		"[`src/app.ts`]: https://example.com/app",
	].join("\n");
	assert.equal(linkifyCodeReferences(markdown, "/repo", () => true), markdown);
	const standalone = "**`src/app.ts`**";
	const linked = "**[`src/app.ts`](<cursor://file/repo/src/app.ts:1:1>)**";
	assert.equal(linkifyCodeReferences(standalone, "/repo", () => true), linked);
	assert.equal(linkifyCodeReferences(linked, "/repo", () => true), linked);
});

test("generated labels preserve brackets, backslashes, and original code delimiters", () => {
	const labels = ["`src/[page].ts`", "`C:\\repo\\main.ts`", "``src/app.ts``", "``` src/app.ts ```"];
	for (const label of labels) {
		const linked = linkifyCodeReferences(label, "/repo", () => true);
		assert.ok(linked.startsWith(`[${label}](<cursor://file/`), linked);
		assert.ok(linked.endsWith(":1:1>)"), linked);
		assert.equal(linkifyCodeReferences(linked, "/repo", () => true), linked);
	}
});

test("inline code file references become cursor links without rewriting code blocks", () => {
	const exists = (path: string) => ["/repo/README.md", "/repo/Makefile", "/repo/my file.ts", "/repo/Dockerfile"].includes(path);
	const markdown = [
		"See `src/app.ts:42` and `b/server/index.js#L10`.",
		"Bare `README.md` exists. `missing.ts` does not. `npm test` is a command.",
		"`Makefile:42` and `Dockerfile` exist. `no-such-file` does not.",
		"`` `src/app.ts` `` stays a span. `my file.ts` exists.",
		"```ts",
		"const path = `src/app.ts:42`;",
		"```",
		"~~~js",
		"const path = `src/app.ts`;",
		"~~~",
		"Already [`src/app.ts`](https://example.com).",
	].join("\n");
	const linked = linkifyCodeReferences(markdown, "/repo", exists);
	assert.match(linked, /\[`src\/app\.ts:42`\]\(<cursor:\/\/file\/repo\/src\/app\.ts:42:1>\)/);
	assert.match(linked, /\[`Makefile:42`\]\(<cursor:\/\/file\/repo\/Makefile:42:1>\)/);
	assert.match(linked, /\[`Dockerfile`\]\(<cursor:\/\/file\/repo\/Dockerfile:1:1>\)/);
	assert.match(linked, /\[`my file\.ts`\]\(<cursor:\/\/file\/repo\/my%20file\.ts:1:1>\)/);
	assert.match(linked, /`missing\.ts`/);
	assert.match(linked, /`npm test`/);
	assert.match(linked, /`no-such-file`/);
	assert.match(linked, /```ts\nconst path = `src\/app\.ts:42`;\n```/);
	assert.match(linked, /~~~js\nconst path = `src\/app\.ts`;\n~~~/);
	assert.match(linked, /`` `src\/app\.ts` ``/);
	assert.match(linked, /\[`src\/app\.ts`\]\(https:\/\/example\.com\)/);
	assert.equal(linkifyCodeReferences(linked, "/repo", exists), linked);
	assert.equal(parseFileReference("https://example.com")?.path, undefined);
});
