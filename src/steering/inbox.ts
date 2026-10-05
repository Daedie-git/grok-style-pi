import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi session ids in practice (`cc-<uuid>-3`); anything else is not safe to use as a directory name. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
export const STEER_TTL_MS = 10 * 60_000;
/** How long an idle prompt may take to start an agent run before it counts as not admitted. */
export const ADMISSION_MS = 5_000;
const POLL_MS = 250;
const ACK_RETENTION_MS = 60 * 60_000;
const OWNER_FILE = ".owner";

/** Root of all session inboxes: `GROK_STEER_DIR`, else beside the Herdr coordination state. */
export function steerRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.GROK_STEER_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "grok-style-pi", "steer");
}

export type SteerAck = { status: "delivered"; delivery: "steer" | "prompt" } | { status: "rejected"; reason: string };

type Notify = (message: string, kind?: "info" | "warning" | "error") => void;
type SteerContext = { isIdle(): boolean; sessionManager: { getSessionId(): string }; ui: { notify?: Notify } };
type SteerPi = { on: ExtensionAPI["on"]; sendUserMessage: ExtensionAPI["sendUserMessage"] };
type SteerOptions = { root?: string; pollMs?: number; admissionMs?: number; now?: () => number; isAlive?: (pid: number) => boolean };

function writeAck(dir: string, id: string, ack: SteerAck) {
	const tmp = join(dir, `${id}.ack.tmp`);
	writeFileSync(tmp, JSON.stringify(ack));
	renameSync(tmp, join(dir, `${id}.ack`));
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Delivers messages that other processes drop into a per-session inbox, `<root>/<session id>/<id>.json`
 * (`{"text": string, "from"?: string, "sentAt"?: epoch ms}`, written to a temporary name and renamed into place).
 * Each message becomes a user message in the transcript: a steering message while the agent works, a normal prompt
 * while it is idle. The sender learns the outcome from `<id>.ack` next to it.
 *
 * Pi's `sendUserMessage` returns nothing and rejects prompts asynchronously, so admission is established from
 * documented state instead: nothing is dispatched during compaction (the message stays queued), at most one idle
 * prompt is in flight until `agent_start` confirms it (its acknowledgement waits for that), and later messages then
 * steer the active run. One live process owns an inbox; a second watcher for the same session id fails closed.
 */
export function installSteeringInbox(pi: SteerPi, options: SteerOptions = {}) {
	const root = options.root ?? steerRoot();
	const now = options.now ?? Date.now;
	const admissionMs = options.admissionMs ?? ADMISSION_MS;
	const alive = options.isAlive ?? processAlive;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ownedDir: string | undefined;
	let compacting = false;
	let admitting: { dir: string; id: string; from: string; deadline: number } | undefined;

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
		admitting = undefined;
		compacting = false;
		if (ownedDir) rmSync(join(ownedDir, OWNER_FILE), { force: true });
		ownedDir = undefined;
	}
	/** Takes exclusive ownership of the inbox, or reports the live process that holds it. */
	function claimOwnership(dir: string): number | undefined {
		const owner = join(dir, OWNER_FILE);
		for (let attempt = 0; attempt < 2; attempt++) {
			try { writeFileSync(owner, JSON.stringify({ pid: process.pid }), { flag: "wx" }); return undefined; } catch { /* held */ }
			let pid: unknown;
			try { pid = (JSON.parse(readFileSync(owner, "utf8")) as { pid?: unknown } | null)?.pid; } catch { /* unreadable: treat as stale */ }
			if (typeof pid === "number" && pid !== process.pid && alive(pid)) return pid;
			rmSync(owner, { force: true });
		}
		return -1;
	}
	function dispatch(dir: string, name: string, ctx: SteerContext) {
		const id = name.slice(0, -".json".length);
		const claimed = join(dir, `${id}.taken`);
		try { renameSync(join(dir, name), claimed); } catch { return; }
		try {
			let parsed: unknown;
			try { parsed = JSON.parse(readFileSync(claimed, "utf8")); } catch { parsed = undefined; }
			const message = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { text?: unknown; from?: unknown; sentAt?: unknown };
			if (typeof message.text !== "string" || !message.text.trim()) return writeAck(dir, id, { status: "rejected", reason: "empty or invalid message" });
			const sentAt = typeof message.sentAt === "number" ? message.sentAt : statSync(claimed).mtimeMs;
			if (now() - sentAt > STEER_TTL_MS) return writeAck(dir, id, { status: "rejected", reason: "expired before this session read it" });
			const from = typeof message.from === "string" && message.from.trim() ? message.from.trim().slice(0, 60) : "external sender";
			const idle = ctx.isIdle();
			// Idle Pi treats the steering hint as a plain prompt; a run that ends meanwhile still delivers.
			pi.sendUserMessage(`[Steering message from ${from}]\n${message.text}`, { deliverAs: "steer" });
			if (idle) {
				admitting = { dir, id, from, deadline: now() + admissionMs };
				return;
			}
			ctx.ui.notify?.(`Steering message received from ${from}`, "info");
			writeAck(dir, id, { status: "delivered", delivery: "steer" });
		} finally {
			rmSync(claimed, { force: true });
		}
	}
	function settleAdmission(ctx: SteerContext | undefined, outcome: "started" | "late") {
		const pending = admitting;
		if (!pending) return;
		admitting = undefined;
		if (outcome === "started") {
			ctx?.ui.notify?.(`Message received from ${pending.from}`, "info");
			writeAck(pending.dir, pending.id, { status: "delivered", delivery: "prompt" });
		} else {
			ctx?.ui.notify?.(`Message from ${pending.from} was not admitted by Pi`, "warning");
			writeAck(pending.dir, pending.id, { status: "rejected", reason: "Pi did not start a run for the prompt" });
		}
	}
	function sweep(dir: string, ctx: SteerContext) {
		if (admitting) {
			if (now() >= admitting.deadline) settleAdmission(ctx, "late");
			else return;
		}
		// A flag left behind by a cancelled compaction heals once Pi reports itself idle again.
		if (compacting && ctx.isIdle()) compacting = false;
		if (compacting) return;
		let names: string[];
		try { names = readdirSync(dir); } catch { return; }
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			dispatch(dir, name, ctx);
			if (admitting) return;
		}
	}
	function dropOldAcks(dir: string) {
		try {
			for (const name of readdirSync(dir)) {
				if (!name.endsWith(".ack") && !name.endsWith(".taken") && !name.endsWith(".tmp")) continue;
				const path = join(dir, name);
				if (now() - statSync(path).mtimeMs > ACK_RETENTION_MS) rmSync(path, { force: true });
			}
		} catch { /* no inbox yet */ }
	}
	let latest: SteerContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		stop();
		latest = ctx;
		const id = ctx.sessionManager.getSessionId();
		if (!SESSION_ID.test(id)) return;
		const dir = join(root, id);
		try { mkdirSync(dir, { recursive: true }); } catch { return; }
		const holder = claimOwnership(dir);
		if (holder !== undefined) {
			ctx.ui.notify?.(holder > 0 ? `Steering inbox for session ${id} belongs to process ${holder}; not watching it here` : `Could not claim the steering inbox for session ${id}`, "warning");
			return;
		}
		ownedDir = dir;
		dropOldAcks(dir);
		timer = setInterval(() => {
			try { sweep(dir, ctx); } catch (error) { ctx.ui.notify?.(`Steering inbox failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
		}, options.pollMs ?? POLL_MS);
		timer.unref?.();
	});
	pi.on("session_before_compact", () => { compacting = true; });
	pi.on("session_compact", () => { compacting = false; });
	pi.on("session_compact_failed", () => { compacting = false; });
	pi.on("agent_start", () => {
		compacting = false;
		settleAdmission(latest, "started");
	});
	pi.on("session_shutdown", () => { stop(); latest = undefined; });
}
