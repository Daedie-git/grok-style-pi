import { defineTool, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrCli, findHerdrMachine, herdrSessionName, listHerdrMachines, pickHerdrMachine, type HerdrAgentRef, type HerdrClient, type HerdrExec, type HerdrMachine } from "./client.ts";
import { createChildSession, type ChildSession, type ChildIdentity } from "./child.ts";
import { createBackendController, type HerdrBackendHandle } from "./backend.ts";
export type { HerdrBackendHandle, HerdrBackendNotice, HerdrBackendRequest } from "./backend.ts";
import type { ExecutionEvent, RunRef } from "./state.ts";
import {
	completionNotice,
	qualifiedAgentId,
	readHerdrAgent,
	HerdrRunner,
	splitAgentId,
	spawnHerdrAgent,
	steerHerdrAgent,
	type SpawnRequest,
	type ToolText,
} from "./runner.ts";
import { EXPLICIT_SUBAGENT_REQUEST } from "./policy.ts";
import { machineDefaultCwd, machineWorkerEntry, readHerdrSettings } from "./config.ts";
import { HERDR_REMOTE_PROTOCOL, herdrSubagentRoot, sshChannel, type HerdrStore, type StoreChannelFactory } from "./store.ts";
import { createHcCli, hcConnect, hcSessionTag, listHcMachines } from "./hc.ts";
import { hostPaneId, terminalHost, type TerminalHost } from "./host.ts";

export interface HerdrSubagentDeps {
	env: NodeJS.ProcessEnv;
	root: string;
	client: HerdrClient;
	agentDir: string;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	/** Herdr CLI routed to a saved SSH machine. */
	machineClient: (machine: string, exec?: HerdrExec) => HerdrClient;
	/** Opens the coordination store that lives on a saved SSH machine. */
	machineChannel: (machine: string, workerEntry?: string) => Promise<StoreChannelFactory>;
	/** Distinguishes this machine's panes in a remote store, where pane IDs belong to another server. */
	hostname: string;
	/** Saved SSH machines named in the Agent description. Read once per load, so /reload refreshes it. */
	listMachines: () => Promise<HerdrMachine[]>;
}

/** Names the enabled saved machines so the model can map "the laptop" to a selector without asking. */
export function machineGuidance(machines: HerdrMachine[]): string {
	const enabled = machines.filter((machine) => machine.enabled);
	if (!enabled.length) return "";
	// A label shared by any two profiles, disabled ones included, is ambiguous; only the profile ID selects then.
	const repeated = (label: string) => machines.filter((machine) => machine.label === label).length > 1;
	const describe = (machine: HerdrMachine) => {
		if (repeated(machine.label)) return `${machine.id} (label ${machine.label}, ${machine.target})`;
		return machine.label === machine.target ? machine.label : `${machine.label} (${machine.target})`;
	};
	return ` Saved machines: ${enabled.map(describe).join(", ")}. Pass the name shown first as machine.`;
}

/** New overrides name the standalone root; legacy overrides name a Grok root with a forwarding entry. */
export function remoteWorkerEntry(env: NodeJS.ProcessEnv): string {
	const pkg = (env.HERDR_SUBAGENTS_REMOTE_PACKAGE || env.GROK_HERDR_REMOTE_PACKAGE)?.replace(/\/+$/, "");
	return pkg ? `${pkg}/src/herdr/worker-entry.mjs` : fileURLToPath(new URL("./worker-entry.mjs", import.meta.url));
}

const POLL_MS = 200;

export interface HerdrSubagentOptions extends Partial<HerdrSubagentDeps> {
	mode?: "backend";
	/** Defaults to the host this process runs in, else herdr. */
	host?: TerminalHost;
	onBackend?: (handle: HerdrBackendHandle) => void;
}

export function createHerdrSubagents(overrides: HerdrSubagentOptions = {}): ExtensionFactory {
	const env = overrides.env ?? process.env;
	const hc = (overrides.host ?? terminalHost(env) ?? "herdr") === "hc";
	const hcCall = hcConnect(env);
	/** Saved machines of this host, selected by profile ID or unique label. */
	const findMachine = async (selector: string): Promise<HerdrMachine> => {
		if (!hc) return findHerdrMachine(selector, env);
		const machine = pickHerdrMachine(await listHcMachines(hcCall), selector);
		if (!machine) throw new Error(`Unknown hc machine '${selector}'. Add it with hc machine add, then check hc machine ls.`);
		return machine;
	};
	const deps: HerdrSubagentDeps = {
		env,
		root: overrides.root ?? herdrSubagentRoot(env),
		client: overrides.client ?? (hc ? createHcCli(env, { call: hcCall }) : createHerdrCli(env)),
		agentDir: overrides.agentDir ?? getAgentDir(),
		sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		now: overrides.now ?? Date.now,
		machineClient: overrides.machineClient ?? ((machine, exec) => hc
			? createHcCli(env, { machine, call: hcCall })
			: createHerdrCli(env, undefined, machine, undefined, exec)),
		machineChannel: overrides.machineChannel ?? (async (machine, workerEntry) => sshChannel({
			target: (await findMachine(machine)).target,
			node: env.HERDR_SUBAGENTS_REMOTE_NODE || env.GROK_HERDR_REMOTE_NODE,
			entry: workerEntry ?? remoteWorkerEntry(env),
		})),
		hostname: overrides.hostname ?? hostname(),
		// Older Herdr has no saved machines, and an unavailable listing only leaves them unnamed.
		listMachines: overrides.listMachines ?? (() => (hc ? listHcMachines(hcCall, 2500) : listHerdrMachines(env, 2500)).catch(() => [])),
	};
	const paneId = hostPaneId(deps.env, hc ? "hc" : "herdr");
	// App terminals have no tab or workspace; their subagents nest under them.
	const localTab = hc ? undefined : deps.env.HERDR_TAB_ID;
	const localWorkspace = hc ? undefined : deps.env.HERDR_WORKSPACE_ID;
	// Remote stores key notices by this pane; a bare pane ID could name one of that machine's own panes.
	const parentKey = (machine?: string) => machine && paneId ? `${deps.hostname}/${paneId}` : paneId;
	return async (pi: ExtensionAPI) => {
		const profiles = await deps.listMachines().catch(() => []);
		const settings = readHerdrSettings(deps.agentDir);
		const savedMachines = machineGuidance(profiles) + "\nTo launch remotely, call Agent with machine and an absolute machine_cwd on that machine; the backend handles SSH and startup. Do not use SSH or terminal.run to launch agents yourself. Remote project paths may differ from this session's directory; use a confirmed path, not a guess."
			+ (hc ? " In the Herdr app, discover existing working directories with hc ls --json; remote terminal addresses start with the saved machine name followed by /." : "");
		const queuedNotices = new Set<string>();
		let runner: HerdrRunner | undefined;
		let opening: Promise<HerdrRunner> | undefined;
		/** hc records are tagged by the core this client reaches; without its id, no runner opens and nothing is maintained. */
		const hostSession = async (client: HerdrClient) => {
			if (!client.hostId) throw new Error("This hc client cannot identify its core.");
			return hcSessionTag(await client.hostId());
		};
		const getRunner = async (): Promise<HerdrRunner> => runner ?? (opening ??= (async () => {
			const herdrSession = hc ? await hostSession(deps.client) : herdrSessionName(deps.env);
			return runner = new HerdrRunner({ ...deps, closeWhenDone: settings.closeWhenDone, herdrSession });
		})().finally(() => { opening = undefined; }));
		/** One runner, and one SSH store channel, per saved machine used by this session. */
		const machines = new Map<string, Promise<HerdrRunner>>();
		const machineRunners = new Map<string, HerdrRunner>();
		/** Each machine's runner once its channel opens, before its protocol check settles. */
		const connecting = new Map<string, Promise<HerdrRunner>>();
		/** Runners whose protocol matched. Only these may send store calls, including owner retirement on close. */
		const verified = new WeakSet<HerdrRunner>();
		const recordedMachines = new Set<string>();
		/** Owners whose channel dropped. A reconnect retires them so the machine can recover their launches. */
		const lostOwners = new Map<string, string[]>();
		/** Saved receipts whose machine is unreachable; retried each tick. */
		const pendingReceipts = new Map<string, string>();
		const machineRunner = (machine: string): Promise<HerdrRunner> => {
			let pending = machines.get(machine);
			if (!pending) {
				const profile = pickHerdrMachine(profiles, machine);
				const session = hc ? undefined : profile?.session;
				const open = (herdrSession: string | undefined, hcClient?: HerdrClient) => deps.machineChannel(machine, machineWorkerEntry(machine, profiles, settings.machines)).then((channel) => {
					// Herdr calls share the store's channel: `--machine` runs SSH twice per call, and PowerShell too on Windows.
					// Only a known session may: a bare command would reach whichever session the worker inherited, where pane IDs repeat.
					const exec: HerdrExec | undefined = session ? (args, timeout, signal) => runner.store.herdr(["--session", session, ...args], timeout, signal) : undefined;
					const client = hcClient ?? deps.machineClient(machine, exec);
					const runner: HerdrRunner = new HerdrRunner({ ...deps, root: "", client, channel, machine, herdrSession, closeWhenDone: settings.closeWhenDone });
					return runner;
				});
				// hc addresses a machine by its name, and needs that core's id before opening its store channel, so a failure
				// leaves nothing open.
				const hcClient = hc ? deps.machineClient(profile?.label ?? machine) : undefined;
				const connected = hcClient ? hostSession(hcClient).then((tag) => open(tag, hcClient)) : open(session);
				pending = connected.then(async (opened) => {
					// Refuse a mismatched package before any launch or owner retirement runs on that store.
					// An unverified store is closed without retiring anything: its operations are not established.
					try { await assertRemoteProtocol(opened.store, machine); }
					catch (error) { await opened.store.close().catch(() => undefined); throw error; }
					verified.add(opened);
					// Shutdown or a reconnect replaced this open while it was checked; it must not outlive them untracked.
					if (machines.get(machine) !== pending) {
						await opened.close().catch(() => undefined);
						throw new Error(`${machine}: connection closed`);
					}
					machineRunners.set(machine, opened);
					// Retire in the background: a stalled call must not hold the open, which shutdown awaits.
					// An owner that could not be retired is kept for the next reconnect.
					const lost = lostOwners.get(machine) ?? [];
					lostOwners.delete(machine);
					for (const owner of lost) {
						opened.store.retireOwner(owner).catch(() => lostOwners.set(machine, [...lostOwners.get(machine) ?? [], owner]));
					}
					return opened;
				});
				machines.set(machine, pending);
				connecting.set(machine, connected);
				// A failed open removes only its own entries, never a replacement opened meanwhile.
				pending.catch(() => {
					if (machines.get(machine) === pending) machines.delete(machine);
					if (connecting.get(machine) === connected) connecting.delete(machine);
				});
			}
			return pending;
		};
		const dropMachine = async (machine: string, expected?: HerdrRunner) => {
			if (expected && machineRunners.get(machine) !== expected) return;
			const connected = connecting.get(machine);
			const stale = machineRunners.get(machine);
			machines.delete(machine);
			connecting.delete(machine);
			machineRunners.delete(machine);
			if (stale?.store.failed) lostOwners.set(machine, [...lostOwners.get(machine) ?? [], stale.owner]);
			// A channel still opening is closed once it opens, so shutdown never leaves an SSH process behind.
			// Closing does not wait for the protocol check, which a stalled channel never answers; it rejects it.
			const opened = await connected?.catch(() => undefined);
			await (opened && verified.has(opened) ? opened.close() : opened?.store.close())?.catch(() => undefined);
		};
		const remember = (machine: string) => {
			// Reload reopens the machines this session used, so their completion notices still arrive.
			if (recordedMachines.has(machine)) return;
			recordedMachines.add(machine);
			pi.appendEntry("herdr-remote-machine", { machine });
		};
		const route = async (agentId: string) => {
			const { id, machine } = splitAgentId(agentId);
			return { id, runner: machine ? await machineRunner(machine) : await getRunner() };
		};
		const remoteWorkspace = async (machine: string, source: HerdrRunner, cwd: string) => {
			let panes: HerdrAgentRef[] = [];
			try { panes = await source.client.listPanes(); }
			catch {}
			// Pi stops at a startup prompt when its session directory is missing, so check on the machine itself.
			const status = await source.store.directoryStatus(cwd);
			if (status === "relative") throw new Error(`machine_cwd ${cwd} is not an absolute path on ${machine}. Pass machine_cwd or configure machines.${machine}.cwd in ${join(deps.agentDir, "herdr-subagents.json")}.`);
			if (status === "missing") {
				const open = [...new Set(panes.flatMap((pane) => pane.cwd ? [pane.cwd] : []))].slice(0, 8);
				throw new Error(`Directory ${cwd} does not exist on ${machine}. Pass machine_cwd with the project's absolute path there.${open.length ? ` Herdr panes on ${machine} are open in: ${open.join(", ")}.` : ""}`);
			}
			// Reuse the workspace already open in that directory, so its tabs form the same grid.
			return panes.find((pane) => pane.cwd && samePath(pane.cwd, cwd))?.workspaceId;
		};
		let child: ChildSession | undefined;
		let stopped = false;
		/** Label writes in order, so a late one cannot restore a conversation this Pi has left. */
		let publication = Promise.resolve();
		const publish = (sessionFile: string | undefined, report: (error: unknown) => void = () => undefined) =>
			publication = publication.then(() => deps.client.publishSession?.(paneId, sessionFile)).catch(report);
		let tick: Promise<void> | undefined;
		/** Sessions started in this load; a retry for an earlier one begins nothing. */
		let sessions = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let initializing: Promise<void> | undefined;
		let receiptCursor = 0;
		let timer: ReturnType<typeof setInterval> | undefined;
		let streaming = false;
		let assistant = "";
		let outcome: "completed" | "aborted" | "error" = "completed";
		const messenger = {
			sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }) {
				pi.sendUserMessage(text, options);
			},
			abort() {},
			assistantText: () => assistant,
			streaming: () => streaming,
			clearAssistant() { assistant = ""; },
			checkpoint(ref: RunRef, event: ExecutionEvent) { pi.appendEntry("herdr-execution-checkpoint", { ref, event }); },
		};

		const backend = overrides.mode === "backend" ? createBackendController({
			machineGuidance: savedMachines,
			assertActive() { if (stopped) throw new Error("Herdr backend is shut down"); },
			paneChild: () => child !== undefined,
			async route(agentId) {
				if (stopped) throw new Error("Herdr backend is shut down");
				let target = await route(agentId);
				if (target.runner.machine) {
					remember(target.runner.machine);
					if (target.runner.store.failed) {
						await dropMachine(target.runner.machine, target.runner);
						if (stopped) throw new Error("Herdr backend is shut down");
						target = await route(agentId);
					}
				}
				return target;
			},
			async caller(ctx, current, cwd) {
				return {
					paneId: parentKey(current.machine), tabId: current.machine ? undefined : localTab,
					workspaceId: current.machine ? await remoteWorkspace(current.machine, current, cwd) : localWorkspace,
					sessionFile: ctx.sessionManager.getSessionFile(),
				};
			},
			async spawn(request, ctx, signal) {
				if (!request.resume && request.runtime === "claude-code" && request.machine?.trim()) throw new Error("Claude Code subagents currently support local Herdr panes only.");
				const target = request.resume ? await route(request.resume) : undefined;
				const machine = target ? target.runner.machine : request.machine?.trim() || undefined;
				if (machine && request.inheritContext) throw new Error("inherit_context cannot clone this session onto another machine.");
				const current = target?.runner ?? (machine ? await machineRunner(machine) : await getRunner());
				const cwd = machine ? request.machineCwd?.trim() || machineDefaultCwd(machine, profiles, settings.machines) || ctx.cwd : request.cwd || ctx.cwd;
				if (machine) remember(machine);
				const ref = target ? await current.resume(target.id, request.prompt, signal, request.runInBackground, {
					paneId: parentKey(machine), tabId: machine ? undefined : localTab,
					workspaceId: machine ? await remoteWorkspace(machine, current, (await current.resolve(target.id)).cwd ?? cwd) : localWorkspace,
					sessionFile: ctx.sessionManager.getSessionFile(),
				}) : await current.spawn({
					...request, cwd, definitionsCwd: ctx.cwd, paneId: parentKey(machine),
					tabId: machine ? undefined : localTab,
					workspaceId: machine ? await remoteWorkspace(machine, current, cwd) : localWorkspace,
					sessionFile: ctx.sessionManager.getSessionFile(), agentDir: deps.agentDir,
					projectTrusted: ctx.isProjectTrusted(),
				}, signal);
				return { ...ref, runner: current };
			},
			content: completionNotice,
		}) : undefined;

		if (!backend) {
		pi.registerTool(defineTool({
			name: "Agent",
			label: "Agent",
			description: EXPLICIT_SUBAGENT_REQUEST + "\n\nLaunch a subagent as its own Pi (default) or Claude Code process in a Herdr pane. Set runtime to claude-code only when the user requests Claude Code. Claude Code supports local Windows/Linux/macOS panes, normal permissions, results, and resume; live steering and max_turns are unsupported, and Stop closes its pane. Background by default. Use get_subagent_result for the outcome and steer_subagent to redirect a running agent. Reuse the same subagent for follow-up work on that thread: steer_subagent while it is running, or resume after it has finished. Start a new Agent only for new work. A blocked agent returns immediately and stays open in its pane. Results are limited to 2000 lines or 50KB; full output remains in the pane. Keep inherit_context false; the orchestrating agent must provide all needed context in the prompt. schedule and isolation are not available here. Set machine only when the user asks to run the agent on a saved Herdr SSH machine; its agent ID then ends in @<machine>." + savedMachines,
			parameters: Type.Object({
				runtime: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude-code")], { description: "Default pi. Use claude-code only when the user requests Claude Code. Ignored with resume, which preserves the original runtime." })),
				prompt: Type.String({ description: "The task for the agent to perform." }),
				description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
				name: Type.Optional(Type.String({ description: "Optional memorable name, letters, digits, underscores, and hyphens." })),
				subagent_type: Type.String({ description: "Agent type. A matching .pi/agents or user agent file supplies its prompt and tool list." }),
				model: Type.Optional(Type.String({ description: "Optional model override. Pi accepts provider/modelId or a fuzzy name; Claude Code uses native names such as sonnet or opus." })),
				thinking: Type.Optional(Type.String({ description: "Pi thinking: off, minimal, low, medium, high, xhigh, max. Claude Code effort: low, medium, high, xhigh, max (model-dependent)." })),
				max_turns: Type.Optional(Type.Number({ description: "Maximum turns before stopping. Omit for unlimited.", minimum: 1 })),
				run_in_background: Type.Optional(Type.Boolean({ description: "Defaults to true. Set false to wait for the result, or for blocked." })),
				resume: Type.Optional(Type.String({ description: "Agent ID to resume after its current run has finished." })),
				isolated: Type.Optional(Type.Boolean({ description: "If true, the child may use only built-in tools." })),
				keep: Type.Optional(Type.Boolean({ description: "Keep this agent's pane open after it finishes. Overrides agent-file keep; preserved on resume. Owner disappearance still closes it." })),
				inherit_context: Type.Optional(Type.Boolean({ description: "Must remain false. The orchestrating agent provides all needed context in the prompt." })),
				machine: Type.Optional(Type.String({ description: "Saved Herdr SSH machine (label or profile ID) to run on. Only when the user asks. Ignored with resume; the agent ID names its machine." })),
				machine_cwd: Type.Optional(Type.String({ description: "Absolute working directory on that machine, such as C:/git/project on Windows. Overrides the per-machine cwd in the user agent directory's herdr-subagents.json; otherwise defaults to this session's directory." })),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				if (!params.resume && params.runtime === "claude-code" && params.machine?.trim()) throw new Error("Claude Code subagents currently support local Herdr panes only.");
				const target = params.resume ? await route(params.resume) : undefined;
				const machine = target ? target.runner.machine : params.machine?.trim() || undefined;
				if (machine && params.inherit_context) throw new Error("inherit_context cannot clone this session onto another machine.");
				const current = target?.runner ?? (machine ? await machineRunner(machine) : await getRunner());
				const cwd = machine ? params.machine_cwd?.trim() || machineDefaultCwd(machine, profiles, settings.machines) || ctx.cwd : ctx.cwd;
				const request: SpawnRequest = {
					runtime: params.runtime,
					prompt: params.prompt,
					description: params.description,
					name: params.name,
					subagentType: params.subagent_type,
					model: params.model,
					thinking: params.thinking,
					maxTurns: params.max_turns,
					runInBackground: params.run_in_background !== false,
					resume: target?.id,
					isolated: params.isolated,
					keep: params.keep,
					projectTrusted: ctx.isProjectTrusted(),
					inheritContext: params.inherit_context,
					cwd,
					definitionsCwd: ctx.cwd,
					paneId: parentKey(machine),
					// The caller's tab and workspace are local; remote agents fill grid tabs on that machine.
					tabId: machine ? undefined : localTab,
					workspaceId: !machine ? localWorkspace : await remoteWorkspace(machine, current, target ? (await current.resolve(target.id)).cwd ?? cwd : cwd),
					sessionFile: ctx.sessionManager.getSessionFile(),
					agentDir: deps.agentDir,
				};
				// Record the machine first: a launch that loses its channel must still be reconnected and its owner retired.
				if (machine) remember(machine);
				const result = await spawnHerdrAgent(request, { ...deps, signal, runner: current });
				return toolResult(result);
			},
		}));

		pi.registerTool(defineTool({
			name: "get_subagent_result",
			label: "Get Agent Result",
			description: "Check status and retrieve a Herdr subagent's result. Use the agent ID returned by Agent. wait: true waits until it finishes or blocks. After the result, resume that same agent for follow-up work instead of starting a new one. Results are limited to 2000 lines or 50KB; full output remains in the pane.",
			promptSnippet: "Check status and retrieve results from a background agent",
			parameters: Type.Object({
				agent_id: Type.String({ description: "The agent ID returned by Agent, or the name given at spawn." }),
				run_id: Type.Optional(Type.String({ description: "A run ID from Agent or a completion notice. Omit to capture the agent's current run." })),
				wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete or block. Default: false." })),
				verbose: Type.Optional(Type.Boolean({ description: "If true, note that the full conversation is in the Herdr pane. Default: false." })),
			}),
			execute: async (_toolCallId, params, signal) => {
				const { id, runner: current } = await route(params.agent_id);
				const result = await readHerdrAgent(deps.root, id, { wait: params.wait, verbose: params.verbose, runId: params.run_id }, { ...deps, signal, runner: current });
				return toolResult(result);
			},
		}));

		pi.registerTool(defineTool({
			name: "steer_subagent",
			label: "Steer Agent",
			description: "Send a steering message to a running Herdr subagent. Use this for follow-up work on the same thread instead of starting another agent. It is delivered after the current tool execution. Only works while that Pi pane is still running. Claude Code does not support live steering; wait for completion and use Agent with resume.",
			promptSnippet: "Send a steering message to redirect a running background agent",
			parameters: Type.Object({
				agent_id: Type.String({ description: "The agent ID to steer." }),
				message: Type.String({ description: "The steering message. It appears as a user message in the child." }),
			}),
			execute: async (_toolCallId, params) => {
				const { id, runner: current } = await route(params.agent_id);
				const result = await steerHerdrAgent(deps.root, id, params.message, { ...deps, runner: current });
				return toolResult(result);
			},
		}));

		}

		pi.on("session_start", async (_event, ctx) => {
			stopped = false;
			backend?.reset();
			streaming = !ctx.isIdle();
			queuedNotices.clear();
			recordedMachines.clear();
			pendingReceipts.clear();
			receiptCursor = 0;
			messenger.abort = () => { void ctx.abort(); };
			const generation = ++sessions;
			const live = () => !stopped && generation === sessions;
			let lastFailure: string | undefined;
			let answering = false;
			// hc tags its records by the core's id. Until that answers, nothing is maintained; identification is retried with
			// backoff while this session lasts, and the session's coordination begins once it succeeds.
			// Every failure, including a store that cannot open, is reported and retried; this never rejects.
			const initialize = async (attempt: number): Promise<void> => {
				let current: HerdrRunner | undefined;
				try {
					current = await getRunner();
					if (live()) await begin(current);
					return;
				} catch (error) {
					// Herdr's runner opens synchronously, so its setup failures reach Pi as before.
					if (!hc) throw error;
					await abandon(current);
					if (!live()) return;
					const message = error instanceof Error ? error.message : String(error);
					if (message !== lastFailure) ctx.ui.notify(`Herdr coordination: ${message}`, "error");
					lastFailure = message;
					retry = setTimeout(() => { retry = undefined; initializing = initialize(attempt + 1); }, Math.min(POLL_MS * 2 ** attempt, 5000));
					retry.unref();
				}
			};
			/** A failed start leaves nothing behind: its child binding, timer, and a runner whose store may not have opened. */
			const abandon = async (failed: HerdrRunner | undefined) => {
				if (timer) clearInterval(timer);
				timer = undefined;
				await child?.dispose().catch(() => undefined);
				child = undefined;
				if (failed && runner === failed) {
					runner = undefined;
					await failed.close().catch(() => undefined);
				}
			};
			const begin = async (current: HerdrRunner) => {
				const entries = ctx.sessionManager.getEntries();
				let checkpoint: ChildIdentity["checkpoint"];
				for (const entry of entries) {
					if (entry.type === "custom" && entry.customType === "herdr-execution-checkpoint") checkpoint = entry.data as ChildIdentity["checkpoint"];
					const used = entry.type === "custom" && entry.customType === "herdr-remote-machine" ? (entry.data as { machine?: unknown } | undefined)?.machine : undefined;
					if (typeof used === "string") recordedMachines.add(used);
				}
				const messages = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
				assistant = messages.map(assistantText).filter(Boolean).at(-1) ?? "";
				outcome = runOutcome(messages);
				const identity = { sessionFile: ctx.sessionManager.getSessionFile() ?? "", sessionId: ctx.sessionManager.getSessionId(), checkpoint };
				const attachChild = async () => {
					child = await createChildSession(current.store, paneId, identity, messenger);
					if (child && !answering) { answering = true; registerNeedsAnswer(); }
				};
				const registerNeedsAnswer = () => pi.registerTool(defineTool({
					name: "needs_answer",
					label: "Needs answer",
					description: "End this run immediately with one concrete question and the current work state. The parent can reply with SendMessage to resume this same agent.",
					parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
					async execute(_id, { question }) {
						if (!child) throw new Error("Not a Herdr child session.");
						await child.needsAnswer(question);
						return { content: [{ type: "text", text: question }], details: undefined, terminate: true };
					},
				}));
				await attachChild();
				// hc starts a subagent's Pi before its runner records the terminal, so the first attach can come too early.
				const attachUntil = hc && !child && paneId ? deps.now() + 15_000 : 0;
				if (timer) clearInterval(timer);
				/** The last error per source ("" for this machine), so failing machines never alternate past deduplication. */
				const lastErrors = new Map<string, string>();
				const health = new Map<HerdrRunner, Promise<void>>();
				// Each machine polls on its own, so a stalled SSH call never delays local coordination or other machines.
				const machinePolls = new Map<string, Promise<void>>();
				const reconnectAt = new Map<string, number>();
				const reportError = (error: unknown, source = "") => {
					const message = error instanceof Error ? error.message : String(error);
					if (!stopped && message !== lastErrors.get(source)) ctx.ui.notify(`Herdr coordination: ${message}`, "error");
					lastErrors.set(source, message);
				};
				const deliver = async (source: HerdrRunner) => {
					if (stopped) return;
					const ownerSession = ctx.sessionManager.getSessionFile();
					const ownerMachine = source.machine ? current.machineId : undefined;
					if (backend) return backend.deliver(source, parentKey(source.machine), ownerSession, ownerMachine);
					for (const notice of await source.store.notices(parentKey(source.machine), ownerSession, ownerMachine)) {
						if (stopped || queuedNotices.has(notice.id)) continue;
						pi.sendMessage({
							customType: "herdr-subagent-notification", content: completionNotice(notice, source.machine), display: true,
							details: { noticeId: notice.id, agentId: qualifiedAgentId(notice.agentId, source.machine), runId: notice.runId, machine: source.machine },
						}, { deliverAs: "steer", triggerTurn: true });
						queuedNotices.add(notice.id);
					}
				};
				const poll = async () => {
					if (!child && attachUntil > deps.now()) await attachChild();
					await child?.poll();
					if (stopped) return;
					// Reopen machines this session used. A lost SSH channel is retried every ten seconds, not every tick.
					for (const machine of recordedMachines) {
						if (machines.has(machine) || (reconnectAt.get(machine) ?? 0) > deps.now()) continue;
						reconnectAt.set(machine, deps.now() + 10_000);
						// A machine that reconnects reports its next failure again.
						machineRunner(machine).then(() => lastErrors.delete(machine), (error) => reportError(error, machine));
					}
					// Slow Herdr calls must not delay the child's command/cancellation polling.
					for (const source of [current, ...machineRunners.values()]) {
						if (!health.has(source)) health.set(source, source.maintain().catch((error) => reportError(error, source.machine ?? "")).finally(() => health.delete(source)));
					}
					// A sendMessage call may only queue a message. Acknowledge only evidence actually in Pi's session.
					const saved = ctx.sessionManager.getEntries();
					for (const entry of backend ? [] : saved.slice(receiptCursor)) {
						if (entry.type !== "custom_message" || entry.customType !== "herdr-subagent-notification") continue;
						const details = entry.details as { noticeId?: string; machine?: string } | undefined;
						if (details?.noticeId) pendingReceipts.set(details.noticeId, details.machine ?? "");
					}
					receiptCursor = saved.length;
					for (const [machine, source] of machineRunners) {
						if (machinePolls.has(machine)) continue;
						machinePolls.set(machine, pollMachine(machine, source).finally(() => machinePolls.delete(machine)));
					}
					await acknowledge("", current);
					await deliver(current);
				};
				const acknowledge = async (machine: string, source: HerdrRunner) => {
					for (const [noticeId, owner] of pendingReceipts) {
						if (owner !== machine) continue;
						await source.store.acknowledgeNotice(noticeId);
						pendingReceipts.delete(noticeId);
						queuedNotices.delete(noticeId);
					}
				};
				const pollMachine = async (machine: string, source: HerdrRunner) => {
					try {
						await acknowledge(machine, source);
						await deliver(source);
					} catch (error) {
						reportError(new Error(`${machine}: ${error instanceof Error ? error.message : String(error)}`), machine);
						if (source.store.failed) await dropMachine(machine);
					}
				};
				// The app cannot see which conversation a Pi runs; its subagents' runners read it from this terminal's labels.
				if (hc && paneId) publish(identity.sessionFile || undefined, reportError);
				timer = setInterval(() => {
					if (stopped || tick) return;
					tick = poll().catch((error) => reportError(error)).finally(() => { tick = undefined; });
				}, POLL_MS);
				timer.unref();
			};
			await (initializing = initialize(0));
		});
		pi.on("session_shutdown", async (event) => {
			stopped = true;
			if (retry) clearTimeout(retry);
			retry = undefined;
			// A retry already identifying finishes first, and then begins nothing.
			await initializing?.catch(() => undefined);
			if (timer) clearInterval(timer);
			timer = undefined;
			await tick;
			if (hc && paneId) await publish(undefined);
			if (event?.reason !== "reload") await child?.noteExit();
			await child?.dispose();
			child = undefined;
			await opening?.catch(() => undefined);
			await runner?.close();
			runner = undefined;
			for (const machine of new Set([...machines.keys(), ...connecting.keys()])) await dropMachine(machine);
		});
		pi.on("input", (event) => child?.input(event.text));
		pi.on("agent_start", async () => {
			streaming = true;
			outcome = "completed";
			await child?.noteLive();
		});
		pi.on("agent_end", (event) => {
			outcome = runOutcome(event.messages);
		});
		pi.on("agent_settled", async () => {
			streaming = false;
			await child?.noteSettled(outcome);
		});
		pi.on("ui_prompt_start", () => child?.noteStatus("blocked"));
		pi.on("ui_prompt_end", () => child?.noteStatus("running"));
		pi.on("turn_end", () => child?.noteTurn());
		pi.on("message_end", (event) => {
			const text = assistantText(event.message);
			if (text) assistant = text;
		});
		// Filter only the current declarations: never activate deferred/codemode tools just because they are allowed.
		pi.on("before_agent_start", () => {
			if (child) pi.setActiveTools(pi.getActiveTools().filter((name) => child!.allows(name)));
		});
		pi.on("tool_call", (event) => {
			if (!child || child.allows(event.toolName)) return;
			return { block: true, reason: "This subagent is not allowed to use that tool." };
		});
		if (backend) overrides.onBackend?.(backend.handle);
	};
}

async function assertRemoteProtocol(store: HerdrStore, machine: string): Promise<void> {
	const update = (side: string) => `Update herdr-subagents (or the Grok package that includes it) on ${side} so both match, then retry.`;
	const remote = await store.remoteProtocol().catch((error: Error) => {
		// Packages before the handshake lack the operation, so this is the one error text worth matching.
		if (/Unknown Herdr control operation/.test(error.message)) throw new Error(`${machine} runs an older Herdr subagent runner. ${update(machine)}`);
		throw error;
	});
	if (remote !== HERDR_REMOTE_PROTOCOL) {
		throw new Error(`${machine} speaks remote protocol ${remote}; this machine speaks ${HERDR_REMOTE_PROTOCOL}. ${update(remote < HERDR_REMOTE_PROTOCOL ? machine : "this machine")}`);
	}
}

/** Herdr reports Windows directories with backslashes; machine_cwd may use either separator. POSIX paths compare exactly. */
export function samePath(a: string, b: string): boolean {
	const windows = (path: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);
	// Either side naming a drive or share means the machine is Windows, so both compare by Windows rules.
	const normal = windows(a) || windows(b)
		? (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
		: (path: string) => path.replace(/(.)\/+$/, "$1");
	return normal(a) === normal(b);
}

function toolResult(result: ToolText) {
	if (result.details.status === "error") throw new Error(result.text);
	const limited = truncateHead(result.text);
	const text = limited.truncated
		? `${limited.content}\n\n[Output limited to 2000 lines or 50KB. Full conversation is in Herdr pane ${result.details.paneId ?? "shown in the result"}.]`
		: result.text;
	return { content: [{ type: "text" as const, text }], details: result.details };
}

function runOutcome(messages: unknown): "completed" | "aborted" | "error" {
	if (!Array.isArray(messages)) return "completed";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") continue;
		const reason = (message as { stopReason?: string }).stopReason;
		if (reason === "error") return "error";
		if (reason === "aborted") return "aborted";
		return "completed";
	}
	return "completed";
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const record = message as { role?: string; content?: unknown };
	if (record.role && record.role !== "assistant") return "";
	if (typeof record.content === "string") return record.content;
	if (!Array.isArray(record.content)) return "";
	return record.content.map((block: unknown) => {
		if (!block || typeof block !== "object") return "";
		const text = (block as { type?: string; text?: string }).text;
		return (block as { type?: string }).type === "text" && typeof text === "string" ? text : "";
	}).filter(Boolean).join("\n");
}
