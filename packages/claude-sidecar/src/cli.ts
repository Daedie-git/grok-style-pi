// The sidecar launcher's runner front-end: Claude Code owns persistent Pi or Claude Code sidecars that herdr-runner
// launches, supervises and resumes. scripts/sidecar delegates here when SIDECAR_RUNNER=1.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HerdrParent, type ParentOptions } from "../herdr-runner/src/parent.ts";
import { qualifiedAgentId, type HerdrRunner, type SpawnRequest } from "../herdr-runner/src/runner.ts";
import { isTerminal, type RunRef, type RunSnapshot } from "../herdr-runner/src/state.ts";
import { answerPrompt, claudeQuestion, notePrompt, roleInstructions } from "./prompts.ts";
import { ROLES, SlotState, ownerName, requestId, slotName, stateDir, type Backend, type Role, type SlotRecord } from "./state.ts";

/** Exit codes shared with the Bash launcher and the plugin's job messages. */
export const EXIT = { report: 0, failed: 1, noReport: 2, question: 3, duplicate: 4, blocked: 5, busy: 7 } as const;

/** Commands this front-end runs; the others stay with the Bash launcher. */
export const RUNNER_COMMANDS = new Set(["ask", "answer", "note", "steer", "status", "report", "stop", "wait", "maintain"]);

export interface Io {
	stdout(text: string): void;
	stderr(text: string): void;
	stdin(): Promise<string>;
}

export interface CliOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	parent?: ParentOptions;
	/** Starts the detached pass that closes finished panes after a request returns. */
	maintainLater?: () => void;
	/** Interval of "still working" lines on stderr. */
	progressMs?: number;
	pollMs?: number;
	/** How long `maintain` keeps panes under supervision. */
	maintainMs?: number;
}

interface Globals { slot: string; role?: Role; agent?: Backend; machine?: string; remoteCwd?: string }

class UsageError extends Error {}

function parse(argv: string[]): { globals: Globals; command: string; rest: string[] } {
	const globals: Globals = { slot: "1" };
	let i = 0;
	for (; i < argv.length && argv[i].startsWith("--"); i += 2) {
		const value = argv[i + 1];
		if (value === undefined) throw new UsageError(`${argv[i]} needs a value`);
		switch (argv[i]) {
			case "--slot": if (!/^\d+$/.test(value)) throw new UsageError("--slot takes a number"); globals.slot = value; break;
			case "--role": if (!(ROLES as readonly string[]).includes(value)) throw new UsageError(`--role must be one of ${ROLES.join(", ")}`); globals.role = value as Role; break;
			case "--agent": if (value !== "pi" && value !== "claude") throw new UsageError("--agent must be pi or claude"); globals.agent = value; break;
			case "--machine": globals.machine = value; break;
			case "--remote-cwd": globals.remoteCwd = value; break;
			default: throw new UsageError(`${argv[i]} is not supported with SIDECAR_RUNNER=1`);
		}
	}
	return { globals, command: argv[i] ?? "", rest: argv.slice(i + 1) };
}

/** The Claude conversation that owns sidecars: its transcript, matched by Herdr against the session ID it reports. */
export function claudeTranscript(env: NodeJS.ProcessEnv): string | undefined {
	const id = env.CLAUDE_CODE_SESSION_ID;
	if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return undefined;
	const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
	try {
		for (const project of readdirSync(projects)) {
			const file = join(projects, project, `${id}.jsonl`);
			if (existsSync(file)) return file;
		}
	} catch {}
	// Only the name identifies the owner; a session that has not written its transcript yet still has this one.
	return join(projects, `${id}.jsonl`);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class SidecarCli {
	private readonly env: NodeJS.ProcessEnv;
	private readonly cwd: string;
	private readonly parent: HerdrParent;
	private readonly owner: string;
	private readonly dir: string;
	private readonly options: CliOptions;
	private readonly io: Io;
	private readonly ownerSession: string | undefined;

	constructor(io: Io, options: CliOptions = {}) {
		this.io = io;
		this.options = options;
		this.env = options.env ?? process.env;
		this.cwd = options.cwd ?? process.cwd();
		this.parent = new HerdrParent({ env: this.env, ...options.parent });
		this.owner = ownerName(this.env, this.parent.hc ? "hc" : "herdr");
		this.dir = stateDir(this.env);
		this.ownerSession = claudeTranscript(this.env);
	}

	async run(argv: string[]): Promise<number> {
		try {
			const { globals, command, rest } = parse(argv);
			if (!RUNNER_COMMANDS.has(command)) throw new UsageError(`${command || "no command"} is not supported with SIDECAR_RUNNER=1; unset it to use the Bash launcher`);
			if (!this.parent.paneId && command !== "maintain") throw new UsageError("run inside a herdr pane or a Herdr app terminal");
			await this.parent.load();
			const slot = new SlotState(this.dir, slotName(this.owner, globals.slot));
			switch (command) {
				case "ask": return await this.ask(slot, globals, rest);
				case "answer": return await this.answer(slot, globals, rest);
				case "note": return await this.request(slot, globals, "note", notePrompt(await this.text(rest)));
				case "steer": return await this.steer(slot, globals, rest);
				case "status": return await this.status();
				case "report": return this.report(slot);
				case "stop": return await this.stop(slot, globals, rest);
				case "wait": return await this.waitCurrent(slot);
				case "maintain": return await this.maintain();
			}
			return EXIT.failed;
		} catch (error) {
			this.io.stderr(`sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
			return EXIT.failed;
		} finally {
			await this.parent.close().catch(() => undefined);
		}
	}

	private async text(rest: string[]): Promise<string> {
		if (rest.length === 1 && rest[0] === "-") return (await this.io.stdin()).trim();
		const text = rest.join(" ").trim();
		if (!text) throw new UsageError("missing TEXT");
		return text;
	}

	private async ask(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		let keep: boolean | undefined;
		const words = [...rest];
		while (words[0]?.startsWith("--")) {
			const flag = words.shift()!;
			if (flag === "--keep") keep = true;
			else throw new UsageError(`ask ${flag} is not supported with SIDECAR_RUNNER=1`);
		}
		return this.request(slot, globals, "ask", await this.text(words), keep);
	}

	private async answer(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		if (!slot.pendingId()) throw new UsageError(`no pending question in slot ${globals.slot}; use: sidecar --slot ${globals.slot} ask TEXT for a new request`);
		return this.request(slot, globals, "answer", answerPrompt(await this.text(rest)));
	}

	private async steer(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		const text = await this.text(rest);
		const record = slot.read();
		if (record) {
			const { id, runner } = await this.parent.routeLive(record.agentId);
			const agent = await runner.resolve(id);
			const snapshot = await runner.read({ agentId: id, runId: agent.currentRunId });
			if (!isTerminal(snapshot.phase)) {
				if (agent.runtime === "claude-code") throw new Error("busy Claude Code sidecars cannot be steered; wait for the report, then ask");
				await runner.steer({ agentId: id, runId: agent.currentRunId }, text);
				this.io.stdout("steered: queued for the sidecar's next tool round\n");
				return EXIT.report;
			}
		}
		return this.request(slot, globals, "steer", text);
	}

	/** Starts or resumes the slot's agent with TEXT, waits for its report and prints it. */
	private async request(slot: SlotState, globals: Globals, kind: string, text: string, keep?: boolean): Promise<number> {
		const hash = sha256(text);
		const existing = slot.read();
		if (existing?.inflight === hash) {
			this.io.stderr("sidecar: an identical request is already in flight on this slot; wait for it\n");
			return EXIT.duplicate;
		}
		const release = await slot.lock();
		try {
			let record = slot.read();
			if (record) this.assertBinding(record, globals);
			const local = await this.parent.local();
			await this.publishOwner();
			let ref: RunRef;
			let runner: HerdrRunner;
			if (record) {
				const routed = await this.parent.routeLive(record.agentId);
				runner = routed.runner;
				const agent = await runner.resolve(routed.id);
				// A run left by a killed launcher finishes before this one starts.
				const previous = await this.settle(local, runner, { agentId: routed.id, runId: agent.currentRunId });
				if (previous.phase === "blocked") return this.blocked(agent.herdrName);
				const caller = await this.parent.caller(runner, agent.cwd ?? this.cwd, this.ownerSession);
				ref = await runner.resume(routed.id, text, undefined, true, caller);
			} else {
				const role = globals.role ?? "reviewer";
				const agent = globals.agent ?? "pi";
				const machine = globals.machine;
				runner = machine ? await this.parent.machine(machine) : local;
				if (machine) this.parent.remember(machine);
				ref = await runner.spawn(await this.spawnRequest(runner, role, agent, text, globals, keep));
				record = { agentId: qualifiedAgentId(ref.agentId, runner.machine), role, agent, ...(machine ? { machine } : {}) };
			}
			slot.write({ ...record, inflight: hash });
			const id = requestId(kind, slot.name);
			const path = slot.reportPath(id);
			this.io.stdout(`# Sidecar report (${path})\n`);
			slot.beginRequest(id, Math.floor(Date.now() / 1000), record.machine);
			if (kind === "answer") slot.pending(slot.pendingId(), id);
			try {
				const snapshot = await this.settle(local, runner, ref, id);
				return await this.deliver(slot, record, runner, ref, snapshot, id, kind);
			} finally {
				slot.write({ ...record, inflight: undefined });
				slot.finishRequest(Math.floor(Date.now() / 1000));
			}
		} finally {
			release();
			this.options.maintainLater?.();
		}
	}

	private assertBinding(record: SlotRecord, globals: Globals): void {
		if (globals.role && globals.role !== record.role) throw new UsageError(`slot ${globals.slot} is already a ${record.role}; use a new slot for ${globals.role}`);
		if (globals.agent && globals.agent !== record.agent) throw new UsageError(`slot ${globals.slot} already runs ${record.agent}; use a new slot for ${globals.agent}`);
		if (globals.machine && globals.machine !== record.machine) throw new UsageError(`slot ${globals.slot} runs ${record.machine ? `on ${record.machine}` : "locally"}; use a new slot for ${globals.machine}`);
	}

	private async spawnRequest(runner: HerdrRunner, role: Role, agent: Backend, prompt: string, globals: Globals, keep?: boolean): Promise<SpawnRequest> {
		const machine = runner.machine;
		const cwd = machine ? this.parent.machineCwd(machine, globals.remoteCwd) || this.cwd : this.cwd;
		const reviewer = role === "reviewer";
		const model = agent === "claude"
			? this.env.SIDECAR_CLAUDE_MODEL || (reviewer ? "opus" : "sonnet")
			: this.env.SIDECAR_MODEL || "openai-codex/gpt-6.1-sol";
		return {
			runtime: agent === "claude" ? "claude-code" : "pi",
			prompt,
			description: `${role} sidecar, slot ${globals.slot}`,
			name: `sidecar-${globals.slot}-${role}`,
			subagentType: role,
			model,
			thinking: this.env.SIDECAR_THINKING || (reviewer ? "high" : "medium"),
			runInBackground: true,
			keep,
			cwd,
			definitionsCwd: this.cwd,
			resolved: { instructions: roleInstructions(role, agent) },
			agentDir: this.parent.deps.agentDir,
			...(await this.parent.caller(runner, cwd, this.ownerSession)),
		};
	}

	/** In the Herdr app, Claude's terminal carries no session; label it so owner-gone cleanup can judge it. */
	private async publishOwner(): Promise<void> {
		const pid = Number(this.env.CLAUDE_PID);
		if (!this.parent.hc || !this.ownerSession || !Number.isSafeInteger(pid) || pid <= 0) return;
		await this.parent.deps.client.publishSession?.(this.parent.paneId, this.ownerSession, pid).catch(() => undefined);
	}

	/** Maintains coordination until RUN ends or blocks; prints a progress line while it works. */
	private async settle(local: HerdrRunner, runner: HerdrRunner, ref: RunRef, label?: string): Promise<RunSnapshot> {
		const poll = this.options.pollMs ?? 200;
		const progress = this.options.progressMs ?? Number(this.env.SIDECAR_PROGRESS_S ?? 60) * 1000;
		const started = this.parent.deps.now();
		let next = started + progress;
		for (;;) {
			const snapshot = await runner.read(ref);
			if (isTerminal(snapshot.phase) || snapshot.phase === "blocked") return snapshot;
			await this.parent.tick(local, { service: async () => undefined, reportError: (error) => { if (error) this.io.stderr(`sidecar: ${error instanceof Error ? error.message : String(error)}\n`); } });
			const now = this.parent.deps.now();
			if (label && progress > 0 && now >= next) {
				const seconds = Math.floor((now - started) / 1000);
				this.io.stderr(`sidecar: ${label} still working (${Math.floor(seconds / 60)}m${seconds % 60}s)\n`);
				next = now + progress;
			}
			await this.parent.deps.sleep(poll);
		}
	}

	private blocked(name: string): number {
		this.io.stderr(`sidecar: ${name} is blocked on a question or approval in its pane; ask the user to handle it\n`);
		return EXIT.blocked;
	}

	private async deliver(slot: SlotState, record: SlotRecord, runner: HerdrRunner, ref: RunRef, snapshot: RunSnapshot, id: string, kind: string): Promise<number> {
		if (snapshot.phase === "blocked") return this.blocked((await runner.resolve(ref.agentId)).herdrName);
		let report = snapshot.result ?? "";
		let question: string | undefined;
		if (snapshot.phase === "needs-answer") question = report.trim();
		else if (snapshot.phase === "completed" && record.agent === "claude") ({ report, question } = claudeQuestion(report));
		if (snapshot.phase !== "completed" && snapshot.phase !== "needs-answer") {
			this.io.stderr(`sidecar: no report for ${id}: the run ${snapshot.phase}${snapshot.error ? `: ${snapshot.error}` : ""}\n`);
			await runner.store.acknowledgeNotice(ref.runId).catch(() => undefined);
			return snapshot.phase === "stopped" ? EXIT.failed : EXIT.noReport;
		}
		const body = question && snapshot.phase === "needs-answer" ? `## Question\n\n${question}\n` : report;
		slot.saveReport(id, body);
		this.io.stdout(kind === "note" && !question ? "noted\n" : `${body.trimEnd()}\n`);
		// The job's output file is the notice's destination; it is written before the outbox entry is acknowledged.
		await runner.store.acknowledgeNotice(ref.runId).catch(() => undefined);
		slot.pending(question ? id : undefined);
		if (question) {
			this.io.stdout(`NEEDS_ANSWER: ${question}\n`);
			return EXIT.question;
		}
		return EXIT.report;
	}

	private async waitCurrent(slot: SlotState): Promise<number> {
		const record = slot.read();
		if (!record) throw new UsageError("no sidecar in this slot");
		const local = await this.parent.local();
		const { id, runner } = await this.parent.routeLive(record.agentId);
		const agent = await runner.resolve(id);
		const ref = { agentId: id, runId: agent.currentRunId };
		const snapshot = await this.settle(local, runner, ref);
		const reqId = requestId("wait", slot.name);
		this.io.stdout(`# Sidecar report (${slot.reportPath(reqId)})\n`);
		return this.deliver(slot, record, runner, ref, snapshot, reqId, "wait");
	}

	private report(slot: SlotState): number {
		const path = slot.latestReport();
		if (!path || !existsSync(path)) throw new UsageError("no saved report for this slot");
		this.io.stdout(`# Sidecar report (${path})\n${readFileSync(path, "utf8")}`);
		const pending = slot.pendingId();
		if (pending) this.io.stdout("This slot is waiting for an answer.\n");
		return EXIT.report;
	}

	private async status(): Promise<number> {
		const slots = SlotState.slots(join(this.dir), this.owner);
		if (!slots.length) { this.io.stdout("no runner sidecars for this pane\n"); return EXIT.report; }
		for (const number of slots) {
			const slot = new SlotState(this.dir, slotName(this.owner, number));
			const record = slot.read();
			if (!record) continue;
			let line = `slot ${number}: ${record.role} · ${record.agent}${record.machine ? ` @ ${record.machine}` : ""} · ${record.agentId}`;
			try {
				const { id, runner } = await this.parent.routeLive(record.agentId);
				const agent = await runner.resolve(id);
				const snapshot = await runner.read({ agentId: id, runId: agent.currentRunId });
				line += ` · ${snapshot.phase}${agent.paneState ? ` (pane ${agent.paneState})` : ` (pane ${agent.paneId})`}`;
			} catch (error) { line += ` · unknown: ${error instanceof Error ? error.message : String(error)}`; }
			if (slot.pendingId()) line += " · needs an answer";
			this.io.stdout(line + "\n");
		}
		return EXIT.report;
	}

	private async stop(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		const force = rest.includes("--force");
		const fresh = rest.includes("--fresh");
		for (const flag of rest) if (!["--force", "--fresh"].includes(flag)) throw new UsageError(`stop ${flag} is not supported with SIDECAR_RUNNER=1`);
		const record = slot.read();
		if (!record) { this.io.stdout(`slot ${globals.slot} has no sidecar\n`); return EXIT.report; }
		const { id, runner } = await this.parent.routeLive(record.agentId);
		const agent = await runner.resolve(id);
		const ref = { agentId: id, runId: agent.currentRunId };
		if (!isTerminal((await runner.read(ref)).phase)) {
			if (!force) { this.io.stderr("sidecar: a request is running; pass --force to stop it\n"); return EXIT.busy; }
			const snapshot = await runner.cancel(ref);
			this.io.stdout(`${snapshot.phase === "stopped" ? "stopped" : "stop requested"}: ${agent.herdrName}\n`);
		} else this.io.stdout(agent.paneState ? `${agent.herdrName} is idle and its pane is closed\n` : `${agent.herdrName} is idle; its pane closes once it settles\n`);
		if (fresh) {
			slot.forget();
			this.io.stdout(`slot ${globals.slot} forgotten; the next request starts a new conversation\n`);
		}
		return EXIT.report;
	}

	/**
	 * Keeps coordination running so finished panes close and departed owners' panes are cleaned up. One pass runs per
	 * owner; a later request extends it through the deadline file instead of starting another.
	 */
	private async maintain(): Promise<number> {
		const base = join(this.dir, "runner", `${this.owner}.maintain`);
		const extend = () => writeFileSync(`${base}.until`, String(this.parent.deps.now() + (this.options.maintainMs ?? 180_000)));
		extend();
		try { writeFileSync(`${base}.lock`, `${process.pid}\n`, { flag: "wx" }); }
		catch {
			const holder = Number(readFileSync(`${base}.lock`, "utf8"));
			if (Number.isInteger(holder) && holder > 0 && alive(holder)) return EXIT.report;
			writeFileSync(`${base}.lock`, `${process.pid}\n`);
		}
		try {
			const local = await this.parent.local();
			while (this.parent.deps.now() < Number(readFileSync(`${base}.until`, "utf8"))) {
				await this.parent.tick(local, { service: async () => undefined, reportError: () => undefined });
				await this.parent.deps.sleep(this.options.pollMs ?? 1000);
			}
		} finally {
			if (readFileSync(`${base}.lock`, "utf8").trim() === String(process.pid)) rmSync(`${base}.lock`, { force: true });
		}
		return EXIT.report;
	}
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One detached maintenance pass per owner; a newer one replaces nothing while the first still runs. */
export function maintainDetached(env: NodeJS.ProcessEnv = process.env): void {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "maintain"], { detached: true, stdio: "ignore", env });
	child.unref();
}

async function readStdin(): Promise<string> {
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const cli = new SidecarCli({
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		stdin: readStdin,
	}, { maintainLater: process.argv[2] === "maintain" ? undefined : () => maintainDetached() });
	process.exitCode = await cli.run(process.argv.slice(2));
}
