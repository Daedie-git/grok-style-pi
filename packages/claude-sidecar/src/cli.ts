// The sidecar launcher's runner front-end: Claude Code owns persistent Pi or Claude Code sidecars that herdr-runner
// launches, supervises and resumes. scripts/sidecar runs it.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HerdrParent, type ParentOptions } from "../herdr-runner/src/parent.ts";
import { qualifiedAgentId, type HerdrRunner, type SpawnRequest } from "../herdr-runner/src/runner.ts";
import { isTerminal, type RunRef, type RunSnapshot } from "../herdr-runner/src/state.ts";
import { Checks } from "./checks.ts";
import { syncMachine } from "./sync.ts";
import { claudeAncestry, onPath, sessionContext } from "./hook.ts";
import { coopReview } from "./coop.ts";
import { bashQuote, toplevel } from "./git.ts";
import { answerPrompt, claudeQuestion, notePrompt, profileInstructions, roleInstructions } from "./prompts.ts";
import { loadProfile, profileSkills, profileTools, type Profile } from "./profile.ts";
import { pushGate } from "./push-gate.ts";
import { Rejections, rejectionPrompt } from "./rejections.ts";
import { latestReviewedFile, planPrompt, prepareDiff, unreviewedSince } from "./review.ts";
import { parseSessionStart, recordTranscript, recordedTranscript } from "./session.ts";
import { ROLES, SlotState, acquireLock, ownerName, requestId, slotName, stateDir, type Backend, type Role, type SlotRecord } from "./state.ts";

/** Exit codes the plugin's job messages and the skill rely on. */
export const EXIT = { report: 0, failed: 1, noReport: 2, question: 3, duplicate: 4, blocked: 5, busy: 7 } as const;

/** The launcher commands. */
export const RUNNER_COMMANDS = new Set([
	"ask", "answer", "note", "steer", "status", "report", "stop", "wait", "maintain",
	"plan", "diff", "unreviewed", "push-gate", "reject", "keep", "unkeep", "session-start", "coop-review", "sync-machine",
]);

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

interface Globals { slot: string; role?: Role; agent?: Backend; machine?: string; remoteCwd?: string; profileFile?: string }

/** Hook entries and read-only checks that need no runner. */
const LIGHT = new Set(["unreviewed", "push-gate", "session-start"]);
/** Requests whose report the launcher checks after delivery. */
const CHECKED = new Set(["ask", "answer", "steer"]);

class UsageError extends Error {}

/** Slot locks use node:sqlite, whose experimental notice would otherwise lead every report. */
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];

interface RequestOptions {
	keep?: boolean;
	/** Identifies the request for duplicate detection; defaults to the text's digest. */
	key?: string;
	/** The question this request answers; it must still be unanswered once the slot lock is held. */
	answers?: string;
	/** Builds the prompt under the slot lock, once the slot's role and machine are known. */
	build?: (slot: { role: Role; machine?: string }) => string;
}

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
			case "--profile-file": globals.profileFile = value; break;
			default: throw new UsageError(`${argv[i]} is not supported`);
		}
	}
	return { globals, command: argv[i] ?? "", rest: argv.slice(i + 1) };
}

/** The Claude conversation that owns sidecars: its transcript, matched by Herdr against the session ID it reports. */
export function claudeTranscript(env: NodeJS.ProcessEnv, id = env.CLAUDE_CODE_SESSION_ID): string | undefined {
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

function repoSkills(cwd: string): string[] {
	const root = toplevel(cwd);
	const path = root ? join(root, ".claude", "skills") : undefined;
	return path && existsSync(path) && statSync(path).isDirectory() ? [path] : [];
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
		// SessionStart records the transcript for Claude versions that do not export their session ID.
		this.ownerSession = claudeTranscript(this.env) ?? recordedTranscript(this.dir, this.owner);
	}

	private profile: Profile | undefined;

	async run(argv: string[]): Promise<number> {
		try {
			const { globals, command, rest } = parse(argv);
			if (!RUNNER_COMMANDS.has(command)) throw new UsageError(`${command || "no command"} is not a sidecar command`);
			if (command === "unreviewed") return this.unreviewed();
			if (command === "push-gate") return await this.pushGate();
			if (command === "session-start") { await this.parent.load(); return await this.sessionStart(); }
			if (command === "reject" && rest[0] === "--overrule") return await this.overrule(globals, rest);
			if (!this.parent.paneId) {
				// Hook entries start maintenance outside Herdr too; there is no owner to maintain.
				if (command === "maintain") return EXIT.report;
				throw new UsageError("run inside a herdr pane or a Herdr app terminal");
			}
			await this.parent.load();
			if (globals.profileFile) this.profile = this.bindProfile(globals);
			const slot = new SlotState(this.dir, slotName(this.owner, globals.slot));
			switch (command) {
				case "ask": return await this.ask(slot, globals, rest);
				case "answer": return await this.answer(slot, globals, rest);
				case "note": return await this.request(slot, globals, "note", notePrompt(await this.text(rest)));
				case "steer": return await this.steer(slot, globals, rest);
				case "plan": return await this.plan(slot, globals, rest);
				case "diff": return await this.diff(slot, globals, rest);
				case "reject": return await this.reject(slot, globals, rest);
				case "keep": return await this.keep(slot, globals, rest, true);
				case "unkeep": return await this.keep(slot, globals, rest, false);
				case "coop-review": return await this.coop(globals, rest);
				case "sync-machine": {
					if (rest.length !== 1) throw new UsageError("usage: sidecar sync-machine NAME");
					const machine = await this.parent.findMachine(rest[0]);
					if (!machine.target) throw new UsageError(`machine '${machine.label}' has no SSH target`);
					return syncMachine(machine, this.cwd, this.env, (text) => this.io.stdout(text));
				}
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

	private bindProfile(globals: Globals): Profile {
		const profile = loadProfile(resolve(this.cwd, globals.profileFile!));
		if (globals.role && globals.role !== profile.role) throw new UsageError(`--role conflicts with profile role ${profile.role}`);
		globals.role = profile.role;
		return profile;
	}

	private async text(rest: string[]): Promise<string> {
		if (rest.length === 1 && rest[0] === "-") return (await this.io.stdin()).trim();
		const text = rest.join(" ").trim();
		if (!text) throw new UsageError("missing TEXT");
		return text;
	}

	private async ask(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		let keep: boolean | undefined;
		let clear = false;
		const accept: string[] = [];
		const scope: string[] = [];
		const words = [...rest];
		for (;;) {
			const flag = words[0];
			if (flag === "--keep") keep = true;
			else if (flag === "--no-checks") clear = true;
			else if (flag === "--accept" || flag === "--scope") {
				if (!words[1]) throw new UsageError(flag === "--accept" ? "--accept requires a command" : "--scope requires a path glob");
				(flag === "--accept" ? accept : scope).push(words[1]);
				words.shift();
			} else break;
			words.shift();
		}
		const text = await this.text(words);
		const checked = accept.length + scope.length > 0 || clear;
		const checks = new Checks(this.dir, slot.name);
		// An ask that changes checks identifies itself by its arguments, since its prompt depends on the checks.
		const key = checked ? sha256([text, ...accept, "--", ...scope, clear ? "clear" : ""].join("\0")) : undefined;
		return this.request(slot, globals, "ask", text, {
			keep, key,
			build: ({ role, machine }) => {
				if (checked) {
					if (machine && !clear) throw new UsageError("--accept and --scope run in this checkout; they are not supported for a slot on another machine");
					if (clear) checks.clear(); else checks.save(this.cwd, accept, scope);
				}
				return role === "implementer" ? `${text}\n\n${checks.contract()}` : text;
			},
		});
	}

	private async answer(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		const answers = slot.pendingId();
		if (!answers) throw new UsageError(`no pending question in slot ${globals.slot}; use: sidecar --slot ${globals.slot} ask TEXT for a new request`);
		return this.request(slot, globals, "answer", answerPrompt(await this.text(rest)), { answers });
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
	private async request(slot: SlotState, globals: Globals, kind: string, text: string, options: RequestOptions = {}): Promise<number> {
		const hash = options.key ?? sha256(text);
		const existing = slot.read();
		if (existing?.inflight === hash) {
			this.io.stderr("sidecar: an identical request is already in flight on this slot; wait for it\n");
			return EXIT.duplicate;
		}
		const release = await slot.lock();
		try {
			if (options.answers && slot.pendingId() !== options.answers) throw new UsageError(`slot ${globals.slot}'s question was already answered; check its report before sending another request`);
			let record = slot.read();
			if (record) this.assertBinding(record, globals);
			this.assertProfile(record, globals);
			const prompt = options.build?.({ role: record?.role ?? globals.role ?? "reviewer", machine: record ? record.machine : globals.machine }) ?? text;
			const local = await this.parent.local();
			await this.publishOwner();
			await this.adoptTranscript(local).catch(() => undefined);
			let ref: RunRef;
			let runner: HerdrRunner;
			if (record) {
				const routed = await this.parent.routeLive(record.agentId);
				runner = routed.runner;
				const agent = await runner.resolve(routed.id);
				// A run left by a killed launcher finishes before this one starts.
				const previous = await this.settle(local, runner, { agentId: routed.id, runId: agent.currentRunId });
				if (previous.phase === "blocked") return this.blocked(agent.herdrName);
				if (options.keep) await runner.store.setKeep(routed.id, true);
				const caller = await this.parent.caller(runner, agent.cwd ?? this.cwd, this.ownerSession);
				ref = await runner.resume(routed.id, prompt, undefined, true, caller);
			} else {
				const role = globals.role ?? "reviewer";
				const agent = globals.agent ?? "pi";
				const machine = globals.machine;
				runner = machine ? await this.parent.machine(machine) : local;
				if (machine) this.parent.remember(machine);
				ref = await runner.spawn(await this.spawnRequest(runner, role, agent, prompt, globals, options.keep));
				record = { agentId: qualifiedAgentId(ref.agentId, runner.machine), role, agent, ...(machine ? { machine } : {}), ...(this.profile ? { profile: this.profile.hash } : {}) };
			}
			slot.write({ ...record, inflight: hash });
			const id = requestId(kind, slot.name);
			const path = slot.reportPath(id);
			this.io.stdout(`# Sidecar report (${path})\n`);
			slot.beginRequest(id, Math.floor(Date.now() / 1000), record.machine);
			if (kind === "answer") slot.pending(slot.pendingId(), id);
			try {
				const snapshot = await this.settle(local, runner, ref, id);
				return await this.deliver(slot, record, runner, ref, snapshot, id, kind, globals.slot);
			} finally {
				// stop --fresh may have forgotten the slot meanwhile; its conversation must stay discarded.
				if (slot.read()?.agentId === record.agentId) slot.write({ ...record, inflight: undefined });
				slot.finishRequest(Math.floor(Date.now() / 1000));
			}
		} finally {
			release();
			this.options.maintainLater?.();
		}
	}

	/** A profile binds a fresh local Pi conversation; later requests must carry the same profile or none. */
	private assertProfile(record: SlotRecord | undefined, globals: Globals): void {
		const profile = this.profile;
		if (!profile) return;
		if ((record ? record.agent : globals.agent ?? "pi") !== "pi") throw new UsageError("role profiles support --agent pi only");
		if (record ? record.machine : globals.machine) throw new UsageError("role profiles run on this machine only");
		if (record && !record.profile) throw new UsageError("cannot attach a profile to an unprofiled conversation; use stop --fresh first");
		if (record && record.profile !== profile.hash) throw new UsageError("slot profile differs; use stop --fresh before attaching a different profile");
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
		const profile = this.profile;
		// Pi finds .pi/skills itself; Claude Code repositories keep theirs in .claude/skills. A profile names its own.
		const skills = profile ? profileSkills(profile, this.env.HOME || homedir()) : !machine && agent === "pi" ? repoSkills(this.cwd) : [];
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
			resolved: profile
				? { instructions: profileInstructions(profile.prompt), allowedTools: profileTools(profile) }
				: { instructions: roleInstructions(role, agent) },
			...(skills.length ? { skills } : {}),
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

	private async deliver(slot: SlotState, record: SlotRecord, runner: HerdrRunner, ref: RunRef, snapshot: RunSnapshot, id: string, kind: string, slotNumber: string): Promise<number> {
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
		let body = question && snapshot.phase === "needs-answer" ? `## Question\n\n${question}\n` : report;
		if (kind !== "wait") {
			for (const held of await new Rejections(this.dir, slot.name).apply(body)) {
				this.io.stderr(`sidecar: the reviewer holds ${held}; fix it, or reject again with new evidence, or overrule it with: sidecar --slot ${slotNumber} reject --overrule ${held} REASON (then tell the user)\n`);
			}
			const checks = new Checks(this.dir, slot.name);
			if (!question && CHECKED.has(kind) && checks.active()) {
				this.io.stderr("sidecar: running launcher checks\n");
				body = await checks.run(body, slot.reportPath(id), this.env);
			}
		}
		slot.saveReport(id, body);
		this.io.stdout(kind === "note" && !question ? "noted\n" : `${body.trimEnd()}\n`);
		// The job's output file is the notice's destination; it is written before the outbox entry is acknowledged.
		await runner.store.acknowledgeNotice(ref.runId).catch(() => undefined);
		if (slot.read()?.agentId === record.agentId) slot.pending(question ? id : undefined);
		if (question) {
			this.io.stdout(`NEEDS_ANSWER: ${question}\n`);
			return EXIT.question;
		}
		return EXIT.report;
	}

	/**
	 * Cooperative diff review by a Pi and a Claude Code reviewer on dedicated slots. Each slot is reserved for the whole
	 * run; a slot busy with another request is refused rather than queued behind.
	 */
	private async coop(globals: Globals, rest: string[]): Promise<number> {
		const slots = { pi: "98", claude: "99" };
		const words = [...rest];
		while (words[0] === "--pi-slot" || words[0] === "--claude-slot") {
			const [flag, value] = words.splice(0, 2);
			if (!/^[1-9][0-9]{0,3}$/.test(value ?? "")) throw new UsageError(`${flag} requires an integer from 1 to 9999`);
			slots[flag === "--pi-slot" ? "pi" : "claude"] = value;
		}
		if (words[0]?.startsWith("--")) throw new UsageError(`unknown coop-review option ${words[0]}`);
		if (words.length > 2) throw new UsageError("usage: sidecar coop-review [--pi-slot N] [--claude-slot M] [BASE] [CONTEXT]");
		if (globals.slot !== "1" || globals.role || globals.agent || globals.profileFile) throw new UsageError("coop-review chooses its own slots, agents and roles; use --pi-slot and --claude-slot");
		if (slots.pi === slots.claude) throw new UsageError("--pi-slot and --claude-slot must differ");
		if (globals.machine || globals.remoteCwd) throw new UsageError("coop-review runs on this machine; diff reviews need the local checkout");
		const releases: Array<() => void> = [];
		const now = new AbortController();
		now.abort();
		try {
			for (const [flag, slot] of [["--pi-slot", slots.pi], ["--claude-slot", slots.claude]] as const) {
				const name = slotName(this.owner, slot);
				try { releases.push(await acquireLock(join(this.dir, "runner", `${name}.coop.lock`), now.signal)); }
				catch { throw new UsageError(`slot ${slot} is in use by another coop-review; choose another slot with ${flag}`); }
				try { (await acquireLock(join(this.dir, "runner", `${name}.lock`), now.signal))(); }
				catch { throw new UsageError(`slot ${slot} is busy with another request; wait for it or choose another slot with ${flag}`); }
			}
			const extra: string[] = [];
			const report = join(this.dir, "reports", `${requestId("coop", this.owner)}.md`);
			return await coopReview({
				launch: (args, stdin, onStderr) => this.launchSelf(args, stdin, onStderr),
				base: words[0] || "HEAD", context: words[1] ?? "", piSlot: slots.pi, claudeSlot: slots.claude, extra, reportPath: report,
				save: (text) => writeFileSync(report, text.endsWith("\n") ? text : text + "\n"),
				readReport: (path) => readFileSync(path, "utf8"),
				stdout: (text) => this.io.stdout(text), stderr: (text) => this.io.stderr(text),
			});
		} finally {
			for (const release of releases) release();
		}
	}

	/** Runs this front-end for one reviewer, so each request keeps its own slot lock, progress and exit code. */
	private launchSelf(args: string[], stdin: string, onStderr: (line: string) => void): Promise<{ code: number; stdout: string }> {
		return new Promise((done, fail) => {
			const child = spawn(process.execPath, [...NODE_FLAGS, fileURLToPath(import.meta.url), ...args], { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "", pending = "";
			child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
			child.stderr.on("data", (chunk: Buffer) => {
				const lines = (pending + chunk).split("\n");
				pending = lines.pop()!;
				for (const line of lines) onStderr(line);
			});
			child.on("error", fail);
			child.on("close", (code) => { if (pending) onStderr(pending); done({ code: code ?? 1, stdout }); });
			child.stdin.end(stdin);
		});
	}

	/** Plans and diffs are copied to files the sidecar reads here; another machine could not read them. */
	private assertLocal(slot: SlotState, globals: Globals, command: string): void {
		const record = slot.read();
		if (record ? record.machine : globals.machine) throw new UsageError(`${command} on another machine is not supported: its file cannot be copied there`);
	}

	private async plan(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		const file = rest[0] ? resolve(this.cwd, rest[0]) : "";
		if (!file || !existsSync(file) || !statSync(file).isFile()) throw new UsageError("usage: sidecar plan FILE [CONTEXT]");
		this.assertLocal(slot, globals, "plan");
		return this.request(slot, globals, "plan", planPrompt(realpathSync(file), rest[1]));
	}

	private async diff(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		this.assertLocal(slot, globals, "diff");
		const prepared = prepareDiff({
			cwd: this.cwd, base: rest[0] || "HEAD", context: rest[1], slot: slot.name, slotNumber: globals.slot, dir: this.dir,
			rejected: new Rejections(this.dir, slot.name).unsettled(), warn: (text) => this.io.stderr(text),
		});
		const code = await this.request(slot, globals, "diff", prepared.prompt);
		// Reached only when a report was delivered; the review covered exactly the files fingerprinted above.
		if (code === EXIT.report) prepared.record();
		return code;
	}

	private async reject(slot: SlotState, globals: Globals, rest: string[]): Promise<number> {
		const text = await this.text(rest);
		const id = await new Rejections(this.dir, slot.name).add(text);
		this.io.stderr(`sidecar: recorded rejection ${id}\n`);
		return this.request(slot, globals, "reject", rejectionPrompt(id, text));
	}

	/** `reject --overrule R<n> REASON`: settles a rejection without the reviewer's agreement. */
	private async overrule(globals: Globals, rest: string[]): Promise<number> {
		const [, id, ...reason] = rest;
		if (!/^R\d+$/.test(id ?? "") || !reason.length) throw new UsageError("usage: sidecar reject --overrule R<n> REASON");
		if (!await new Rejections(this.dir, slotName(this.owner, globals.slot)).set(id, "overruled", reason.join(" "))) throw new UsageError(`slot ${globals.slot} has no rejection ${id}`);
		this.io.stdout(`sidecar: ${id} overruled; tell the user, with the reviewer's failure scenario and your reason\n`);
		return EXIT.report;
	}

	private async keep(slot: SlotState, globals: Globals, rest: string[], on: boolean): Promise<number> {
		if (rest.length) throw new UsageError("usage: sidecar [--slot N] keep|unkeep");
		const record = slot.read();
		if (!record) throw new UsageError(`no sidecar in slot ${globals.slot}; start it pinned with ask --keep`);
		const { id, runner } = await this.parent.routeLive(record.agentId);
		if (!await runner.store.setKeep(id, on)) throw new Error(`${record.agentId} is no longer known to the runner`);
		this.io.stdout(`${on ? "pinned" : "unpinned"}: ${record.agentId}\n`);
		// Unpinning after a delivered report closes the pane as that completion would have.
		if (!on) this.options.maintainLater?.();
		return EXIT.report;
	}

	private unreviewed(): number {
		const root = toplevel(this.cwd);
		if (!root) throw new UsageError("not a git repository");
		const result = unreviewedSince(root, latestReviewedFile(this.dir, this.owner, root), this.dir);
		this.io.stdout(`${result.text}\n`);
		return result.code;
	}

	/** PreToolUse hook: reads the hook JSON on stdin and prints a deny decision, or nothing. */
	private async pushGate(): Promise<number> {
		if (!this.parent.paneId) return EXIT.report;
		const answer = pushGate(await this.io.stdin(), { dir: this.dir, owner: this.owner, home: this.env.HOME || homedir(), cwd: this.cwd });
		if (answer) this.io.stdout(`${answer}\n`);
		return EXIT.report;
	}

	/**
	 * SessionStart hook: hands the pane's sidecars to a continued conversation, exports the owner name the band reads,
	 * and tells Claude how to use sidecars. Headless and sidecar-owned Claudes get nothing.
	 */
	private async sessionStart(): Promise<number> {
		const stdin = await this.io.stdin();
		if (!this.parent.paneId) return EXIT.report;
		const cli = this.parent.hc ? "hc" : "herdr";
		for (const command of [cli]) if (!onPath(command, this.env)) { this.io.stderr(`sidecar: missing dependency ${command}; skipping startup\n`); return EXIT.report; }
		if (!onPath("pi", this.env) && !onPath("claude", this.env)) { this.io.stderr("sidecar: missing agent CLI (pi or claude); skipping startup\n"); return EXIT.report; }
		const pid = Number(this.env.SIDECAR_TEST_ANCESTRY_PID ?? process.ppid);
		if (claudeAncestry(pid) === 1) return EXIT.report;
		const input = parseSessionStart(stdin);
		if (!input.sessionId) return EXIT.report;
		if (this.env.CLAUDE_ENV_FILE) appendFileSync(this.env.CLAUDE_ENV_FILE, `export SIDECAR_AGENT=${bashQuote(this.owner)}\n`);
		const transcript = input.transcript ?? claudeTranscript(this.env, input.sessionId);
		if (transcript) await this.adoptTranscript(await this.parent.local(), transcript).catch((error) => this.io.stderr(`sidecar: ${error instanceof Error ? error.message : String(error)}\n`));
		this.io.stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext(this.parent.profiles, cli) } }) + "\n");
		return EXIT.report;
	}

	/** Hands the pane's sidecars to TRANSCRIPT when the conversation continues under a new one (/clear). */
	private async adoptTranscript(local: HerdrRunner, transcript = this.ownerSession): Promise<void> {
		if (!transcript) return;
		const previous = recordedTranscript(this.dir, this.owner);
		if (previous === transcript) return;
		if (previous) {
			const machines = new Set<string>();
			for (const number of SlotState.slots(this.dir, this.owner)) {
				const machine = new SlotState(this.dir, slotName(this.owner, number)).read()?.machine;
				if (machine) machines.add(machine);
			}
			await local.store.transferOwnership(this.parent.parentKey(), previous, transcript);
			// A machine that cannot be reached keeps its agents for the next request there to claim.
			for (const machine of machines) {
				try { await (await this.parent.machine(machine)).store.transferOwnership(this.parent.parentKey(machine), previous, transcript); } catch {}
			}
		}
		recordTranscript(this.dir, this.owner, transcript);
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
		return this.deliver(slot, record, runner, ref, snapshot, reqId, "wait", "");
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
		for (const flag of rest) if (!["--force", "--fresh"].includes(flag)) throw new UsageError(`stop ${flag} is not supported`);
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
			// A request still finishing (launcher checks) would write its slot back; wait for it unless forced.
			if (!force) {
				const now = new AbortController();
				now.abort();
				const release = await slot.lock(now.signal).catch(() => undefined);
				if (!release) { this.io.stderr("sidecar: a request is finishing on this slot; retry, or pass --force\n"); return EXIT.busy; }
				release();
			}
			// A rebound profiled worker must not run the previous checkout's acceptance commands.
			if (record.profile) new Checks(this.dir, slot.name).clear();
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
		const now = new AbortController();
		now.abort();
		let release: () => void;
		try { release = await acquireLock(`${base}.lock`, now.signal); } catch { return EXIT.report; }
		try {
			const local = await this.parent.local();
			while (this.parent.deps.now() < Number(readFileSync(`${base}.until`, "utf8"))) {
				// Remote slots' panes close only while their machines' channels are serviced; slots appear during the pass.
				for (const number of SlotState.slots(this.dir, this.owner)) {
					const machine = new SlotState(this.dir, slotName(this.owner, number)).read()?.machine;
					if (machine) this.parent.remember(machine);
				}
				await this.parent.tick(local, { service: async () => undefined, reportError: () => undefined });
				await this.parent.deps.sleep(this.options.pollMs ?? 1000);
			}
		} finally {
			release();
		}
		return EXIT.report;
	}
}

/** One detached maintenance pass per owner; a newer one replaces nothing while the first still runs. */
export function maintainDetached(env: NodeJS.ProcessEnv = process.env): void {
	const child = spawn(process.execPath, [...NODE_FLAGS, fileURLToPath(import.meta.url), "maintain"], { detached: true, stdio: "ignore", env });
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
