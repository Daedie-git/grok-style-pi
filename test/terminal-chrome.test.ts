import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { suspendTerminalChrome, grokTerminalOscApply, grokTerminalOscReset } from "../src/terminal-chrome.ts";

test("suspension resets colors before stopping, resumes colors once, and cleans listeners", () => {
	const events = new EventEmitter();
	const writes: string[] = [];
	const chrome = suspendTerminalChrome((text) => writes.push(text), events as any);
	chrome.run(() => writes.push("suspend"));
	assert.deepEqual(writes, [grokTerminalOscReset(), "suspend"]);
	assert.equal(events.listenerCount("SIGTSTP"), 0);
	events.emit("SIGCONT");
	assert.equal(writes.at(-1), grokTerminalOscApply());
	assert.equal(events.listenerCount("SIGCONT"), 0);
	chrome.run(() => {});
	chrome.dispose();
	assert.equal(events.listenerCount("SIGCONT"), 0);
	const count = writes.length;
	events.emit("SIGCONT");
	assert.equal(writes.length, count);
});

test("failed suspension reapplies colors and releases the resume listener", () => {
	const events = new EventEmitter();
	const writes: string[] = [];
	const chrome = suspendTerminalChrome((text) => writes.push(text), events as any);
	assert.throws(() => chrome.run(() => { throw new Error("suspend failed"); }), /suspend failed/);
	assert.deepEqual(writes, [grokTerminalOscReset(), grokTerminalOscApply()]);
	assert.equal(events.listenerCount("SIGCONT"), 0);
});
