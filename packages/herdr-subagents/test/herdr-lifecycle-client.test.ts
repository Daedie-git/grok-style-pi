import assert from "node:assert/strict";
import test from "node:test";
import { panesFromList } from "../src/herdr/client.ts";

test("pane liveness preserves positive focus, status and conversation evidence", () => {
	const [pane, incomplete] = panesFromList({ result: { panes: [
		{ pane_id: "w1:p2", focused: false, agent_status: "working", agent_session: { value: "/sessions/conversation.jsonl" } },
		{ pane_id: "w1:p3" },
	] } });
	assert.deepEqual(pane, { paneId: "w1:p2", tabId: undefined, focused: false, status: "working", session: "/sessions/conversation.jsonl" });
	assert.equal(incomplete.focused, undefined);
	assert.equal(incomplete.status, undefined);
});

test("native shell classification requires explicit shell-shaped metadata, not merely a missing session", () => {
	const [shell, agent, malformedAgent, absentStatus, malformedSession, named, absentPane] = panesFromList({ result: { panes: [
		{ pane_id: "w1:p1", agent_status: "unknown" },
		{ pane_id: "w1:p2", agent: "pi", agent_status: "unknown" },
		{ pane_id: "w1:p3", agent: null, agent_status: "unknown" },
		{ pane_id: "w1:p4" },
		{ pane_id: "w1:p5", agent_session: {}, agent_status: "unknown" },
		{ pane_id: "w1:p6", name: "maybe-agent", agent_status: "unknown" },
		{ agent_status: "unknown" },
	] } });
	assert.equal(shell.plainShell, true);
	for (const unknown of [agent, malformedAgent, absentStatus, malformedSession, named, absentPane]) assert.equal(unknown.plainShell, undefined);
});
