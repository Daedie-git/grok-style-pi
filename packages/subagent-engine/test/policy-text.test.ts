import { test } from "node:test";
import assert from "node:assert/strict";
import {
	agentToolDescription, sessionGuidance, listingText, launchResultText, noticeText,
	SEND_MESSAGE_DESCRIPTION, TASK_STOP_DESCRIPTION, type PolicyInput,
} from "../src/policy/text.ts";
import type { NoticePayload } from "../src/types.ts";

const explore = { agentType: "Explore", description: "Locate implementation paths", tools: ["Read", "Grep"] };
const general = { agentType: "general-purpose", description: "Carry out bounded assignments" };
const fork = { agentType: "fork", description: "Perform one inherited-context directive" };
const positive: PolicyInput = { autonomy: "positive", forkEnabled: false, offered: [explore, general], exploreAvailable: true };

function golden(text: string, required: string[], forbidden: string[]): void {
	for (const fragment of required) assert(text.includes(fragment), `Missing required text: ${fragment}`);
	for (const fragment of forbidden) assert(!text.includes(fragment), `Forbidden text: ${fragment}`);
}

// Required and forbidden fixtures for each model-input channel. Explicit-only
// suppression is an intentional improvement over conflicting target profiles.
const fixtures: { name: string; input: PolicyInput; required: string[]; forbidden: string[]; listingRequired: string[]; listingForbidden: string[] }[] = [
	{
		name: "positive", input: positive,
		required: ["Delegation heuristics", "without a separate user request", "substantial independent tracks", "more than 3 queries", "Explore locates code"],
		forbidden: ["Delegate only when the user explicitly requests", "prefer an offered fork", "A fork inherits"],
		listingRequired: ["Available agent types", "Explore: Locate implementation paths", "Read, Grep", "general-purpose", "inherited tools"],
		listingForbidden: ["fork:", "Removed;", "without a separate user request", "more than 3 queries"],
	},
	{
		name: "explicit-only", input: { ...positive, autonomy: "explicit" },
		required: ["Delegate only when the user explicitly requests agents or names an offered agent type", "overrides proactive wording", "thoroughness or several subtasks"],
		forbidden: ["without a separate user request", "Delegation heuristics", "prefer an offered fork", "more than 3 queries", "use a matching specialist"],
		listingRequired: ["Available agent types", "Explore", "current delegation policy", "descriptions do not override its restrictions"],
		listingForbidden: ["without a separate user request", "more than 3 queries", "prefer an offered fork"],
	},
	{
		name: "fork-enabled", input: { ...positive, forkEnabled: true, offered: [explore, general, fork] },
		required: ["prefer an offered fork", "one directive rather than a fresh briefing", "never the default", "fork worker must not delegate", "commit hashes"],
		forbidden: ["more than 3 queries", "Delegate only when the user explicitly requests"],
		listingRequired: ["Available agent types", "fork: Perform one inherited-context directive", "runtime restrictions still apply"],
		listingForbidden: ["more than 3 queries", "prefer an offered fork", "Delegate only"],
	},
	{
		name: "no-offered-types", input: { ...positive, offered: [] },
		required: ["No agent types are currently offered"],
		forbidden: ["without a separate user request", "more than 3 queries", "prefer an offered fork", "batch Agent calls"],
		listingRequired: ["Available agent types", "No agent types are currently offered"],
		listingForbidden: ["Explore:", "general-purpose:", "fork:", "batch Agent calls"],
	},
];
for (const fixture of fixtures) {
	test(`Agent description golden: ${fixture.name}`, () => {
		golden(agentToolDescription(fixture.input), fixture.required, fixture.forbidden);
	});
	test(`session guidance golden: ${fixture.name}`, () => {
		const text = sessionGuidance(fixture.input);
		if (!fixture.input.offered.length) assert.equal(text, undefined);
		else golden(text!, ["Delegation policy", ...fixture.required], fixture.forbidden);
	});
	test(`listing golden: ${fixture.name}`, () => {
		golden(listingText(fixture.input.offered, [], true), fixture.listingRequired, fixture.listingForbidden);
	});
}

test("both policy channels cover useful work boundaries, briefing, continuation, execution and authority", () => {
	for (const render of [agentToolDescription, sessionGuidance]) {
		golden(render(positive)!, [
			"known-file or known-symbol lookup", "batch Agent calls in one message", "Dependent assignments must wait",
			"Do not repeat research", "Avoid overlapping writers", "no parent conversation", "objective, relevant paths and facts",
			"SendMessage", "run_in_background:false only", "not polling or sleeps", "not shown directly to the user",
			"Verify actual code changes", "Set effort only on explicit instruction", "model override is allowed when useful",
			"does not authorize permission, configuration, or instruction-file changes",
		], ["always delegate", "use 20 agents", "Set model only on explicit instruction"]);
	}
});

test("routing is conditional on real offered types and explicit mode keeps mechanics without recommendations", () => {
	assert(!agentToolDescription({ ...positive, exploreAvailable: false }).includes("more than 3 queries"));
	assert(!agentToolDescription({ ...positive, offered: [general] }).includes("more than 3 queries"));
	assert(!agentToolDescription({ ...positive, forkEnabled: true }).includes("prefer an offered fork"));
	const explicitFork = agentToolDescription({ ...positive, autonomy: "explicit", forkEnabled: true, offered: [fork] });
	golden(explicitFork, ["Delegate only when", "A fork inherits", "one directive", "must not delegate"], ["prefer an offered fork", "without a separate user request", "more than 3 queries"]);
	assert(!agentToolDescription({ ...positive, forkEnabled: false, offered: [fork] }).includes("A fork inherits"));
});

test("Agent description is stable prose; dynamic names and descriptions live only in listings", () => {
	const input = { ...positive, offered: [{ agentType: "custom-agent", description: "SPECIAL-DYNAMIC-TEXT" }] };
	assert(!agentToolDescription(input).includes("SPECIAL-DYNAMIC-TEXT"));
	assert(!sessionGuidance(input)!.includes("custom-agent"));
	golden(listingText(input.offered, [], true), ["custom-agent: SPECIAL-DYNAMIC-TEXT"], ["Explore:"]);
});

test("listings report additions, removals and declared tools without inventing executable types", () => {
	const delta = listingText([{ agentType: "empty", description: "No tools", tools: [] }, { agentType: "wild", description: "Wildcard", tools: ["*"] }], ["old"], false);
	golden(delta, ["Agent type changes", "empty: No tools (Declared tools: no tools", "wild: Wildcard (Declared tools: inherited tools", "Removed; no longer executable: old"], ["Available agent types", "old:", "code-reviewer"]);
	const removal = listingText([], ["Explore"], false);
	golden(removal, ["Removed; no longer executable: Explore"], ["Explore:", "No agent types are currently offered"]);
});

test("proactive custom descriptions reach the listing but cannot supersede explicit-only policy", () => {
	const offered = [{ agentType: "custom", description: "Use proactively after edits" }];
	assert(listingText(offered, [], true).includes("Use proactively after edits"));
	assert(agentToolDescription({ ...positive, autonomy: "explicit", offered }).includes("restriction overrides proactive wording"));
});

test("launch messages distinguish execution mode and prohibit monitoring or guessing", () => {
	for (const background of [true, false]) {
		const text = launchResultText({ agentId: "a123", name: "worker", description: "Inspect dependencies", background });
		golden(text, [background ? "in the background" : "in the foreground", "a123", "worker", "Do not quote the agent ID", "SendMessage to continue", "You will be notified", "Do not poll, sleep", "read its live transcript", "predict its findings", "Continue other useful work"], ["TaskGet", "get_subagent_result", "completed:"]);
	}
});

const notice: NoticePayload = {
	agentId: "a123", name: "worker", description: "Inspect dependencies", status: "completed", classification: "completed",
	resultText: "Found two paths.", resultTruncated: false, transcriptPath: "/state/agent.jsonl", resumable: true,
};

test("terminal notices contain identity, report, usage, transcript and change verification", () => {
	const text = noticeText({ ...notice, usage: { latestFootprint: 31, liveMetric: 32, billable: { input: 30, output: 6, cacheRead: 8, cacheWrite: 3, totalTokens: 47, cost: 0.1 }, modelTransitions: ["A", "B", "A"] } });
	assert.equal(text.split("\n")[0], "Agent completed: Inspect dependencies");
	golden(text, ["a123", "worker", "classification: completed", "Found two paths", "32 notification tokens", "billed total 47", "A → B → A", "/state/agent.jsonl", "Verify actual code changes", "Resumable: yes"], ["Partial result", "another notice will follow", "automatic resume"]);
});

test("partial and failed notices state why results do not prove completion", () => {
	golden(noticeText({ ...notice, classification: "partial-max-turns" }), ["Partial result", "turn budget", "may be unfinished"], ["API failure interrupted"]);
	golden(noticeText({ ...notice, status: "failed", classification: "partial-api", failure: "server_error" }), ["Agent failed", "API failure interrupted", "not proof of completion", "Failure: server_error"], ["Agent completed:"]);
	golden(noticeText({ ...notice, status: "failed", classification: "failed-api", failure: "overloaded" }), ["Partial report from a failed run (failed-api)", "does not establish completion", "Failure: overloaded"], ["Agent completed:"]);
});

test("interim and resume-pending notices do not masquerade as a final handback", () => {
	const text = noticeText({ ...notice, interim: true, resumePending: true });
	assert.equal(text.split("\n")[0], "Agent waiting: Inspect dependencies");
	golden(text, ["waiting on its own children", "another notice will follow", "automatic resume", "Another run will follow", "do not launch duplicate work"], ["Agent completed:"]);
});

test("cancellation source and resumability are explicit, including nonresumable stops", () => {
	for (const killedBy of ["user", "parent", "session-end", "watchdog"] as const) {
		const text = noticeText({ ...notice, status: "killed", classification: "killed", killedBy, resumable: false });
		golden(text, [`Cancellation source: ${killedBy}`, "Agent stopped:", "Resumable: no", "do not attempt to continue"], ["Resumable: yes", "Agent completed:"]);
	}
	assert(noticeText({ ...notice, status: "killed", killedBy: "user" }).includes("user-stopped agent still requires explicit user authorization"));
});

test("notice report text is bounded and worktree retention is reported without fabricated commits", () => {
	const worktree = { path: "/worktrees/a123", branch: "agent-a123", baseCommit: "abc", repoRoot: "/repo", kept: true };
	const text = noticeText({ ...notice, resultText: "x".repeat(30_000), worktree });
	assert(text.length < 15_000);
	golden(text, ["Report truncated", "/worktrees/a123", "agent-a123", "Changes kept", "Verify actual code changes"], ["committed automatically"]);
	assert(noticeText({ ...notice, resultTruncated: true }).includes("Report truncated"));
	assert(noticeText({ ...notice, worktree: { ...worktree, kept: false } }).includes("Worktree not kept"));
	assert(noticeText({ ...notice, resultText: "" }).includes("(No report text.)"));
	assert.equal(noticeText({ ...notice, description: "Title\nsecond line" }).split("\n")[0], "Agent completed: Title second line");
});

test("message and stop tool descriptions preserve routing, delivery and cancellation boundaries", () => {
	golden(SEND_MESSAGE_DESCRIPTION, ["main (the root conversation, not the immediate parent)", "queued, not", "continue a finished, resumable agent", "do not grant user consent", "Do not broadcast", "explicit user authorization"], ["automatically approved"]);
	golden(TASK_STOP_DESCRIPTION, ["root may stop any agent", "subagent may stop only itself, not its children", "still exiting", "not proof that execution has settled", "prevents automatic continuation"], ["may stop its children"]);
});
