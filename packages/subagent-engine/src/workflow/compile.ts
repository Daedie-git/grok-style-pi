import { parse } from "acorn";
import { Script } from "node:vm";

export function instrumentBody(body: string): string {
	const prefix = '(async function(){"use strict";\n';
	const ast = parse(`${prefix}${body}\n})()`, { ecmaVersion: "latest", sourceType: "script" });
	const insertions: { offset: number; text: string }[] = [];
	function visit(value: unknown): void {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) { for (const child of value) visit(child); return; }
		const node = value as Record<string, unknown>;
		if (["WhileStatement", "DoWhileStatement", "ForStatement", "ForOfStatement", "ForInStatement"].includes(String(node.type))) {
			const block = node.body as { type: string; start: number; end: number };
			if (block.type === "BlockStatement") insertions.push({ offset: block.start + 1 - prefix.length, text: "__workflow$check();" });
			else {
				insertions.push({ offset: block.start - prefix.length, text: "{__workflow$check();" });
				insertions.push({ offset: block.end - prefix.length, text: "}" });
			}
		}
		if (node.type === "AwaitExpression") {
			const argument = node.argument as { start: number; end: number };
			insertions.push({ offset: argument.start - prefix.length, text: "__workflow$await(" }, { offset: argument.end - prefix.length, text: ")" });
		}
		for (const [key, child] of Object.entries(node)) if (key !== "start" && key !== "end") visit(child);
	}
	visit(ast);
	for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) body = body.slice(0, insertion.offset) + insertion.text + body.slice(insertion.offset);
	return body;
}

export function compileBody(body: string): { ok: boolean; error?: string } {
	try {
		const source = `(async function(){"use strict";\n${body}\n})()`;
		const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
		function visit(value: unknown): void {
			if (!value || typeof value !== "object") return;
			if (Array.isArray(value)) { for (const item of value) visit(item); return; }
			const node = value as Record<string, unknown>;
			if (node.type === "ImportExpression" || node.type === "WithStatement" || node.kind === "await using") throw new SyntaxError("Unsupported workflow syntax");
			if (node.type === "Identifier" && typeof node.name === "string" && (node.name.startsWith("__wRg$") || node.name.startsWith("__workflow$"))) throw new SyntaxError("Reserved workflow identifier");
			for (const [key, child] of Object.entries(node)) if (key !== "start" && key !== "end") visit(child);
		}
		visit(ast);
		new Script(source, { filename: "workflow.js" });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `SyntaxError: ${error instanceof Error ? error.message : String(error)}` };
	}
}
