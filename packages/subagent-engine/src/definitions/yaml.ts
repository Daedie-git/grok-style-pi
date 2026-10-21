// A deliberately small data-only YAML reader for agent frontmatter, not a YAML runtime.
// Tags, anchors and aliases are not evaluated. Unsupported input is diagnosed by the caller.

function splitTop(text: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0, depth = 0, quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\" && quote === '"') { i++; continue; }
			if (ch === quote) {
				if (quote === "'" && text[i + 1] === "'") { i++; continue; }
				quote = "";
			}
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if ("[{(".includes(ch)) depth++;
		else if ("]})".includes(ch)) depth--;
		else if (ch === separator && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
	}
	if (quote || depth !== 0) throw new Error("Unbalanced quotes or brackets");
	parts.push(text.slice(start).trim());
	return parts;
}

export function commaList(text: string): string[] {
	return splitTop(text, ",").filter(Boolean).map((part) => {
		const value = scalar(part);
		return typeof value === "string" ? value : part;
	});
}

export function isMapping(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pair(text: string): [string, string] {
	// A mapping separator must be followed by whitespace, end-of-line or an inline value.
	const match = /^("[^"\n]+"|'[^'\n]+'|[^:\n]+):(?:\s+|$)([\s\S]*)$/.exec(text);
	if (!match) throw new Error(`Expected a mapping entry: ${text}`);
	const key = scalar(match[1].trim());
	if (typeof key !== "string") throw new Error("Mapping keys must be strings");
	return [key, match[2].trim()];
}

function scalar(text: string): unknown {
	text = text.trim();
	if (text.startsWith('"')) return JSON.parse(text);
	if (text.startsWith("'")) {
		if (!text.endsWith("'")) throw new Error("Unterminated quoted string");
		return text.slice(1, -1).replace(/''/g, "'");
	}
	if (text.startsWith("[") || text.startsWith("{")) {
		try { return JSON.parse(text); } catch { /* Also accept YAML's unquoted inline values. */ }
		const closing = text.startsWith("[") ? "]" : "}";
		if (!text.endsWith(closing)) throw new Error("Unterminated inline collection");
		const body = text.slice(1, -1).trim();
		if (closing === "]") return body ? splitTop(body, ",").map(scalar) : [];
		const result: Record<string, unknown> = Object.create(null);
		for (const item of body ? splitTop(body, ",") : []) {
			const [key, value] = pair(item);
			result[key] = scalar(value);
		}
		return result;
	}
	// Strip comments only outside quoted/inline values; a hash within a word is literal.
	text = text.replace(/\s+#.*$/, "").trim();
	if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
	if (/^(null|~)$/i.test(text)) return null;
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	if (/^[&*!]/.test(text) && text !== "*") throw new Error("YAML tags, anchors and aliases are unsupported");
	return text;
}

export function parseYaml(text: string): unknown {
	try { return JSON.parse(text); } catch { /* Frontmatter is usually a block mapping. */ }
	const lines = text.split(/\r?\n/).map((raw) => {
		if (/^\s*\t/.test(raw)) throw new Error("Use spaces for frontmatter indentation");
		return { raw, indent: raw.length - raw.trimStart().length, text: raw.trim() };
	});
	let index = 0;
	const skip = () => { while (index < lines.length && (!lines[index].text || lines[index].text.startsWith("#"))) index++; };
	function block(indent: number): unknown {
		skip();
		const sequence = /^-(?:\s|$)/.test(lines[index]?.text ?? "");
		const result: unknown[] | Record<string, unknown> = sequence ? [] : Object.create(null);
		while (index < lines.length) {
			skip();
			if (index >= lines.length || lines[index].indent < indent) break;
			const line = lines[index];
			if (line.indent !== indent) throw new Error(`Unexpected indentation: ${line.text}`);
			index++;
			if (sequence) {
				if (!/^-(?:\s|$)/.test(line.text)) throw new Error("Mixed sequence and mapping");
				const rest = line.text.slice(1).trim();
				let value: unknown;
				if (!rest) { skip(); value = index < lines.length && lines[index].indent > indent ? block(lines[index].indent) : null; }
				else if (!rest.startsWith("{") && /^[^:]+:(?:\s|$)/.test(rest)) {
					// Turn '- key: value' into an ordinary mapping at its visual indentation.
					index--;
					lines[index] = { raw: " ".repeat(indent + 2) + rest, indent: indent + 2, text: rest };
					value = block(indent + 2);
				} else value = scalar(rest);
				(result as unknown[]).push(value);
			} else {
				const [key, rest] = pair(line.text);
				let value: unknown;
				if (/^[|>][-+]?$/.test(rest)) {
					const content: string[] = [];
					let contentIndent: number | undefined;
					while (index < lines.length && (!lines[index].text || lines[index].indent > indent)) {
						const next = lines[index++];
						if (next.text && contentIndent === undefined) contentIndent = next.indent;
						content.push(next.raw.slice(contentIndent ?? 0));
					}
					value = content.join(rest.startsWith(">") ? " " : "\n").trimEnd();
				} else if (rest) value = scalar(rest);
				else { skip(); value = index < lines.length && lines[index].indent > indent ? block(lines[index].indent) : null; }
				(result as Record<string, unknown>)[key] = value;
			}
		}
		return result;
	}
	skip();
	return index < lines.length ? block(lines[index].indent) : Object.create(null);
}
