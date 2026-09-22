export interface ParsedAgentFile {
	body: string;
	tools?: string[];
	maxTurns?: number;
	thinking?: string;
	model?: string;
	isolated: boolean;
}

function scalar(front: string, key: string): string | undefined {
	const match = front.match(new RegExp(`^${key}:[ \t]*(.+)$`, "m"));
	if (!match) return undefined;
	return match[1].trim().replace(/^["']|["']$/g, "");
}

function toolList(front: string): string[] | undefined {
	if (!/^tools:/m.test(front)) return undefined;
	const inline = scalar(front, "tools");
	if (inline && !inline.startsWith("[")) {
		return inline.split(/[,\s]+/).map((tool) => tool.trim()).filter(Boolean);
	}
	const lines = front.split("\n");
	const start = lines.findIndex((line) => /^tools:\s*$/.test(line) || /^tools:\s*\[/.test(line));
	if (start < 0) return [];
	const bracket = lines[start].match(/\[(.*)\]/);
	if (bracket) return bracket[1].split(",").map((tool) => tool.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
	const tools: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const item = line.match(/^\s*-\s*(.+)$/);
		if (!item) break;
		tools.push(item[1].trim().replace(/^["']|["']$/g, ""));
	}
	return tools;
}

/** Read the agent markdown this repo can honor without a YAML parser. */
export function parseAgentFile(text: string): ParsedAgentFile {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	const front = match?.[1] ?? "";
	const body = (match ? match[2] : text).trim();
	const turns = scalar(front, "max_turns");
	const maxTurns = turns && Number(turns) >= 1 ? Number(turns) : undefined;
	return {
		body,
		tools: toolList(front),
		maxTurns,
		thinking: scalar(front, "thinking"),
		model: scalar(front, "model"),
		isolated: scalar(front, "extensions") === "false",
	};
}
