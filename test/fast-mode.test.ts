import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installFastMode } from "../src/extension/fast-mode.ts";
import { renderFooter } from "../src/chrome/footer.ts";

type Entry = { type: string; customType?: string; data?: unknown };
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function fixture(entries: Entry[] = []) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, Command>();
	const statuses = new Map<string, string>();
	const notices: { text: string; kind?: string }[] = [];
	let branch = entries;
	let failSave = false;
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-6.1-sol" },
		sessionManager: { getBranch: () => branch },
		ui: {
			setStatus(key: string, value: string | undefined) {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			notify(text: string, kind?: string) { notices.push({ text, kind }); },
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			assert.ok(!handlers.has(name), `${name} must be registered once`);
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		appendEntry(customType: string, data: unknown) {
			if (failSave) throw new Error("Session save failed");
			branch.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	installFastMode(pi);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
	const command = (args: string) => commands.get("fast")!.handler(args, ctx);
	const payload = (value: unknown = {}) => emit("before_provider_request", { payload: value });
	emit("session_start", { reason: "startup" });
	return {
		ctx, pi, commands, statuses, notices, emit, command, payload,
		entries: () => branch,
		setBranch(value: Entry[]) { branch = value; },
		failSave() { failSave = true; },
	};
}

const saved = (enabled: unknown): Entry => ({ type: "custom", customType: "openai-fast", data: { enabled } });

test("fast mode defaults off, requests priority without mutation, and leaves provider defaults alone when off", async () => {
	const f = fixture();
	const input = [{ role: "user", content: "Hello" }];
	const original = { model: "gpt-6.1-sol", service_tier: "default", input, stream: true };
	assert.equal(f.payload(original), undefined);
	assert.equal(f.statuses.has("openai-fast"), false);
	assert.deepEqual([...f.commands.keys()], ["fast"]);
	await f.command("on");
	const updated = f.payload(original);
	assert.deepEqual(updated, { ...original, service_tier: "priority" });
	assert.notEqual(updated, original);
	assert.equal((updated as typeof original).input, input);
	assert.equal(original.service_tier, "default");
	assert.equal(f.statuses.get("openai-fast"), "Fast: priority requested");
	assert.match(f.notices.at(-1)!.text, /not guaranteed.*cost/);
	await f.command("off");
	assert.equal(f.payload(original), undefined);
	assert.equal(f.payload({ service_tier: "priority" }), undefined, "off does not override a provider's own defaults");
	assert.equal(f.statuses.has("openai-fast"), false);
});

test("fast command supports toggle, case-insensitive on/off, and read-only status and usage errors", async () => {
	const f = fixture();
	await f.command("status");
	assert.equal(f.notices.at(-1)!.text, "Fast mode off.");
	assert.equal(f.entries().length, 0);
	await f.command("  ON  ");
	assert.equal((f.payload() as any).service_tier, "priority");
	await f.command("status");
	assert.equal(f.entries().length, 1);
	for (const args of ["invalid", "on off", "on extra"]) {
		await f.command(args);
		assert.deepEqual(f.notices.at(-1), { text: "Usage: /fast [on|off|status]", kind: "warning" });
		assert.equal(f.entries().length, 1);
		assert.equal((f.payload() as any).service_tier, "priority");
	}
	await f.command("");
	assert.equal(f.payload(), undefined);
	await f.command("  ");
	assert.equal((f.payload() as any).service_tier, "priority");
	await f.command("OFF");
	assert.equal(f.payload(), undefined);
	assert.deepEqual(f.entries().map(entry => entry.data), [{ enabled: true }, { enabled: false }, { enabled: true }, { enabled: false }]);
});

test("priority and the Grok footer follow supported model changes without forgetting the setting", async () => {
	const f = fixture();
	await f.command("on");
	for (const model of [
		{ provider: "anthropic", id: "gpt-6.1-sol" },
		{ provider: "xai", id: "grok" },
		{ provider: "openai", id: "o3" },
		{ provider: "openai-codex", id: "not-gpt" },
		undefined,
	]) {
		f.ctx.model = model as ExtensionContext["model"];
		f.emit("model_select");
		assert.equal(f.payload(), undefined);
		assert.equal(f.statuses.has("openai-fast"), false);
	}
	await f.command("status");
	assert.match(f.notices.at(-1)!.text, /only to OpenAI GPT models/);
	for (const provider of ["openai", "openai-codex"]) {
		f.ctx.model = { provider, id: "gpt-6.1-sol" } as ExtensionContext["model"];
		f.emit("model_select");
		assert.equal((f.payload() as any).service_tier, "priority");
		const footer = () => renderFooter({ cwd: "/work", provider, model: "gpt-6.1-sol", fastMode: Boolean(f.statuses.get("openai-fast")) }, { width: 200 }).join("\n");
		assert.match(footer(), /Fast: on/);
		await f.command("off");
		assert.match(footer(), /Fast: off/);
		await f.command("on");
	}
});

test("fast mode restores existing session entries and only reads the active session branch", async () => {
	const f = fixture([saved(true)]);
	assert.equal((f.payload() as any).service_tier, "priority");
	for (const reason of ["reload", "resume", "fork"]) {
		f.setBranch([saved(false), saved(true)]);
		f.emit("session_start", { reason });
		assert.equal((f.payload() as any).service_tier, "priority");
	}
	f.setBranch([saved(true), saved(false)]);
	f.emit("session_tree");
	assert.equal(f.payload(), undefined);
	f.setBranch([saved(true)]);
	f.emit("session_tree");
	assert.equal((f.payload() as any).service_tier, "priority");
	f.setBranch([]);
	f.emit("session_start", { reason: "new" });
	assert.equal(f.payload(), undefined, "a new session cannot inherit another session's setting");
	assert.deepEqual(f.entries(), [], "restoration never appends state");
});

test("invalid stored data and malformed payloads do not enable priority or replace a valid setting", async () => {
	const invalid: Entry[] = [saved("true"), saved(null), { type: "custom", customType: "openai-fast", data: null }, { type: "custom", customType: "other", data: { enabled: true } }];
	const f = fixture(invalid);
	assert.equal(f.payload(), undefined);
	f.setBranch([saved(true), ...invalid]);
	f.emit("session_tree");
	assert.equal((f.payload() as any).service_tier, "priority");
	for (const value of [null, undefined, "text", 42, true, []]) {
		assert.equal(f.emit("before_provider_request", { payload: value }), undefined);
	}
});

test("failed session persistence leaves fast mode unchanged, and shutdown clears its status", async () => {
	const f = fixture();
	f.failSave();
	await assert.rejects(f.command("on"), /Session save failed/);
	assert.equal(f.payload(), undefined);
	assert.equal(f.statuses.has("openai-fast"), false);
	const enabled = fixture([saved(true)]);
	enabled.emit("session_shutdown");
	assert.equal(enabled.statuses.has("openai-fast"), false);
	assert.equal(fixture().payload(), undefined, "another extension runtime starts independently");
});
