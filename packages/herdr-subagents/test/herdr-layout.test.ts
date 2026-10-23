import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHerdrCli, paneLayoutFromPayload } from "../src/herdr/client.ts";

function layout() {
	return {
		area: { height: 97, width: 326, x: 0, y: 0 },
		panes: [
			{ pane_id: "w6S:p1", rect: { height: 49, width: 163, x: 0, y: 0 } },
			{ pane_id: "w6S:p2", rect: { height: 48, width: 163, x: 163, y: 49 } },
		],
		splits: [],
		tab_id: "w6S:t1",
		workspace_id: "w6S",
		zoomed: false,
	};
}

test("pane layout reads real wrapped and bare Herdr results", () => {
	const expected = {
		tabId: "w6S:t1",
		panes: [
			{ paneId: "w6S:p1", x: 0, y: 0, width: 163, height: 49 },
			{ paneId: "w6S:p2", x: 163, y: 49, width: 163, height: 48 },
		],
	};
	assert.deepEqual(paneLayoutFromPayload({ id: "cli:pane:layout", result: { layout: layout() } }), expected);
	assert.deepEqual(paneLayoutFromPayload({ layout: layout() }), expected);
});

test("pane layout rejects missing or malformed layout, tab, and panes", () => {
	for (const payload of [undefined, null, [], {}, { result: {} }, { layout: null }, { layout: [] }]) {
		assert.throws(() => paneLayoutFromPayload(payload));
	}
	for (const tab_id of [undefined, null, 1, "", " \t"]) {
		assert.throws(() => paneLayoutFromPayload({ layout: { ...layout(), tab_id } }));
	}
	for (const panes of [undefined, null, {}, [], [null], [{}]]) {
		assert.throws(() => paneLayoutFromPayload({ layout: { ...layout(), panes } }));
	}
});

test("pane layout rejects missing, empty, malformed, and duplicate pane IDs", () => {
	for (const pane_id of [undefined, null, 1, "", " \t"]) {
		const value = layout();
		assert.throws(() => paneLayoutFromPayload({ layout: { ...value, panes: [{ ...value.panes[0], pane_id }] } }));
	}
	const value = layout();
	value.panes[1].pane_id = value.panes[0].pane_id;
	assert.throws(() => paneLayoutFromPayload({ layout: value }), /duplicate pane ids/);
});

test("pane layout rejects missing rectangles and nonfinite or invalid dimensions", () => {
	for (const rect of [undefined, null, {}, []]) {
		assert.throws(() => paneLayoutFromPayload({ layout: { ...layout(), panes: [{ pane_id: "w6S:p1", rect }] } }));
	}
	for (const key of ["x", "y", "width", "height"]) {
		for (const invalid of [undefined, null, "1", NaN, Infinity, -Infinity, ...(key === "width" || key === "height" ? [0, -1] : [])]) {
			const pane = layout().panes[0];
			assert.throws(() => paneLayoutFromPayload({ layout: { ...layout(), panes: [{ ...pane, rect: { ...pane.rect, [key]: invalid } }] } }), `${key}: ${String(invalid)}`);
		}
	}
});

test("pane layout CLI routes the command, environment, and cancellation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-layout-"));
	const bin = join(dir, "herdr");
	const trace = join(dir, "trace.json");
	writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.HERDR_TEST_TRACE, JSON.stringify({ args: process.argv.slice(2), marker: process.env.HERDR_TEST_MARKER }));
process.stdout.write(process.env.HERDR_TEST_REPLY);
`, { mode: 0o755 });
	const env = { ...process.env, HERDR_BIN_PATH: bin, HERDR_TEST_TRACE: trace, HERDR_TEST_MARKER: "inherited", HERDR_TEST_REPLY: JSON.stringify({ result: { layout: layout() } }) };
	try {
		for (const machine of [undefined, "build-box"]) {
			const cli = createHerdrCli(env, undefined, machine);
			assert.ok(cli.paneLayout);
			assert.equal((await cli.paneLayout("w6S:p1")).tabId, "w6S:t1");
			assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
				args: [...(machine ? ["--machine", machine] : []), "pane", "layout", "--pane", "w6S:p1"],
				marker: "inherited",
			});
		}
		await assert.rejects(createHerdrCli(env).paneLayout!("w6S:p1", AbortSignal.abort()), { name: "AbortError" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
