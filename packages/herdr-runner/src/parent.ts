import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrCli, findHerdrMachine, herdrSessionName, listHerdrMachines, pickHerdrMachine, type HerdrAgentRef, type HerdrClient, type HerdrExec, type HerdrMachine } from "./client.ts";
import { HerdrRunner, splitAgentId, type ResumeCaller } from "./runner.ts";
import { machineDefaultCwd, machineWorkerEntry, readHerdrSettings, type HerdrSettings } from "./config.ts";
import { HERDR_REMOTE_PROTOCOL, herdrSubagentRoot, sshChannel, type HerdrStore, type StoreChannelFactory } from "./store.ts";
import { createHcCli, hcConnect, hcSessionTag, listHcMachines } from "./hc.ts";
import { hostPaneId, terminalHost, type TerminalHost } from "./host.ts";

export interface ParentDeps {
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
	/** Saved SSH machines. Read once per parent, so a reload refreshes it. */
	listMachines: () => Promise<HerdrMachine[]>;
}

export interface ParentOptions extends Partial<ParentDeps> {
	/** Defaults to the host this process runs in, else herdr. */
	host?: TerminalHost;
	/** The worker a saved machine runs when neither its settings nor the environment name one. */
	defaultWorkerEntry?: string;
}

/** Pi's agent directory, where herdr-subagents.json and user agent definitions live. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

/** New overrides name the standalone root; legacy overrides name a Grok root with a forwarding entry. */
export function remoteWorkerEntry(env: NodeJS.ProcessEnv, fallback = fileURLToPath(new URL("./worker-entry.mjs", import.meta.url))): string {
	const pkg = (env.HERDR_SUBAGENTS_REMOTE_PACKAGE || env.GROK_HERDR_REMOTE_PACKAGE)?.replace(/\/+$/, "");
	return pkg ? `${pkg}/src/herdr/worker-entry.mjs` : fallback;
}

/** Names the enabled saved machines so a model can map "the laptop" to a selector without asking. */
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

/** Herdr reports Windows directories with backslashes; machine_cwd may use either separator. POSIX paths compare exactly. */
export function samePath(a: string, b: string): boolean {
	const windows = (path: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);
	// Either side naming a drive or share means the machine is Windows, so both compare by Windows rules.
	const normal = windows(a) || windows(b)
		? (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
		: (path: string) => path.replace(/(.)\/+$/, "$1");
	return normal(a) === normal(b);
}

/** One maintenance pass's hooks: what the front-end delivers and acknowledges for each source. */
export interface ParentTick {
	/** Acknowledge saved receipts, then deliver this source's unacknowledged notices. */
	service(machine: string, source: HerdrRunner): Promise<void>;
	reportError(error: unknown, source: string): void;
	/** A machine reopened; its next failure is news again. */
	recovered?(source: string): void;
}

/**
 * The parent side every front-end shares: one runner for this host and one per saved machine (each with its own SSH
 * store channel), agent-ID routing, caller placement, and maintenance. The front-end supplies its identity,
 * delivery and receipts.
 */
export class HerdrParent {
	readonly deps: ParentDeps;
	readonly hc: boolean;
	/** This process's pane or terminal, empty outside one. */
	readonly paneId: string;
	/** App terminals have no tab or workspace; their subagents nest under them. */
	readonly localTab: string | undefined;
	readonly localWorkspace: string | undefined;
	readonly settings: HerdrSettings;
	profiles: HerdrMachine[] = [];
	/** Machines this parent used; their notices are polled and their channels reopened. */
	readonly recordedMachines = new Set<string>();
	/** Called once per newly used machine, so a front-end can persist it across reloads. */
	onRemember?: (machine: string) => void;
	stopped = false;
	private readonly defaultWorkerEntry?: string;
	private readonly hcCall: ReturnType<typeof hcConnect>;
	private runner?: HerdrRunner;
	private opening?: Promise<HerdrRunner>;
	private readonly machines = new Map<string, Promise<HerdrRunner>>();
	private readonly machineRunners = new Map<string, HerdrRunner>();
	/** Each machine's runner once its channel opens, before its protocol check settles. */
	private readonly connecting = new Map<string, Promise<HerdrRunner>>();
	/** Runners whose protocol matched. Only these may send store calls, including owner retirement on close. */
	private readonly verified = new WeakSet<HerdrRunner>();
	/** Owners whose channel dropped. A reconnect retires them so the machine can recover their launches. */
	private readonly lostOwners = new Map<string, string[]>();
	private readonly health = new Map<HerdrRunner, Promise<void>>();
	/** Each machine polls on its own, so a stalled SSH call never delays local coordination or other machines. */
	private readonly machinePolls = new Map<string, Promise<void>>();
	private readonly reconnectAt = new Map<string, number>();

	constructor(options: ParentOptions = {}) {
		const env = options.env ?? process.env;
		this.hc = (options.host ?? terminalHost(env) ?? "herdr") === "hc";
		const hc = this.hc;
		this.hcCall = hcConnect(env);
		const hcCall = this.hcCall;
		this.defaultWorkerEntry = options.defaultWorkerEntry;
		this.deps = {
			env,
			root: options.root ?? herdrSubagentRoot(env),
			client: options.client ?? (hc ? createHcCli(env, { call: hcCall }) : createHerdrCli(env)),
			agentDir: options.agentDir ?? defaultAgentDir(env),
			sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			now: options.now ?? Date.now,
			machineClient: options.machineClient ?? ((machine, exec) => hc
				? createHcCli(env, { machine, call: hcCall })
				: createHerdrCli(env, undefined, machine, undefined, exec)),
			machineChannel: options.machineChannel ?? (async (machine, workerEntry) => sshChannel({
				target: (await this.findMachine(machine)).target,
				node: env.HERDR_SUBAGENTS_REMOTE_NODE || env.GROK_HERDR_REMOTE_NODE,
				entry: workerEntry ?? remoteWorkerEntry(env, this.defaultWorkerEntry),
			})),
			hostname: options.hostname ?? hostname(),
			// Older Herdr has no saved machines, and an unavailable listing only leaves them unnamed.
			listMachines: options.listMachines ?? (() => (hc ? listHcMachines(hcCall, 2500) : listHerdrMachines(env, 2500)).catch(() => [])),
		};
		this.paneId = hostPaneId(this.deps.env, hc ? "hc" : "herdr");
		this.localTab = hc ? undefined : this.deps.env.HERDR_TAB_ID;
		this.localWorkspace = hc ? undefined : this.deps.env.HERDR_WORKSPACE_ID;
		this.settings = readHerdrSettings(this.deps.agentDir);
	}

	/** Reads the saved machines; call once before routing to machines. */
	async load(): Promise<void> {
		this.profiles = await this.deps.listMachines().catch(() => []);
	}

	/** Saved machines of this host, selected by profile ID or unique label. */
	async findMachine(selector: string): Promise<HerdrMachine> {
		if (!this.hc) return findHerdrMachine(selector, this.deps.env);
		const machine = pickHerdrMachine(await listHcMachines(this.hcCall), selector);
		if (!machine) throw new Error(`Unknown hc machine '${selector}'. Add it with hc machine add, then check hc machine ls.`);
		return machine;
	}

	/** Remote stores key notices by this pane; a bare pane ID could name one of that machine's own panes. */
	parentKey(machine?: string): string {
		return machine && this.paneId ? `${this.deps.hostname}/${this.paneId}` : this.paneId;
	}

	machineCwd(machine: string, requested?: string): string | undefined {
		return requested?.trim() || machineDefaultCwd(machine, this.profiles, this.settings.machines);
	}

	/** hc records are tagged by the core this client reaches; without its id, no runner opens and nothing is maintained. */
	private async hostSession(client: HerdrClient): Promise<string> {
		if (!client.hostId) throw new Error("This hc client cannot identify its core.");
		return hcSessionTag(await client.hostId());
	}

	local(): Promise<HerdrRunner> {
		return this.runner ? Promise.resolve(this.runner) : (this.opening ??= (async () => {
			const herdrSession = this.hc ? await this.hostSession(this.deps.client) : herdrSessionName(this.deps.env);
			return this.runner = new HerdrRunner({ ...this.deps, closeWhenDone: this.settings.closeWhenDone, herdrSession });
		})().finally(() => { this.opening = undefined; }));
	}

	/** One runner, and one SSH store channel, per saved machine used by this parent. */
	machine(machine: string): Promise<HerdrRunner> {
		let pending = this.machines.get(machine);
		if (pending) return pending;
		const { deps, hc, profiles, settings } = this;
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
		const connected = hcClient ? this.hostSession(hcClient).then((tag) => open(tag, hcClient)) : open(session);
		pending = connected.then(async (opened) => {
			// Refuse a mismatched package before any launch or owner retirement runs on that store.
			// An unverified store is closed without retiring anything: its operations are not established.
			try { await assertRemoteProtocol(opened.store, machine); }
			catch (error) { await opened.store.close().catch(() => undefined); throw error; }
			this.verified.add(opened);
			// Shutdown or a reconnect replaced this open while it was checked; it must not outlive them untracked.
			if (this.machines.get(machine) !== pending) {
				await opened.close().catch(() => undefined);
				throw new Error(`${machine}: connection closed`);
			}
			this.machineRunners.set(machine, opened);
			// Retire in the background: a stalled call must not hold the open, which shutdown awaits.
			// An owner that could not be retired is kept for the next reconnect.
			const lost = this.lostOwners.get(machine) ?? [];
			this.lostOwners.delete(machine);
			for (const owner of lost) {
				opened.store.retireOwner(owner).catch(() => this.lostOwners.set(machine, [...this.lostOwners.get(machine) ?? [], owner]));
			}
			return opened;
		});
		this.machines.set(machine, pending);
		this.connecting.set(machine, connected);
		// A failed open removes only its own entries, never a replacement opened meanwhile.
		const own = pending;
		own.catch(() => {
			if (this.machines.get(machine) === own) this.machines.delete(machine);
			if (this.connecting.get(machine) === connected) this.connecting.delete(machine);
		});
		return own;
	}

	async dropMachine(machine: string, expected?: HerdrRunner): Promise<void> {
		if (expected && this.machineRunners.get(machine) !== expected) return;
		const connected = this.connecting.get(machine);
		const stale = this.machineRunners.get(machine);
		this.machines.delete(machine);
		this.connecting.delete(machine);
		this.machineRunners.delete(machine);
		if (stale?.store.failed) this.lostOwners.set(machine, [...this.lostOwners.get(machine) ?? [], stale.owner]);
		// A channel still opening is closed once it opens, so shutdown never leaves an SSH process behind.
		// Closing does not wait for the protocol check, which a stalled channel never answers; it rejects it.
		const opened = await connected?.catch(() => undefined);
		await (opened && this.verified.has(opened) ? opened.close() : opened?.store.close())?.catch(() => undefined);
	}

	/** Reopening the machines this parent used keeps their completion notices arriving. */
	remember(machine: string): void {
		if (this.recordedMachines.has(machine)) return;
		this.recordedMachines.add(machine);
		this.onRemember?.(machine);
	}

	async route(agentId: string): Promise<{ id: string; runner: HerdrRunner }> {
		const { id, machine } = splitAgentId(agentId);
		return { id, runner: machine ? await this.machine(machine) : await this.local() };
	}

	/** Routing that remembers the machine and reopens a failed channel once. */
	async routeLive(agentId: string): Promise<{ id: string; runner: HerdrRunner }> {
		this.assertActive();
		let target = await this.route(agentId);
		if (target.runner.machine) {
			this.remember(target.runner.machine);
			if (target.runner.store.failed) {
				await this.dropMachine(target.runner.machine, target.runner);
				this.assertActive();
				target = await this.route(agentId);
			}
		}
		return target;
	}

	assertActive(): void {
		if (this.stopped) throw new Error("Herdr backend is shut down");
	}

	async remoteWorkspace(machine: string, source: HerdrRunner, cwd: string): Promise<string | undefined> {
		let panes: HerdrAgentRef[] = [];
		try { panes = await source.client.listPanes(); }
		catch {}
		// Pi stops at a startup prompt when its session directory is missing, so check on the machine itself.
		const status = await source.store.directoryStatus(cwd);
		if (status === "relative") throw new Error(`machine_cwd ${cwd} is not an absolute path on ${machine}. Pass machine_cwd or configure machines.${machine}.cwd in ${join(this.deps.agentDir, "herdr-subagents.json")}.`);
		if (status === "missing") {
			const open = [...new Set(panes.flatMap((pane) => pane.cwd ? [pane.cwd] : []))].slice(0, 8);
			throw new Error(`Directory ${cwd} does not exist on ${machine}. Pass machine_cwd with the project's absolute path there.${open.length ? ` Herdr panes on ${machine} are open in: ${open.join(", ")}.` : ""}`);
		}
		// Reuse the workspace already open in that directory, so its tabs form the same grid.
		return panes.find((pane) => pane.cwd && samePath(pane.cwd, cwd))?.workspaceId;
	}

	/** Placement and ownership for a call on `runner`; remote agents fill grid tabs on that machine. */
	async caller(runner: HerdrRunner, cwd: string, sessionFile: string | undefined): Promise<ResumeCaller> {
		const machine = runner.machine;
		return {
			paneId: this.parentKey(machine),
			tabId: machine ? undefined : this.localTab,
			workspaceId: machine ? await this.remoteWorkspace(machine, runner, cwd) : this.localWorkspace,
			sessionFile,
		};
	}

	/** Machine runners currently open. */
	openMachines(): Map<string, HerdrRunner> { return this.machineRunners; }

	/**
	 * One maintenance pass: reopen used machines, run lifecycle maintenance per source, and service each source's
	 * notices. Slow Herdr calls and stalled machines never delay the local source.
	 */
	async tick(local: HerdrRunner, hooks: ParentTick): Promise<void> {
		// Reopen machines this parent used. A lost SSH channel is retried every ten seconds, not every tick.
		for (const machine of this.recordedMachines) {
			if (this.machines.has(machine) || (this.reconnectAt.get(machine) ?? 0) > this.deps.now()) continue;
			this.reconnectAt.set(machine, this.deps.now() + 10_000);
			// A machine that reconnects reports its next failure again.
			this.machine(machine).then(() => hooks.recovered?.(machine), (error) => hooks.reportError(error, machine));
		}
		for (const source of [local, ...this.machineRunners.values()]) {
			if (!this.health.has(source)) this.health.set(source, source.maintain().catch((error) => hooks.reportError(error, source.machine ?? "")).finally(() => this.health.delete(source)));
		}
		for (const [machine, source] of this.machineRunners) {
			if (this.machinePolls.has(machine)) continue;
			this.machinePolls.set(machine, (async () => {
				try { await hooks.service(machine, source); }
				catch (error) {
					hooks.reportError(new Error(`${machine}: ${error instanceof Error ? error.message : String(error)}`), machine);
					if (source.store.failed) await this.dropMachine(machine);
				}
			})().finally(() => this.machinePolls.delete(machine)));
		}
		await hooks.service("", local);
	}

	/** Forgets the local runner after a failed start, closing it. */
	async abandon(failed: HerdrRunner | undefined): Promise<void> {
		if (failed && this.runner === failed) {
			this.runner = undefined;
			await failed.close().catch(() => undefined);
		}
	}

	async close(): Promise<void> {
		this.stopped = true;
		await this.opening?.catch(() => undefined);
		await this.runner?.close();
		this.runner = undefined;
		for (const machine of new Set([...this.machines.keys(), ...this.connecting.keys()])) await this.dropMachine(machine);
	}

	/** Resets per-session state when a front-end's session restarts. */
	restart(): void {
		this.stopped = false;
		this.recordedMachines.clear();
		this.reconnectAt.clear();
	}
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
