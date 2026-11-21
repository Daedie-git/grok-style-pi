import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claudeConfig, claudeMemoryDirectory as directoryFor, isClaudeMemoryPath, managedSettingsDir, projectKey, protectedRoots, toolPath } from "../src/claude-memory/location.ts";
import { claudeMemoryGuard, claudeMemoryWriteBlock as writeBlock, installClaudeMemory, RECALL_MESSAGE } from "../src/claude-memory/recall.ts";
import {
	claudeCodeRunner, memoryHeader, memoryManifest, memoryPreview, recalledMemoryText, scanClaudeMemories, selectMemories, selectorModels,
	SELECTOR_SCHEMA, SELECTOR_SETTINGS, SELECTOR_SYSTEM_PROMPT, type SelectorReply, type SelectorRequest,
} from "../src/claude-memory/selector.ts";
import { createHarness, until } from "./fixtures/harness.ts";

// Views of one configuration snapshot, read the way recall and the guard read it.
const claudeMemoryDirectory = (cwd: string, env: NodeJS.ProcessEnv, home: string) => directoryFor(cwd, claudeConfig(env, home));
const claudeMemoryDisabled = (env: NodeJS.ProcessEnv, home: string) => claudeConfig(env, home).disabled;
const configuredSonnet = (env: NodeJS.ProcessEnv, home: string) => claudeConfig(env, home).sonnet;
const noModelFallback = (env: NodeJS.ProcessEnv, home: string) => claudeConfig(env, home).noModelFallback;
const claudeMemoryWriteBlock = (tool: string, input: unknown, cwd: string, env: NodeJS.ProcessEnv, home: string, folder?: string) =>
	writeBlock(tool, input, cwd, protectedRoots(claudeConfig(env, home), [folder]));

function temp(t: { after(fn: () => void): void }): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-memory-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function note(path: string, frontmatter: string, body = "Body.", mtime?: number) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `---\n${frontmatter}\n---\n${body}\n`);
	if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
}

const catalog = [
	{ id: "claude-sonnet-4-5", price: 18 }, { id: "claude-sonnet-4-5-20250929", price: 18 }, { id: "claude-sonnet-4-6", price: 18 },
	{ id: "claude-sonnet-5", price: 12 }, { id: "claude-sonnet-5-5", price: 12 }, { id: "claude-opus-5-5", price: 24 },
];

test("project keys match Claude Code: non-alphanumerics become dashes, long keys get a base-36 hash", () => {
	assert.equal(projectKey("/home/aim/git/grok-style-pi"), "-home-aim-git-grok-style-pi");
	const long = `/${"a".repeat(250)}`;
	const key = projectKey(long);
	assert.equal(key.slice(0, 200), `-${"a".repeat(199)}`);
	let hash = 0;
	for (const char of long) hash = (hash << 5) - hash + char.charCodeAt(0) | 0;
	assert.equal(key, `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`);
});

test("the memory folder follows Claude Code: override, autoMemoryDirectory, then the shared Git root", async (t) => {
	const root = temp(t);
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(join(repo, "sub"), { recursive: true });
	mkdirSync(home);
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
	execFileSync("git", ["-C", repo, "worktree", "add", "-q", join(root, "wt")]);
	const expected = join(home, ".claude", "projects", projectKey(repo), "memory");
	assert.equal(await claudeMemoryDirectory(join(repo, "sub"), {}, home), expected);
	assert.equal(await claudeMemoryDirectory(join(root, "wt"), {}, home), expected, "linked worktrees share the main checkout's memory");
	assert.equal(await claudeMemoryDirectory(repo, { CLAUDE_CONFIG_DIR: join(root, "config") }, home), join(root, "config", "projects", projectKey(repo), "memory"));
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/notes", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" } }));
	assert.equal(await claudeMemoryDirectory(repo, {}, home), join(home, "notes"));
	assert.equal(await claudeMemoryDirectory(repo, { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "/cowork/memory" }, home), "/cowork/memory");
	assert.equal(configuredSonnet({}, home), "claude-sonnet-5");
	assert.equal(configuredSonnet({ ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6" }, home), "claude-sonnet-5", "settings env applies over the process, as in Claude Code");
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_NO_MODEL_FALLBACK: "1" } }));
	assert.equal(claudeMemoryDisabled({}, home), true, "a settings env opt-out counts");
	assert.equal(noModelFallback({}, home), true);
	writeFileSync(join(home, ".claude", "settings.json"), "{}");
	assert.equal(managedSettingsDir("linux"), "/etc/claude-code");
	assert.equal(managedSettingsDir("darwin"), "/Library/Application Support/ClaudeCode");
	assert.equal(managedSettingsDir("win32"), "C:\\Program Files\\ClaudeCode");
	// Claude Code's validation rejects roots, relative paths and `~/` escapes, and falls through to the next source.
	for (const bad of ["/", "relative/dir", "~/../etc"]) {
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: bad }));
		assert.equal(await claudeMemoryDirectory(repo, { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "/" }, home), expected, bad);
	}
	assert.equal(await claudeMemoryDirectory(repo, { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "~/cowork" }, home), expected, "the override takes no ~");
	assert.equal(claudeMemoryDisabled({}, home), false);
	assert.equal(claudeMemoryDisabled({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, home), true);
	// Claude Code's Ih/Mh: simple mode and a store-less remote session disable memory; false-like forces it on.
	assert.equal(claudeMemoryDisabled({ CLAUDE_CODE_SIMPLE: "1" }, home), true);
	assert.equal(claudeMemoryDisabled({ CLAUDE_CODE_REMOTE: "true" }, home), true);
	assert.equal(claudeMemoryDisabled({ CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_MEMORY_DIR: "/r" }, home), false);
	assert.equal(claudeMemoryDisabled({ CLAUDE_CODE_SIMPLE: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" }, home), false);
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
	assert.equal(claudeMemoryDisabled({}, home), true);
});

test("frontmatter reads description and metadata.type, preferring nested type over a legacy top-level type", () => {
	assert.deepEqual(memoryHeader("---\nname: x\ndescription: Terse replies\nmetadata:\n  type: feedback\n---\nbody"), { description: "Terse replies", type: "feedback" });
	assert.deepEqual(memoryHeader("---\ndescription: \"Quoted\"\ntype: project\n---"), { description: "Quoted", type: "project" });
	assert.deepEqual(memoryHeader("---\ntype: project\nmetadata:\n  type: user\n---"), { type: "user" });
	assert.deepEqual(memoryHeader("---\ntype: bogus\n---"), {});
	assert.deepEqual(memoryHeader("no frontmatter"), {});
	assert.deepEqual(memoryHeader("---\ndescription: >-\n  Durable project\n  decisions\nmetadata:\n  type: project\n---"), { description: "Durable project decisions", type: "project" });
	assert.deepEqual(memoryHeader("---\ndescription: |\n  line one\n  line two\n---"), { description: "line one\nline two" });
});

test("the scan lists topic files newest first, without the root index or hidden files, and formats Claude's manifest", async (t) => {
	const dir = temp(t);
	note(join(dir, "old.md"), "description: Old note\nmetadata:\n  type: project", "x", 1_000_000);
	note(join(dir, "nested", "new.md"), "description: New note", "x", 3_000_000);
	note(join(dir, "MEMORY.md"), "description: index", "x", 9_000_000);
	note(join(dir, ".hidden", "secret.md"), "description: hidden", "x", 9_000_000);
	note(join(dir, "nested", "MEMORY.md"), "description: Nested index is a topic", "x", 2_000_000);
	note(join(dir, "team", "revoked", "fact.md"), "description: unmounted team note", "x", 9_000_000);
	const files = await scanClaudeMemories(dir);
	assert.deepEqual(files.map((file) => file.filename), ["nested/new.md", "nested/MEMORY.md", "old.md"]);
	assert.equal(memoryManifest(files), [
		`- nested/new.md (${new Date(3_000_000).toISOString()}): New note`,
		`- nested/MEMORY.md (${new Date(2_000_000).toISOString()}): Nested index is a topic`,
		`- [project] old.md (${new Date(1_000_000).toISOString()}): Old note`,
	].join("\n"));
	assert.deepEqual(await scanClaudeMemories(join(dir, "absent")), []);
	for (let index = 0; index < 205; index++) note(join(dir, "many", `${index}.md`), "description: n", "x", 10_000_000 + index * 1000);
	for (let index = 0; index < 5_100; index++) writeFileSync(join(dir, `noise-${index}.txt`), "");
	const capped = await scanClaudeMemories(dir);
	assert.equal(capped.length, 200);
	assert.equal(capped[0].filename, "many/204.md");
});

test("selector models: default Sonnet, then up to two Sonnets priced no higher, unless fallback is off", () => {
	assert.deepEqual(selectorModels(undefined, catalog, false), ["sonnet", "claude-sonnet-5"]);
	assert.deepEqual(selectorModels("claude-sonnet-4-6", catalog, false), ["claude-sonnet-4-6", "claude-sonnet-5-5", "claude-sonnet-5"]);
	assert.deepEqual(selectorModels("claude-sonnet-4-6[1m]", catalog, false), ["claude-sonnet-4-6[1m]", "claude-sonnet-5-5", "claude-sonnet-5"]);
	assert.deepEqual(selectorModels(undefined, catalog, true), ["sonnet"]);
	assert.deepEqual(selectorModels("my-proxy-model", catalog, false), ["my-proxy-model"], "an unpriced first model gets no fallback");
	assert.deepEqual(selectorModels(undefined, [], false), ["sonnet"]);
	assert.deepEqual(selectorModels("claude-sonnet-4-5-20250929", catalog, false), ["claude-sonnet-4-5-20250929", "claude-sonnet-5-5", "claude-sonnet-5"], "a dated first model is priced from the catalog");
});

test("selection falls back only on model refusals, strips type markers, drops unknown names and keeps five", async () => {
	const files = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map((filename) => ({ filename, filePath: `/m/${filename}`, mtimeMs: 0 }));
	const requests: SelectorRequest[] = [];
	const replies: SelectorReply[] = [
		{ ok: false, refused: true, message: "not_found_error model: x" },
		{ ok: true, value: { selected_memories: ["[feedback] a.md", "nope.md", "b.md", "b.md", "c.md", "d.md", "e.md", "f.md", 7] }, model: "claude-sonnet-5", costUsd: 0.01 },
	];
	const run = async (request: SelectorRequest) => { requests.push(request); return replies.shift()!; };
	const selection = await selectMemories({ query: "how do I format?", files, models: ["sonnet", "claude-sonnet-5"], run, signal: new AbortController().signal });
	assert.deepEqual(selection, { filenames: ["a.md", "b.md", "c.md", "d.md", "e.md"], model: "claude-sonnet-5", costUsd: 0.01 });
	assert.deepEqual(requests.map((request) => request.model), ["sonnet", "claude-sonnet-5"]);
	assert.equal(requests[0].system, SELECTOR_SYSTEM_PROMPT);
	assert.deepEqual(requests[0].schema, SELECTOR_SCHEMA);
	assert.match(requests[0].prompt, /^Available memories:\n- a\.md \(1970-01-01T00:00:00\.000Z\)\n[\s\S]*\n\nSelect memories relevant to:\n\nhow do I format\?$/);
	const failed = await selectMemories({ query: "q", files, models: ["sonnet", "claude-sonnet-5"], run: async () => ({ ok: false, refused: false, message: "overloaded" }), signal: new AbortController().signal });
	assert.deepEqual(failed, { filenames: [], error: "overloaded" });
	const refused = await selectMemories({ query: "q", files, models: ["sonnet"], run: async () => ({ ok: false, refused: true, message: "permission_error model" }), signal: new AbortController().signal });
	assert.match(refused.error!, /Every selector model was refused/);
});

test("the headless Claude Code runner sends a tool-free structured request and recognizes refusals", async (t) => {
	const dir = temp(t);
	const script = join(dir, "claude.cjs");
	writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), prompt, memoryOff: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, cwd: process.cwd() }));
const model = process.argv[process.argv.indexOf("--model") + 1];
if (model === "refused") { console.log(JSON.stringify({ is_error: true, api_error_status: 404, result: 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: refused"}}' })); process.exit(1); }
if (model === "cli-refused") { console.log(JSON.stringify({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model (cli-refused). It may not exist or you may not have access to it." })); process.exit(1); }
if (model === "gateway") { console.log(JSON.stringify({ is_error: true, api_error_status: 403, result: "Failed to authenticate. API Error: 403 Requests to this model gateway require a valid workspace." })); process.exit(1); }
console.log(JSON.stringify({ is_error: false, structured_output: { selected_memories: ["a.md"] }, modelUsage: { "claude-sonnet-5-5": {} }, total_cost_usd: 0.007 }));
`);
	chmodSync(script, 0o755);
	const run = claudeCodeRunner({ command: script, cwd: dir });
	const signal = new AbortController().signal;
	const reply = await run({ model: "sonnet", system: "SYSTEM", prompt: "PROMPT", schema: SELECTOR_SCHEMA, signal });
	assert.deepEqual(reply, { ok: true, value: { selected_memories: ["a.md"] }, model: "claude-sonnet-5-5", costUsd: 0.007 });
	const call = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(dir, "call.json"), "utf8")));
	assert.equal(call.prompt, "PROMPT");
	// Flag settings outrank user settings env: no memory index or CLAUDE.md can reach the selector.
	assert.deepEqual(SELECTOR_SETTINGS.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
	assert.equal(call.memoryOff, "1");
	assert.deepEqual(call.args, ["-p", "--model", "sonnet", "--system-prompt", "SYSTEM", "--tools", "", "--setting-sources", "user",
		"--settings", JSON.stringify(SELECTOR_SETTINGS), "--strict-mcp-config",
		"--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(SELECTOR_SCHEMA)]);
	assert.equal((await run({ model: "refused", system: "S", prompt: "P", schema: SELECTOR_SCHEMA, signal }) as { refused: boolean }).refused, true);
	assert.equal((await run({ model: "cli-refused", system: "S", prompt: "P", schema: SELECTOR_SCHEMA, signal }) as { refused: boolean }).refused, true, "the CLI's rewritten model diagnostic is a refusal");
	assert.equal((await run({ model: "gateway", system: "S", prompt: "P", schema: SELECTOR_SCHEMA, signal }) as { refused: boolean }).refused, false, "a 403 that refuses no model does not fall back");
	const missing = await claudeCodeRunner({ command: join(dir, "absent") })({ model: "sonnet", system: "S", prompt: "P", schema: SELECTOR_SCHEMA, signal });
	assert.equal(missing.ok, false);
});

test("previews keep 200 lines and 4096 bytes, and the recall text matches Claude Code's attachment", async (t) => {
	const dir = temp(t);
	writeFileSync(join(dir, "short.md"), "line");
	writeFileSync(join(dir, "lines.md"), Array.from({ length: 250 }, (_, index) => `l${index}`).join("\n"));
	writeFileSync(join(dir, "bytes.md"), "é".repeat(3000));
	assert.deepEqual(await memoryPreview(join(dir, "short.md")), { content: "line", truncated: false });
	const lines = await memoryPreview(join(dir, "lines.md"));
	assert.equal(lines!.content.split("\n").length, 200);
	assert.equal(lines!.truncated, true);
	const bytes = await memoryPreview(join(dir, "bytes.md"));
	assert.equal(Buffer.byteLength(bytes!.content), 4096);
	assert.equal(bytes!.truncated, true);
	const now = Date.UTC(2026, 10, 20);
	const text = recalledMemoryText([
		{ path: "/m/a.md", mtimeMs: now - 3 * 86_400_000, content: "A", truncated: false },
		{ path: "/m/b.md", mtimeMs: now, content: "B", truncated: true },
	], now);
	assert.equal(text, [
		"Retrieved for possible relevance — use only if it actually applies to what the user asked.",
		"<system-reminder>",
		"This memory is 3 days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.",
		"Memory: /m/a.md:",
		"A",
		"</system-reminder>",
		"<system-reminder>",
		"Memory: /m/b.md:",
		"B",
		"[Truncated preview. Read /m/b.md for the full memory if it is relevant.]",
		"</system-reminder>",
	].join("\n"));
});

test("Pi tools may read Claude memory but never write it", () => {
	const env = {};
	const home = "/home/person";
	const memory = "/home/person/.claude/projects/-repo/memory/topic.md";
	assert.equal(claudeMemoryWriteBlock("read", { path: memory }, "/repo", env, home), undefined);
	assert.match(claudeMemoryWriteBlock("write", { path: memory }, "/repo", env, home)!, /read-only/);
	assert.match(claudeMemoryWriteBlock("edit", { path: "../home/person/.claude/projects/-repo/memory/x.md" }, "/repo", env, home)!, /read-only/);
	assert.match(claudeMemoryWriteBlock("write", { path: "/repo/.claude/agent-memory/reviewer/MEMORY.md" }, "/repo", env, home)!, /read-only/);
	assert.match(claudeMemoryWriteBlock("write", { path: "/custom/notes/a.md" }, "/repo", env, home, "/custom/notes")!, /read-only/);
	assert.match(claudeMemoryWriteBlock("bash", { command: "rm ~/.claude/projects/-repo/memory/a.md" }, "/repo", env, home)!, /Shell commands/);
	for (const path of ["~/.claude/projects/-repo/memory/a.md", "@~/.claude/projects/-repo/memory/a.md", "file:///home/person/.claude/projects/-repo/memory/a.md", "/home/person/.claude/projects/-repo/memory/a\u00a0b.md"]) {
		assert.match(claudeMemoryWriteBlock("write", { path }, "/repo", env, home) ?? "", /read-only/, path);
	}
	for (const command of ["cd ~/.claude/projects/-repo && echo hi > memory/x.md", 'D=~/.claude/projects; echo hi > "$D"/-x/memory/x.md', "cat $HOME/.claude/agent-memory/r/MEMORY.md"]) {
		assert.match(claudeMemoryWriteBlock("bash", { command }, "/repo", env, home) ?? "", /Shell commands/, command);
	}
	assert.equal(claudeMemoryWriteBlock("write", { path: "/repo/memory/a.md" }, "/repo", env, home), undefined);
	assert.equal(claudeMemoryWriteBlock("bash", { command: "ls ~/.claude/projects" }, "/repo", env, home), undefined);
	assert.equal(claudeMemoryWriteBlock("bash", { command: "git grep -n autoMemoryDirectory -- src" }, "/repo", env, home), undefined, "a source search names no memory folder");
	assert.equal(claudeMemoryWriteBlock("bash", { command: "rg agent-memory packages" }, "/repo", env, home), undefined);
	assert.match(claudeMemoryWriteBlock("bash", { command: "echo x > .claude/agent-memory/reviewer/MEMORY.md" }, "/repo", env, home) ?? "", /Shell commands/, "a relative path shape");
	assert.match(claudeMemoryWriteBlock("edit", { path: "/home/person/.claude/memory/personal/me.md" }, "/repo", env, home) ?? "", /read-only/, "account memory is Claude's");
	assert.equal(toolPath("/mnt/d/notes/a.md", "C:\\repo", "C:\\Users\\p", "win32").startsWith("D:"), true);
	assert.equal(isClaudeMemoryPath("/home/person/.claude/projects/-repo/sessions.jsonl", protectedRoots(claudeConfig({}, "/home/person"), [])), false);
});

test("children and the root share one guard that knows the configured folder and symlinked parents", async (t) => {
	const home = temp(t);
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/notes/claude-mem" }));
	mkdirSync(join(home, "notes", "claude-mem"), { recursive: true });
	const guard = claudeMemoryGuard({}, home);
	assert.match(await guard.check("write", { path: "~/notes/claude-mem/a.md" }, home) ?? "", /read-only/);
	assert.match(await guard.check("bash", { command: `echo x > ${join(home, "notes", "claude-mem", "a.md")}` }, home) ?? "", /Shell commands/);
	const { symlinkSync } = await import("node:fs");
	symlinkSync(join(home, "notes", "claude-mem"), join(home, "alias"));
	assert.match(await guard.check("write", { path: join(home, "alias", "new", "deep.md") }, home) ?? "", /read-only/, "a new file below a symlinked memory folder");
	assert.equal(await guard.check("write", { path: join(home, "notes", "other.md") }, home), undefined);
	// Shell commands spell home paths with ~ and $HOME.
	for (const command of ["echo hi >> ~/notes/claude-mem/a.md", 'echo hi >> "$HOME/notes/claude-mem/a.md"', "echo hi >> ${HOME}/notes/claude-mem/a.md"]) {
		assert.match(await guard.check("bash", { command }, home) ?? "", /Shell commands/, command);
	}
	// A working copy's own autoMemoryDirectory is never recalled from, but is protected.
	const repo = join(home, "repo");
	mkdirSync(join(repo, ".claude"), { recursive: true });
	writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ autoMemoryDirectory: "~/claude-notes/repo" }));
	assert.match(await claudeMemoryGuard({}, home).check("write", { path: "~/claude-notes/repo/x.md" }, repo) ?? "", /read-only/);
	// Settings edited while the session runs are honoured at once.
	const live = claudeMemoryGuard({}, home);
	assert.equal(await live.check("write", { path: "~/later/x.md" }, repo), undefined);
	writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/later" }));
	assert.match(await live.check("write", { path: "~/later/x.md" }, repo) ?? "", /read-only/);
	// A linked worktree's own settings count from any of its subdirectories.
	execFileSync("git", ["init", "-q", join(home, "main")]);
	execFileSync("git", ["-C", join(home, "main"), "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
	execFileSync("git", ["-C", join(home, "main"), "worktree", "add", "-q", join(home, "wt")]);
	mkdirSync(join(home, "wt", ".claude"));
	mkdirSync(join(home, "wt", "src"));
	writeFileSync(join(home, "wt", ".claude", "settings.local.json"), JSON.stringify({ autoMemoryDirectory: "~/wt-notes" }));
	assert.match(await claudeMemoryGuard({}, home).check("write", { path: "~/wt-notes/x.md" }, join(home, "wt", "src")) ?? "", /read-only/);
	// The configured folder is itself a symlink: both names are protected.
	const real = join(home, "storage");
	mkdirSync(real);
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/linked" }));
	symlinkSync(real, join(home, "linked"));
	const linked = claudeMemoryGuard({}, home);
	assert.match(await linked.check("write", { path: join(home, "linked", "a.md") }, home) ?? "", /read-only/);
	assert.match(await linked.check("write", { path: join(real, "a.md") }, home) ?? "", /read-only/);
	// Remote sessions keep project memory under CLAUDE_CODE_REMOTE_MEMORY_DIR.
	const remote = claudeMemoryGuard({ CLAUDE_CODE_REMOTE_MEMORY_DIR: "/remote" }, join(home, "nohome"));
	assert.match(await remote.check("write", { path: "/remote/projects/-x/memory/a.md" }, home) ?? "", /read-only/);
	assert.equal(await claudeMemoryDirectory("/", { CLAUDE_CODE_REMOTE_MEMORY_DIR: "/remote" }, join(home, "nohome")), "/remote/projects/-/memory");
});

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: any; options: any }> = [];
	const entries: any[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const emit = async (name: string, event: any, ctx: any) => { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; };
	return { pi, emit, sent, entries, statuses };
}

test("recall runs beside the main request, delivers once as hidden reference, and is discarded when the turn ends first", async (t) => {
	const root = temp(t);
	const home = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	// Its own repository, so the key never depends on where the temporary folder lives.
	execFileSync("git", ["init", "-q", cwd]);
	const directory = join(home, ".claude", "projects", projectKey(cwd), "memory");
	note(join(directory, "terse.md"), "description: Terse replies\nmetadata:\n  type: feedback", "Keep answers short.");
	note(join(directory, "db.md"), "description: Database layout\nmetadata:\n  type: project", "Postgres.");
	const pending: Array<{ request: SelectorRequest; resolve(reply: SelectorReply): void }> = [];
	const run = (request: SelectorRequest) => new Promise<SelectorReply>((resolve) => pending.push({ request, resolve }));
	const { pi, emit, sent, entries, statuses } = fakePi();
	installClaudeMemory(pi, { env: { CLAUDE_MEMORY_STORES: "1" }, home, run });
	const ctx = {
		cwd, ui: { setStatus: (_key: string, value?: string) => statuses.push(value) },
		sessionManager: { getBranch: () => entries },
		modelRegistry: { getAll: () => catalog.map(({ id, price }) => ({ provider: "anthropic", id, cost: { input: price / 6, output: price * 5 / 6 } })) },
	};
	const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
	await emit("session_start", {}, ctx);
	assert.equal(statuses.at(-1), "on");

	const started = Date.now();
	await emit("before_agent_start", { prompt: "How should replies be formatted?" }, ctx);
	assert.ok(Date.now() - started < 1_000, "submission does not wait for the selector");
	await until(() => pending.length === 1);
	assert.equal(pending[0].request.model, "sonnet");
	assert.match(pending[0].request.prompt, /\[feedback\] terse\.md/);
	pending[0].resolve({ ok: true, value: { selected_memories: ["terse.md"] }, model: "claude-sonnet-5-5" });
	await until(() => sent.length === 1);
	assert.equal(sent[0].message.customType, RECALL_MESSAGE);
	assert.equal(sent[0].message.display, false);
	assert.deepEqual(sent[0].options, { triggerTurn: false });
	assert.match(sent[0].message.content, /Memory: .*terse\.md:\n---[\s\S]*Keep answers short\./);
	const charged = entries.filter((entry) => entry.customType === "claude-memory-recall").at(-1).data.used;
	assert.equal(charged, sent[0].message.content.length, "the budget is charged for the delivered text exactly");

	// Surfaced notes are not offered again.
	await emit("before_agent_start", { prompt: "And databases?" }, ctx);
	await until(() => pending.length === 2);
	assert.doesNotMatch(pending[1].request.prompt, /terse\.md/);
	await emit("agent_settled", {}, ctx);
	pending[1].resolve({ ok: true, value: { selected_memories: ["db.md"] } });
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(sent.length, 1, "a selection that finishes after the turn is discarded");

	// A note the agent already read is not offered.
	await emit("tool_result", { toolName: "read", isError: false, input: { path: join(directory, "db.md") } }, ctx);
	await emit("before_agent_start", { prompt: "anything" }, ctx);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(pending.length, 2, "with every note surfaced or read, no selector request is made");

	// Turning Claude Code memory off mid-session stops the next recall without a reload.
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
	note(join(directory, "fresh.md"), "description: Fresh note", "new");
	await emit("before_agent_start", { prompt: "anything new" }, ctx);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(pending.length, 2, "no selector request after the opt-out");
	assert.equal(statuses.at(-1), "off");
	// An opt-out after recall starts, before the selector is asked, sends nothing.
	writeFileSync(join(home, ".claude", "settings.json"), "{}");
	await emit("before_agent_start", { prompt: "fresh topic, then opted out" }, ctx);
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(pending.length, 2, "neither the query nor the note list leaves after the opt-out");
	// Turning it back on also takes effect on the next prompt.
	writeFileSync(join(home, ".claude", "settings.json"), "{}");
	await emit("before_agent_start", { prompt: "fresh topic" }, ctx);
	await until(() => pending.length === 3);
	assert.match(pending[2].request.prompt, /fresh\.md/);
	await emit("agent_settled", {}, ctx);
	rmSync(join(directory, "fresh.md"));

	assert.deepEqual(await emit("tool_call", { toolName: "write", input: { path: join(directory, "new.md") } }, ctx), { block: true, reason: "Claude Code memory is read-only for Pi agents. Only Claude Code writes memory." });
	assert.equal(await emit("tool_call", { toolName: "write", input: { path: join(cwd, "file.md") } }, ctx), undefined);

	// State survives a reload of the same branch.
	await emit("session_start", {}, ctx);
	await emit("before_agent_start", { prompt: "formatting again" }, ctx);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(pending.length, 3);
});

for (const { name, gate, stores, disabled, mode } of [
	{ name: "default", mode: "index" },
	{ name: "cached gate off", gate: false, mode: "index" },
	{ name: "cached gate on", gate: true, mode: "selector" },
	{ name: "stores overrides cached gate off", gate: false, stores: true, mode: "selector" },
	{ name: "disabled with default configuration", disabled: true, mode: "off" },
	{ name: "disabled with both selector switches on", gate: true, stores: true, disabled: true, mode: "off" },
]) {
	test(`real Pi model requests use ${mode} mode (${name})`, async (t) => {
		const home = temp(t);
		const directory = join(home, "notes");
		const indexMarker = "INDEX-ONLY-9f188";
		note(join(directory, "topic.md"), "description: Useful topic", "TOPIC-BODY-33cf5");
		writeFileSync(join(directory, "MEMORY.md"), `${indexMarker}\n- [Topic](topic.md)`);
		if (gate !== undefined) writeFileSync(join(home, ".claude.json"), JSON.stringify({ cachedGrowthBookFeatures: { tengu_moth_copse: gate } }));
		const selector: SelectorRequest[] = [];
		const requests: Array<{ messages: unknown[]; system?: string }> = [];
		let release!: () => void;
		const first = new Promise<void>(resolve => { release = resolve; });
		const h = await createHarness({
			claudeMemory: {
				home, env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: directory, ...(stores && { CLAUDE_MEMORY_STORES: "1" }), ...(disabled && { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }) },
				run: async request => { selector.push(request); return { ok: true, value: { selected_memories: [] } }; },
			},
			parent: ({ index, messages, system }) => {
				requests.push({ messages, system });
				return index === 0 ? { wait: first, then: { tools: [{ name: "read", args: { path: "ordinary.txt" } }] } } : { text: "OK" };
			},
			child: () => () => ({ text: "unused" }),
		});
		t.after(() => h.close());
		writeFileSync(join(h.root, "ordinary.txt"), "ordinary tool result");
		const turn = h.parent.prompt("Find the topic");
		try {
			await until(() => requests.length === 1);
			if (mode === "selector") await until(() => selector.length > 0);
		} finally { release(); await turn; }
		await h.parent.prompt("Continue");
		assert.equal(requests.length, 3, "first request, tool continuation, next user prompt");
		assert.match(JSON.stringify(requests[1].messages), /ordinary tool result/, "tool output reaches the continuation");
		for (const { messages, system } of requests) {
			assert.ok(!system?.includes(indexMarker), "index is not a system instruction");
			const text = JSON.stringify(messages);
			assert.equal(text.split(indexMarker).length - 1, mode === "index" ? 1 : 0);
			if (mode === "index") assert.equal((messages.find(message => JSON.stringify(message).includes(indexMarker)) as { role: string }).role, "user");
			assert.ok(!text.includes("TOPIC-BODY-33cf5"), "no unselected topic is loaded");
		}
		assert.ok(!JSON.stringify(h.parent.sessionManager.getBranch()).includes(indexMarker), "the index is transient, not session history");
		if (mode === "selector") {
			assert.match(selector[0].prompt, /topic\.md/);
			assert.doesNotMatch(selector[0].prompt, /MEMORY\.md|INDEX-ONLY-9f188/);
		} else assert.equal(selector.length, 0);
	});
}

test("recall stays off when disabled by the host, Pi, or Claude Code, but the write guard still applies", async (t) => {
	const root = temp(t);
	for (const [env, enabled, guardOnly] of [[{ PI_DISABLE_AUTO_MEMORY: "1" }, true, false], [{ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, true, false], [{}, false, false], [{}, true, true]] as const) {
		const { pi, emit, statuses } = fakePi();
		let calls = 0;
		installClaudeMemory(pi, { env, home: root, guardOnly, enabled: () => enabled, run: async () => { calls++; return { ok: true, value: { selected_memories: [] } }; } });
		const ctx = { cwd: root, ui: { setStatus: (_key: string, value?: string) => statuses.push(value) }, sessionManager: { getBranch: () => [] }, modelRegistry: { getAll: () => [] } };
		await emit("session_start", {}, ctx);
		assert.equal(statuses.at(-1), "off");
		await emit("before_agent_start", { prompt: "hello" }, ctx);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(calls, 0);
		const blocked = await emit("tool_call", { toolName: "edit", input: { path: join(root, ".claude", "projects", "-x", "memory", "a.md") } }, ctx) as { block?: boolean };
		assert.equal(blocked?.block, true);
	}
});
