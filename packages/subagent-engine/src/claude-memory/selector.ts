// Claude Code's memory selector (2.1.329 `selectRelevantMemories`): the same manifest, prompt, JSON schema, Sonnet model
// chain and preview limits. The request runs through headless Claude Code, which owns the Anthropic login.
import { spawn } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export type ClaudeMemoryFile = { filename: string; filePath: string; mtimeMs: number; description?: string; type?: string };

const MAX_CANDIDATES = 200;
const HEADER_LINES = 30;
const HEADER_BYTES = 65_536;
const PREVIEW_LINES = 200;
const PREVIEW_BYTES = 4_096;
const MAX_SELECTED = 5;
/** Claude Code allows two more Sonnet models after the first refuses (`txi`). */
const FALLBACK_MODELS = 2;
const TYPES = new Set(["user", "feedback", "project", "reference"]);

export const SELECTOR_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.
Reply with only a JSON object of the form {"selected_memories": ["<filename>", ...]}.
`;
export const SELECTOR_SCHEMA = { type: "object", properties: { selected_memories: { type: "array", items: { type: "string" } } }, required: ["selected_memories"], additionalProperties: false };

function unquote(value: string): string {
	const text = value.trim();
	return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
}

/** Frontmatter from the first 30 lines: top-level description, and metadata.type over a legacy top-level type. */
export function memoryHeader(text: string): { description?: string; type?: string } {
	const lines = text.split(/\r?\n/).slice(0, HEADER_LINES);
	if (lines[0]?.trim() !== "---") return {};
	const result: { description?: string; type?: string } = {};
	let inMetadata = false;
	let legacyType: string | undefined;
	const body = lines.slice(1);
	const end = body.findIndex((line) => line.trim() === "---");
	const front = end < 0 ? body : body.slice(0, end);
	for (let index = 0; index < front.length; index++) {
		const line = front[index];
		const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (top) {
			inMetadata = top[1] === "metadata" && !top[2].trim();
			if (top[1] === "description" && top[2].trim()) {
				const block = /^([>|])[+-]?\s*$/.exec(top[2].trim());
				if (!block) result.description = unquote(top[2]);
				else {
					// A YAML block scalar: `>` folds its indented lines into one, `|` keeps the line breaks.
					const lines: string[] = [];
					while (index + 1 < front.length && (/^\s+\S/.test(front[index + 1]) || !front[index + 1].trim())) lines.push(front[++index].trim());
					const text = (block[1] === ">" ? lines.join(" ").replace(/\s+/g, " ") : lines.join("\n")).trim();
					if (text) result.description = text;
				}
			}
			if (top[1] === "type") legacyType = unquote(top[2]);
			continue;
		}
		const nested = /^\s+type:\s*(.*)$/.exec(line);
		if (inMetadata && nested) result.type = unquote(nested[1]);
	}
	if (result.type === undefined && legacyType !== undefined) result.type = legacyType;
	if (result.type !== undefined && !TYPES.has(result.type)) delete result.type;
	return result;
}

async function readPrefix(path: string, bytes: number): Promise<{ text: string; complete: boolean } | undefined> {
	let file;
	try { file = await open(path, "r"); } catch { return undefined; }
	try {
		const stat = await file.stat();
		if (!stat.isFile()) return undefined;
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await file.read(buffer, 0, bytes, 0);
		// A streaming decode drops a UTF-8 sequence split at the byte limit instead of emitting a replacement character.
		return { text: new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead), { stream: true }), complete: stat.size <= bytes };
	} finally { await file.close(); }
}

/** Topic Markdown files below the memory root, newest first, at most 200; the root MEMORY.md index is not a candidate. */
export async function scanClaudeMemories(directory: string, signal?: AbortSignal): Promise<ClaudeMemoryFile[]> {
	const found: ClaudeMemoryFile[] = [];
	let visited = 0;
	const walk = async (folder: string, depth: number): Promise<void> => {
		if (depth > 8) return;
		let entries;
		try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) {
			if (depth === 0 && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return;
		}
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			// Only folders and Markdown files count toward the traversal budget; other files never crowd notes out.
			if (!entry.isDirectory() && !(entry.isFile() && entry.name.endsWith(".md"))) continue;
			if (++visited > 50_000) continue;
			// Claude Code shows `team/<mount>/` notes only while that team store is mounted; Pi reads no team stores.
			if (depth === 0 && entry.name.toLowerCase() === "team" && entry.isDirectory()) continue;
			const path = join(folder, entry.name);
			if (entry.isDirectory()) await walk(path, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".md") && !(depth === 0 && entry.name === "MEMORY.md")) {
				const stat = await lstat(path).catch(() => undefined);
				if (stat?.isFile()) found.push({ filename: relative(directory, path).split(sep).join("/"), filePath: path, mtimeMs: stat.mtimeMs });
			}
		}
	};
	await walk(directory, 0);
	const newest = found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_CANDIDATES);
	for (const file of newest) {
		signal?.throwIfAborted();
		const prefix = await readPrefix(file.filePath, HEADER_BYTES);
		if (prefix) Object.assign(file, memoryHeader(prefix.text));
	}
	return newest;
}

/** Claude Code's manifest line: `- [type] filename (ISO mtime): description`. */
export function memoryManifest(files: ClaudeMemoryFile[]): string {
	return files.map((file) => {
		const line = `- ${file.type ? `[${file.type}] ` : ""}${file.filename} (${new Date(file.mtimeMs).toISOString()})`;
		return file.description ? `${line}: ${file.description}` : line;
	}).join("\n");
}

export type SonnetCatalogEntry = { id: string; price?: number };
const sonnetVersion = (id: string): number[] | undefined => {
	const match = /^claude-sonnet-(\d+)(?:-(\d+))?$/.exec(id);
	return match ? [Number(match[1]), Number(match[2] ?? 0)] : undefined;
};
const base = (model: string) => model.replace(/\[(?:1|2)m\]/gi, "").toLowerCase();

/**
 * Claude Code's selector model order (`nxi`): the default Sonnet first, then, unless CLAUDE_CODE_NO_MODEL_FALLBACK is
 * set or the first model's price is unknown, up to two newer-to-older Sonnet models priced no higher (1M in + 1M out).
 */
export function selectorModels(primary: string | undefined, catalog: SonnetCatalogEntry[], noFallback: boolean): string[] {
	const sonnets = catalog.filter((entry) => sonnetVersion(entry.id))
		.sort((a, b) => { const [x, y] = [sonnetVersion(a.id)!, sonnetVersion(b.id)!]; return y[0] - x[0] || y[1] - x[1]; });
	const first = primary ?? "sonnet";
	// The bare alias is what Claude Code resolves to its newest Sonnet; price it as that model. A dated snapshot is priced
	// from the full catalog, and counts as its undated model when excluding the first model from the fallbacks.
	const resolved = base(first) === "sonnet" ? sonnets[0]?.id : base(first);
	const price = catalog.find((entry) => entry.id === resolved)?.price;
	const undated = (id: string | undefined) => id?.replace(/-\d{8}$/, "");
	const models = [first];
	if (noFallback || price === undefined) return models;
	for (const entry of sonnets) {
		if (models.length > FALLBACK_MODELS) break;
		if (entry.id !== undated(resolved) && entry.price !== undefined && entry.price <= price) models.push(entry.id);
	}
	return models;
}

/** Hooks, auto memory and CLAUDE.md discovery are off: the request carries only the selector prompt and manifest. */
export const SELECTOR_SETTINGS = { disableAllHooks: true, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } };

export type SelectorRequest = { model: string; system: string; prompt: string; schema: object; signal: AbortSignal };
export type SelectorReply = { ok: true; value: unknown; model?: string; costUsd?: number } | { ok: false; refused: boolean; message: string };
export type SelectorRunner = (request: SelectorRequest) => Promise<SelectorReply>;

/** One stateless structured-output request through headless Claude Code: user settings for auth, but no tools, hooks, MCP, or memory. */
export function claudeCodeRunner(options: { command?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): SelectorRunner {
	return (request) => new Promise((done) => {
		const child = spawn(options.command ?? "claude", [
			// User settings carry the login, provider and gateway (env, apiKeyHelper); hooks and MCP are switched off.
			"-p", "--model", request.model, "--system-prompt", request.system, "--tools", "", "--setting-sources", "user",
			// Flag settings outrank user settings `env`, so memory and CLAUDE.md files stay off even if the user forces them on.
			"--settings", JSON.stringify(SELECTOR_SETTINGS), "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(request.schema),
		], { cwd: options.cwd ?? tmpdir(), env: { ...(options.env ?? process.env), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, stdio: ["pipe", "pipe", "pipe"], signal: request.signal });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => done({ ok: false, refused: false, message: String(error) }));
		child.on("close", (code) => {
			let output: Record<string, any> | undefined;
			try { output = JSON.parse(stdout); } catch {}
			if (!output) { done({ ok: false, refused: false, message: (stderr || stdout || `claude exited with ${code}`).trim().slice(0, 400) }); return; }
			const message = String(output.result ?? output.error ?? stderr ?? "").slice(0, 400);
			if (output.is_error || code !== 0) {
				// Claude Code falls back only when the API refuses the model: a 404 not_found_error or 403 permission_error whose
				// message names `model:` (`vst`, `h8e`). Other 403s, such as a gateway's authentication error, do not fall back.
				const status = Number(output.api_error_status);
				// Claude Code's CLI rewrites those into its model diagnostic; both forms count, other 403s do not.
				const kind = status === 404 ? /not_found_error/ : status === 403 ? /permission_error/ : undefined;
				const raw = Boolean(kind?.test(message)) && message.includes("model:");
				const rewritten = /There's an issue with the selected model|ask your admin to enable this model/.test(message);
				done({ ok: false, refused: raw || rewritten, message });
				return;
			}
			const model = Object.keys(output.modelUsage ?? {})[0];
			const value = output.structured_output ?? (() => { try { return JSON.parse(String(output.result).replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return undefined; } })();
			done({ ok: true, value, model, costUsd: typeof output.total_cost_usd === "number" ? output.total_cost_usd : undefined });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(request.prompt);
	});
}

export type Selection = { filenames: string[]; model?: string; costUsd?: number; error?: string };

/** Ask the selector chain; unknown filenames are dropped and a leading `[type] ` marker is stripped, as Claude Code does. */
export async function selectMemories(input: { query: string; files: ClaudeMemoryFile[]; models: string[]; run: SelectorRunner; signal: AbortSignal }): Promise<Selection> {
	const known = new Set(input.files.map((file) => file.filename));
	const prompt = `Available memories:\n${memoryManifest(input.files)}\n\nSelect memories relevant to:\n\n${input.query}`;
	let last = "No selector model was available.";
	for (const model of input.models) {
		input.signal.throwIfAborted();
		const reply = await input.run({ model, system: SELECTOR_SYSTEM_PROMPT, prompt, schema: SELECTOR_SCHEMA, signal: input.signal });
		if (!reply.ok) {
			last = reply.message;
			if (reply.refused) continue;
			return { filenames: [], error: reply.message };
		}
		const selected = (reply.value as { selected_memories?: unknown } | undefined)?.selected_memories;
		if (!Array.isArray(selected)) return { filenames: [], model: reply.model ?? model, costUsd: reply.costUsd, error: "The selector returned no selected_memories list." };
		const filenames = [...new Set(selected.filter((name): name is string => typeof name === "string")
			.map((name) => known.has(name) ? name : name.replace(/^\[(?:user|feedback|project|reference|account)\]\s+/, ""))
			.filter((name) => known.has(name)))].slice(0, MAX_SELECTED);
		return { filenames, model: reply.model ?? model, costUsd: reply.costUsd };
	}
	return { filenames: [], error: `Every selector model was refused: ${last}` };
}

/** At most 200 lines and 4096 bytes of a note, flagged when cut. */
export async function memoryPreview(path: string): Promise<{ content: string; truncated: boolean } | undefined> {
	const prefix = await readPrefix(path, PREVIEW_BYTES + 1);
	if (!prefix) return undefined;
	const bytes = Buffer.from(prefix.text);
	const text = new TextDecoder("utf-8").decode(bytes.subarray(0, PREVIEW_BYTES), { stream: true });
	const lines = text.split("\n");
	const content = lines.slice(0, PREVIEW_LINES).join("\n");
	return { content, truncated: !prefix.complete || bytes.length > PREVIEW_BYTES || lines.length > PREVIEW_LINES };
}

const DAY_MS = 86_400_000;
const INTRO = "Retrieved for possible relevance — use only if it actually applies to what the user asked.";

/** The model-facing text of Claude Code's `relevant_memories` attachment. */
export function recalledMemoryText(memories: Array<{ path: string; mtimeMs: number; content: string; truncated: boolean }>, now = Date.now()): string {
	return memories.map((memory, index) => {
		const days = Math.max(0, Math.floor((now - memory.mtimeMs) / DAY_MS));
		const age = days > 1 ? `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n` : "";
		const notice = memory.truncated ? `\n[Truncated preview. Read ${memory.path} for the full memory if it is relevant.]` : "";
		return `${index === 0 ? `${INTRO}\n` : ""}<system-reminder>\n${age}Memory: ${memory.path.replace(/[\t\n\r\u2028\u2029]/g, "")}:\n${memory.content}${notice}\n</system-reminder>`;
	}).join("\n");
}
