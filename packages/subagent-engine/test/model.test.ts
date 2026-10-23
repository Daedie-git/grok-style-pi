import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEffort, resolveModel, roleDefaultEffort, type ModelLite } from "../src/context/model.ts";

const parent: ModelLite = { provider: "parent", id: "parent-model" };
const models: ModelLite[] = [
	{ provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
	{ provider: "anthropic", id: "claude-sonnet-4-20250514" },
	{ provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "anthropic", id: "claude-opus-4-6" },
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "anthropic", id: "claude-fable-5" },
	{ provider: "openai", id: "gpt-5.2", name: "Reasoning flagship" },
	{ provider: "openai", id: "gpt-5.4" },
	{ provider: "elsewhere", id: "gpt-99" },
	{ provider: "replica", id: "claude-sonnet-4-6" },
];
const base = { parent, available: models, env: {}, isFork: false };

test("model precedence: fork, force, invocation, definition, env, parent", () => {
	const input = { ...base, invocation: "haiku", definition: "sonnet", env: { PI_SUBAGENT_MODEL_FORCE: "opus", PI_SUBAGENT_MODEL: "fable" } };
	assert.equal(resolveModel({ ...input, isFork: true }).model, parent);
	assert.equal(resolveModel({ ...input, isFork: true }).source, "fork");
	assert.equal(resolveModel(input).model.id, "claude-opus-4-6");
	assert.equal(resolveModel(input).source, "force");
	assert.equal(resolveModel({ ...input, env: { PI_SUBAGENT_MODEL: "fable" } }).model.id, "claude-haiku-4-5");
	assert.equal(resolveModel({ ...input, invocation: undefined, env: { PI_SUBAGENT_MODEL: "fable" } }).model.id, "claude-sonnet-4-6");
	assert.equal(resolveModel({ ...base, env: { PI_SUBAGENT_MODEL: "fable" } }).source, "env");
	assert.equal(resolveModel(base).model, parent);
});

test("inherit is case insensitive and skips the default, but not force or invocation", () => {
	const input = { ...base, definition: " INHERIT ", env: { PI_SUBAGENT_MODEL: "sonnet" } };
	assert.equal(resolveModel(input).model, parent);
	assert.equal(resolveModel(input).source, "definition");
	assert.equal(resolveModel({ ...input, invocation: "opus" }).model.id, "claude-opus-4-6");
	assert.equal(resolveModel({ ...input, env: { ...input.env, PI_SUBAGENT_MODEL_FORCE: "haiku" } }).model.id, "claude-haiku-4-5");
});

test("model matching prioritizes exact provider/id, exact id, alias newest, then fuzzy name", () => {
	assert.equal(resolveModel({ ...base, invocation: "replica/claude-sonnet-4-6" }).model.provider, "replica");
	assert.equal(resolveModel({ ...base, invocation: "claude-sonnet-4-20250514" }).model, models[1]);
	assert.equal(resolveModel({ ...base, invocation: "SONNET" }).model.id, "claude-sonnet-4-6");
	for (const alias of ["opus", "haiku", "fable"]) assert(resolveModel({ ...base, invocation: alias }).model.id.includes(alias));
	assert.equal(resolveModel({ ...base, invocation: "flagship" }).model.id, "gpt-5.2");
	assert.equal(resolveModel({ ...base, invocation: "gpt-5." }).model.id, "gpt-5.4");
	assert.equal(resolveModel({ ...base, invocation: "  opus " }).requested, "opus");
});

test("unavailable model tries same-provider family before configured default", () => {
	const result = resolveModel({ ...base, invocation: "openai/gpt-6.0", env: { PI_SUBAGENT_MODEL: "opus" } });
	assert.equal(result.model.id, "gpt-5.4");
	assert.equal(result.model.provider, "openai");
	assert.equal(result.requested, "openai/gpt-6.0");
	assert.equal(result.source, "invocation");
	assert.match(result.note!, /family fallback/);
	assert.equal(resolveModel({ ...base, invocation: "anthropic/claude-sonnet-9" }).model.id, "claude-sonnet-4-6");
	assert.equal(resolveModel({ ...base, parent: models[7], invocation: "gpt-6.0" }).model.id, "gpt-5.4");
});

test("family never crosses provider or alphabetic family and defaults eventually reach parent", () => {
	const fallback = resolveModel({ ...base, invocation: "missing/gpt-6", env: { PI_SUBAGENT_MODEL: "haiku" } });
	assert.equal(fallback.model.id, "claude-haiku-4-5");
	assert.match(fallback.note!, /PI_SUBAGENT_MODEL/);
	for (const invocation of ["missing/gpt-6", "anthropic/claude-unknown-9", "12345"]) {
		const result = resolveModel({ ...base, invocation });
		assert.equal(result.model, parent);
		assert.match(result.note!, /parent model/);
	}
	assert.equal(resolveModel({ ...base, invocation: "missing", env: { PI_SUBAGENT_MODEL: "also-missing" } }).model, parent);
	assert.equal(resolveModel({ ...base, available: [], env: { PI_SUBAGENT_MODEL: "missing" } }).model, parent);
});

test("effort precedence keeps valid env above invocation and fork above all", () => {
	const input = { invocation: "high", definition: "medium", roleDefault: "low", parent: "minimal", env: { PI_SUBAGENT_EFFORT: "max" }, isFork: false };
	assert.deepEqual(resolveEffort(input), { effort: "max", requested: "max", source: "env" });
	assert.deepEqual(resolveEffort({ ...input, isFork: true }), { effort: "minimal", source: "fork" });
	assert.equal(resolveEffort({ ...input, env: {} }).effort, "high");
	assert.equal(resolveEffort({ ...input, env: {}, invocation: undefined }).effort, "medium");
	assert.equal(resolveEffort({ ...input, env: {}, invocation: undefined, definition: undefined }).effort, "low");
	assert.equal(resolveEffort({ env: {}, parent: "minimal", isFork: false }).source, "parent");
	assert.equal(resolveEffort({ env: {}, isFork: false }).effort, undefined);
});

test("all supported efforts pass through without model clamping", () => {
	for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.equal(resolveEffort({ invocation: effort, env: {}, isFork: false }).effort, effort);
	}
});

test("numeric, auto, unset and invalid efforts are ignored with a note and lower-priority fallback", () => {
	for (const effort of ["123", "0.5", "unset", "auto", "invalid"]) {
		const result = resolveEffort({ env: { PI_SUBAGENT_EFFORT: effort }, invocation: "high", isFork: false });
		assert.equal(result.effort, "high");
		assert.equal(result.source, "invocation");
		assert.match(result.note!, /Ignored unsupported env effort/);
	}
	const result = resolveEffort({ env: {}, invocation: "123", definition: "high", isFork: false });
	assert.equal(result.effort, "high");
	assert.match(result.note!, /invocation/);
	assert.match(resolveEffort({ env: { PI_SUBAGENT_EFFORT: "auto" }, isFork: false }).note!, /auto/);
	assert.equal(resolveEffort({ env: { PI_SUBAGENT_EFFORT: " " }, invocation: " high ", isFork: false }).effort, "high");
});

test("role defaults match whole role words, high reasoning roles before medium roles", () => {
	for (const role of ["review", "reviewer", "reviewing", "CODE-REVIEWER", "implement-review", "research", "researcher", "researching", "Plan", "planner", "planning", "general-purpose-research", "implement-plan"]) assert.equal(roleDefaultEffort(role), "high");
	for (const role of ["general-purpose", "plugin:GENERAL-PURPOSE", "explore", "explorer", "exploration", "exploring", "implement", "implementer", "implementation", "implementing", "plugin:EXPLORER"]) assert.equal(roleDefaultEffort(role), "medium");
	for (const role of ["preview", "reviewable", "general-purposeful", "researchable", "planet", "explorers", ""]) assert.equal(roleDefaultEffort(role), undefined);
});

test("role defaults override inherited high effort without overriding explicit settings", () => {
	for (const role of ["general-purpose", "implementer", "review", "research", "Plan"]) {
		const input = { roleDefault: roleDefaultEffort(role), parent: "high", env: {}, isFork: false };
		assert.equal(resolveEffort(input).effort, ["general-purpose", "implementer"].includes(role) ? "medium" : "high");
		assert.equal(resolveEffort({ ...input, definition: "low" }).effort, "low");
		assert.equal(resolveEffort({ ...input, invocation: "max" }).effort, "max");
		assert.equal(resolveEffort({ ...input, env: { PI_SUBAGENT_EFFORT: "xhigh" } }).effort, "xhigh");
	}
});
