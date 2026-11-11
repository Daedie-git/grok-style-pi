import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowSource } from "../src/workflow/meta.ts";
import { workflowApproval, workflowLimits } from "../src/workflow/plan.ts";

const source = (fields: string) => `export const meta={name:'review',description:'Inspect the change and review it',${fields}}; return 1;`;

test("workflow metadata validates explicit task and concurrency limits", () => {
	const parsed = parseWorkflowSource(source("maxAgents:12,maxConcurrency:6"));
	assert.equal(parsed.error, undefined);
	assert.equal(parsed.meta?.maxAgents, 12);
	assert.equal(parsed.meta?.maxConcurrency, 6);
	for (const value of ["-1", "1.5", "1001", "'4'", "null"]) assert.match(parseWorkflowSource(source(`maxAgents:${value}`)).error!, /maxAgents must be an integer/);
	for (const value of ["0", "-1", "1.5", "257", "'4'", "null"]) assert.match(parseWorkflowSource(source(`maxConcurrency:${value}`)).error!, /maxConcurrency must be an integer/);
});

test("approval and runtime limits can only narrow host or parent limits", () => {
	const meta = parseWorkflowSource(source("maxAgents:12,maxConcurrency:6")).meta!;
	assert.deepEqual(workflowLimits(meta, { PI_WORKFLOW_CONCURRENCY: "4" }), { maxCalls: 12, concurrency: 4 });
	assert.deepEqual(workflowLimits(meta, {}, { maxCalls: 2, concurrency: 1 }), { maxCalls: 2, concurrency: 1 });
	assert.deepEqual(workflowLimits(undefined, { PI_WORKFLOW_CONCURRENCY: "3" }), { maxCalls: 1000, concurrency: 3 });
	const env = { PI_WORKFLOW_CONCURRENCY: "1" };
	const approved = workflowLimits(meta, env);
	env.PI_WORKFLOW_CONCURRENCY = "8";
	assert.deepEqual(workflowLimits(meta, env, approved), approved, "changing host settings cannot widen already-approved limits");
});

test("approval summaries bound metadata and remove terminal controls without embedding executable source", () => {
	const meta = parseWorkflowSource(source("maxAgents:12,maxConcurrency:6")).meta!;
	meta.description = "\u001b]52;c;clipboard\u0007Inspect\n" + "description ".repeat(300);
	meta.phases = Array.from({ length: 30 }, (_, index) => ({ title: `Phase ${index + 1}`, detail: "detail ".repeat(100) }));
	const summary = workflowApproval(meta, workflowLimits(meta, { PI_WORKFLOW_CONCURRENCY: "4" }), "/work/plan.js\n\u001b[31m");
	assert.ok(summary.length < 5000);
	assert.doesNotMatch(summary, /\u001b|clipboard/);
	assert.match(summary, /up to 12 agent tasks; at most 4 at once/);
	assert.match(summary, /18 more phases/);
	assert.match(summary, /Source: \/work\/plan.js/);
	assert.match(workflowApproval({ name: "legacy", description: "Old workflow", phases: [] }, { maxCalls: 1000, concurrency: 2 }), /No task count declared/);
});
