import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi session ids in practice (`cc-<uuid>-3`); anything else is not safe to use as a directory name. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
export const STEER_TTL_MS = 10 * 60_000;
const POLL_MS = 250;
const ACK_RETENTION_MS = 60 * 60_000;

/** Root of all session inboxes: `GROK_STEER_DIR`, else beside the Herdr coordination state. */
export function steerRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.GROK_STEER_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "grok-style-pi", "steer");
}

export type SteerAck = { status: "delivered"; delivery: "steer" | "prompt" } | { status: "rejected"; reason: string };

type SteerContext = { isIdle(): boolean; sessionManager: { getSessionId(): string }; ui: { notify?(message: string, kind?: "info" | "warning" | "error"): void } };
type SteerPi = { on: ExtensionAPI["on"]; sendUserMessage: ExtensionAPI["sendUserMessage"] };
type SteerOptions = { root?: string; pollMs?: number; now?: () => number };

function writeAck(dir: string, id: string, ack: SteerAck) {
	const tmp = join(dir, `${id}.ack.tmp`);
	writeFileSync(tmp, JSON.stringify(ack));
	renameSync(tmp, join(dir, `${id}.ack`));
}

/**
 * Delivers messages that other processes drop into a per-session inbox, `<root>/<session id>/<id>.json`
 * (`{"text": string, "from"?: string, "sentAt"?: epoch ms}`, written to a temporary name and renamed into place).
 * Each message becomes a user message in the transcript: a steering message while the agent works, a normal prompt
 * while it is idle. The sender learns the outcome from `<id>.ack` next to it.
 */
export function installSteeringInbox(pi: SteerPi, options: SteerOptions = {}) {
	const root = options.root ?? steerRoot();
	const now = options.now ?? Date.now;
	let timer: ReturnType<typeof setInterval> | undefined;
	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}
	function deliver(dir: string, name: string, ctx: SteerContext) {
		const id = name.slice(0, -".json".length);
		const claimed = join(dir, `${id}.taken`);
		try { renameSync(join(dir, name), claimed); } catch { return; }
		try {
			let message: { text?: unknown; from?: unknown; sentAt?: unknown };
			try { message = JSON.parse(readFileSync(claimed, "utf8")); } catch { message = {}; }
			if (typeof message.text !== "string" || !message.text.trim()) return writeAck(dir, id, { status: "rejected", reason: "empty or invalid message" });
			const sentAt = typeof message.sentAt === "number" ? message.sentAt : statSync(claimed).mtimeMs;
			if (now() - sentAt > STEER_TTL_MS) return writeAck(dir, id, { status: "rejected", reason: "expired before this session read it" });
			const from = typeof message.from === "string" && message.from.trim() ? message.from.trim().slice(0, 60) : "external sender";
			const delivery = ctx.isIdle() ? "prompt" : "steer";
			// Idle Pi treats the steering hint as a plain prompt, so a turn that ends meanwhile still delivers.
			pi.sendUserMessage(`[Steering message from ${from}]\n${message.text}`, { deliverAs: "steer" });
			ctx.ui.notify?.(delivery === "steer" ? `Steering message received from ${from}` : `Message received from ${from}`, "info");
			writeAck(dir, id, { status: "delivered", delivery });
		} finally {
			rmSync(claimed, { force: true });
		}
	}
	function sweep(dir: string, ctx: SteerContext) {
		let names: string[];
		try { names = readdirSync(dir); } catch { return; }
		for (const name of names.sort()) {
			if (name.endsWith(".json")) deliver(dir, name, ctx);
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
	pi.on("session_start", (_event, ctx) => {
		stop();
		const id = ctx.sessionManager.getSessionId();
		if (!SESSION_ID.test(id)) return;
		const dir = join(root, id);
		try { mkdirSync(dir, { recursive: true }); } catch { return; }
		dropOldAcks(dir);
		timer = setInterval(() => {
			try { sweep(dir, ctx); } catch (error) { ctx.ui.notify?.(`Steering inbox failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
		}, options.pollMs ?? POLL_MS);
		timer.unref?.();
	});
	pi.on("session_shutdown", stop);
}
