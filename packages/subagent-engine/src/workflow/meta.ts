import { parse, type Node } from "acorn";

export interface WorkflowMeta {
	name: string;
	description: string;
	title?: string;
	whenToUse?: string;
	phases: { title: string; detail?: string; model?: string }[];
}
// Acorn's generic traversal shape, not executable metadata.
type Ast = Node & Record<string, unknown>;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
function literal(node: Ast, depth = 0): unknown {
	if (depth > 100) throw new Error("Metadata nesting limit exceeded");
	switch (node.type) {
		case "Literal":
			if (node.regex || typeof node.value === "bigint") throw new Error("Unsupported metadata literal");
			return node.value;
		case "TemplateLiteral": {
			if ((node.expressions as unknown[]).length) throw new Error("Metadata templates cannot interpolate");
			return ((node.quasis as Ast[])[0].value as { cooked: string }).cooked;
		}
		case "UnaryExpression": {
			const argument = node.argument as Ast;
			if (node.operator !== "-" || argument.type !== "Literal" || typeof argument.value !== "number") throw new Error("Unsupported metadata expression");
			return -argument.value;
		}
		case "ArrayExpression": return (node.elements as (Ast | null)[]).map(element => {
			if (!element) throw new Error("Metadata arrays cannot have holes");
			return literal(element, depth + 1);
		});
		case "ObjectExpression": {
			const value: Record<string, unknown> = Object.create(null);
			for (const property of node.properties as Ast[]) {
				if (property.type !== "Property" || property.computed || property.method || property.shorthand || property.kind !== "init") throw new Error("Metadata requires plain literal properties");
				const keyNode = property.key as Ast;
				const key = keyNode.type === "Identifier" ? String(keyNode.name) : String(keyNode.value);
				if (unsafeKeys.has(key)) throw new Error(`Unsafe metadata key: ${key}`);
				value[key] = literal(property.value as Ast, depth + 1);
			}
			return value;
		}
		default: throw new Error(`Unsupported metadata expression: ${node.type}`);
	}
}

export function parseWorkflowSource(source: string): { meta?: WorkflowMeta; body: string; error?: string } {
	try {
		if (typeof source !== "string" || source.length > 524_288) throw new Error("Workflow source exceeds 524288 characters");
		const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
		const first = tree.body[0] as unknown as Ast | undefined;
		const declaration = first?.declaration as Ast | undefined;
		if (first?.type !== "ExportNamedDeclaration" || declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") throw new Error("First statement must be export const meta = {...}");
		const declarations = declaration.declarations as Ast[];
		if (declarations.length !== 1 || (declarations[0].id as Ast).type !== "Identifier" || (declarations[0].id as Ast).name !== "meta" || (declarations[0].init as Ast)?.type !== "ObjectExpression") throw new Error("First statement must declare only literal meta");
		const data = literal(declarations[0].init as Ast) as Record<string, unknown>;
		if (typeof data.name !== "string" || !data.name.trim() || typeof data.description !== "string" || !data.description.trim()) throw new Error("Metadata requires nonempty name and description");
		const meta: WorkflowMeta = { name: data.name, description: data.description, phases: [] };
		if (typeof data.title === "string" && data.title.trim()) meta.title = data.title;
		if (typeof data.whenToUse === "string") meta.whenToUse = data.whenToUse;
		if (Array.isArray(data.phases)) for (const phase of data.phases) {
			if (!phase || typeof phase !== "object" || typeof phase.title !== "string") continue;
			meta.phases.push({ title: phase.title, ...(typeof phase.detail === "string" ? { detail: phase.detail } : {}), ...(typeof phase.model === "string" ? { model: phase.model } : {}) });
		}
		return { meta, body: source.slice(first.end) };
	} catch (error) {
		return { body: "", error: error instanceof Error ? error.message : String(error) };
	}
}
