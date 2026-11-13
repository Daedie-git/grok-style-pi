import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";
import type { HerdrAgentRef, HerdrClient } from "../../herdr-runner/src/client.ts";
import type { ChildBinding, HerdrStore } from "../../herdr-runner/src/store.ts";
import type { ExecutionEvent } from "../../herdr-runner/src/state.ts";
import { SidecarCli } from "../../src/cli.ts";

export const OWNER = { paneId: "w1:p1", session: "0b0c0d0e-0000-4000-8000-00000000000a" };

/** A herdr server with the Claude owner's pane, whose Pi children answer each prompt with `reply`. */
export function fixture(t: test.TestContext, reply: (prompt: string, n: number) => ExecutionEvent) {
	const root = mkdtempSync(join(tmpdir(), "sidecar-runner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const panes = new Map<string, HerdrAgentRef>([[OWNER.paneId, { paneId: OWNER.paneId, session: OWNER.session, focused: false }]]);
	const named = new Map<string, HerdrAgentRef>();
	const bindings: Array<{ store: () => HerdrStore; binding: ChildBinding }> = [];
	const prompts: string[] = [];
	const starts: string[][] = [];
	let sequence = 1;
	let store: HerdrStore | undefined;
	const client: HerdrClient = {
		async split() { throw new Error("Unexpected split"); },
		async createTab() {
			const paneId = `w1:p${++sequence}`;
			panes.set(paneId, { paneId, focused: false, plainShell: true });
			return { paneId, tabId: "w1:t2", workspaceId: "w1" };
		},
		async startPi(start) {
			starts.push(start.args);
			const session = start.args[start.args.indexOf("--session") + 1];
			const header = JSON.parse(readFileSync(session, "utf8").split("\n")[0]);
			const { HerdrStore } = await import("../../herdr-runner/src/store.ts");
			store ??= new HerdrStore(join(root, "store"));
			const binding = (await store.attach(start.paneId, session, header.id))!;
			bindings.push({ store: () => store!, binding });
			const pane = { paneId: start.paneId, name: start.name, session, focused: false, status: "idle" };
			named.set(start.name, pane);
			panes.set(start.paneId, pane);
		},
		async promptAgent() { throw new Error("Unexpected prompt"); },
		async closePane(paneId) { panes.delete(paneId); for (const [name, pane] of named) if (pane.paneId === paneId) named.delete(name); },
		async isAlive(name) { return named.has(name); },
		async getAgent(name) { return named.get(name); },
		async getPane(paneId) { return panes.get(paneId); },
		async showLabel() {},
		async listAgents() { return structuredClone([...named.values()]); },
		async listPanes() { return structuredClone([...panes.values()]); },
	};
	// The children: claim each prompt, go live, and answer it.
	let stopped = false;
	const children = (async () => {
		while (!stopped) {
			for (const { store, binding } of bindings) {
				const command = await store().claimNextCommand(binding.agent.id, binding.token, false);
				if (!command || command.type !== "prompt") continue;
				prompts.push(command.text);
				const ref = { agentId: command.agentId, runId: command.runId };
				await store().recordExecutionEvent(ref, binding.token, { type: "live" }, Date.now());
				await store().recordExecutionEvent(ref, binding.token, reply(command.text, prompts.length), Date.now());
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	})();
	t.after(async () => { stopped = true; await children; await store?.close(); });
	const env = {
		HERDR_ENV: "1", HERDR_PANE_ID: OWNER.paneId, HERDR_WORKSPACE_ID: "w1", CLAUDE_CODE_SESSION_ID: OWNER.session,
		CLAUDE_CONFIG_DIR: join(root, "claude"), SIDECAR_STATE_DIR: join(root, "state"), PATH: process.env.PATH,
	};
	const runWith = async (options: { cwd?: string; stdin?: string; env?: Record<string, string | undefined> }, ...argv: string[]) => {
		let stdout = "", stderr = "";
		const cli = new SidecarCli({ stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, stdin: async () => options.stdin ?? "from stdin" }, {
			env: { ...env, ...options.env } as NodeJS.ProcessEnv, cwd: options.cwd ?? root, pollMs: 10, progressMs: 0,
			parent: { client, root: join(root, "store"), agentDir: join(root, "agent"), listMachines: async () => [] },
		});
		const code = await cli.run(argv);
		return { code, stdout, stderr };
	};
	const run = (...argv: string[]) => runWith({}, ...argv);
	return { run, runWith, prompts, starts, root, panes, env, store: () => store };
}

