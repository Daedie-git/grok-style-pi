import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireOwner, processAlive, releaseOwner } from "./owner.ts";

/** Pi session ids in practice (`cc-<uuid>-3`); anything else is not safe to use as a directory name. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
export const STEER_TTL_MS = 10 * 60_000;
/** After this long without Pi reporting a message, the sender is told the outcome is unconfirmed. */
export const CONFIRM_MS = 10_000;
/** An unobserved message keeps further idle submissions waiting this long, so prompts are not submitted concurrently. */
export const SERIALIZE_MS = 15_000;
const POLL_MS = 250;
const ACK_RETENTION_MS = 60 * 60_000;

/** Root of all session inboxes: `GROK_STEER_DIR`, else beside the Herdr coordination state. */
export function steerRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.GROK_STEER_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "grok-style-pi", "steer");
}

export type SteerAck = { status: "delivered"; delivery: "steer" | "prompt" } | { status: "rejected"; reason: string } | { status: "unconfirmed"; reason: string };

type Notify = (message: string, kind?: "info" | "warning" | "error") => void;
type SteerContext = { isIdle(): boolean; sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined }; ui: { notify?: Notify } };
type SteerPi = { on: ExtensionAPI["on"]; sendUserMessage: ExtensionAPI["sendUserMessage"] };
type SteerOptions = { root?: string; pollMs?: number; confirmMs?: number; serializeMs?: number; now?: () => number; isAlive?: (pid: number) => boolean };
type Pending = { dir: string; id: string; from: string; queued: boolean; acked: boolean; confirmBy: number; serializeUntil: number };

function writeAck(dir: string, id: string, ack: SteerAck) {
	const tmp = join(dir, `${id}.ack.tmp`);
	writeFileSync(tmp, JSON.stringify(ack));
	renameSync(tmp, join(dir, `${id}.ack`));
}

/** The header line that carries a message's identity through Pi: `[Steering message from <from> | id <id>]`. */
function header(from: string, id: string) {
	return `[Steering message from ${from} | id ${id}]`;
}
function headerId(text: string): string | undefined {
	return /^\[Steering message from [^\n]*? \| id ([A-Za-z0-9._-]+)\]\n/.exec(text)?.[1];
}
function userText(message: unknown): string | undefined {
	const m = message as { role?: string; content?: unknown } | null;
	if (m?.role !== "user") return undefined;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) return m.content.map((part) => (part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text ?? "" : "").join("");
	return undefined;
}

/**
 * Delivers messages that other processes drop into a per-session inbox, `<root>/<session id>/<id>.json`
 * (`{"text": string, "from"?: string, "sentAt"?: epoch ms}`, written to a temporary name and renamed into place).
 * Each message becomes a user message in the transcript: a steering message while the agent works, a normal prompt
 * while it is idle. The sender learns the outcome from `<id>.ack` next to it.
 *
 * `pi.sendUserMessage` returns nothing and Pi rejects prompts asynchronously, so receipts are tied to the message
 * itself: its header line carries its id, and Pi's own events report what happened to it. A message that Pi's `input`
 * event reports as queued behind a running turn is acknowledged as a steer; an idle prompt is acknowledged when its
 * user message enters the conversation (`message_start`). Anything Pi never reports within 10 s is `unconfirmed`,
 * never delivered or rejected, because it may still run. Idle prompts are submitted one at a time while earlier ones
 * remain unobserved. One live process owns an inbox (see owner.ts).
 */
export function installSteeringInbox(pi: SteerPi, options: SteerOptions = {}) {
	const root = options.root ?? steerRoot();
	const now = options.now ?? Date.now;
	const confirmMs = options.confirmMs ?? CONFIRM_MS;
	const serializeMs = options.serializeMs ?? SERIALIZE_MS;
	const alive = options.isAlive ?? processAlive;
	const pending = new Map<string, Pending>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let owned: { dir: string; token: string } | undefined;
	let latest: SteerContext | undefined;

	function stop() {
		if (timer) clearInterval(timer);
		timer = undefined;
		pending.clear();
		if (owned) releaseOwner(owned.dir, owned.token);
		owned = undefined;
	}
	function acknowledge(entry: Pending, ack: SteerAck, notice?: string) {
		if (entry.acked) return;
		entry.acked = true;
		writeAck(entry.dir, entry.id, ack);
		if (notice) latest?.ui.notify?.(notice, ack.status === "delivered" ? "info" : "warning");
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
			if (!/^[A-Za-z0-9._-]+$/.test(id)) return writeAck(dir, id, { status: "rejected", reason: "invalid message id" });
			const from = (typeof message.from === "string" ? message.from : "").replace(/[\r\n|\]]/g, " ").trim().slice(0, 60) || "external sender";
			pending.set(id, { dir, id, from, queued: false, acked: false, confirmBy: now() + confirmMs, serializeUntil: now() + serializeMs });
			// Idle Pi treats the steering hint as a plain prompt; a run that ends meanwhile still delivers.
			pi.sendUserMessage(`${header(from, id)}\n${message.text}`, { deliverAs: "steer" });
		} finally {
			rmSync(claimed, { force: true });
		}
	}
	function sweep(dir: string, ctx: SteerContext) {
		for (const [id, entry] of pending) {
			if (!entry.acked && now() >= entry.confirmBy) acknowledge(entry, { status: "unconfirmed", reason: "Pi did not report the message entering the conversation; it may still be delivered" }, `Message from ${entry.from} is unconfirmed`);
			if (now() >= entry.serializeUntil) pending.delete(id);
		}
		let names: string[];
		try { names = readdirSync(dir); } catch { return; }
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			// While an earlier message is unobserved and Pi looks idle, a second prompt could race it.
			if (ctx.isIdle() && pending.size > 0) return;
			dispatch(dir, name, ctx);
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
		latest = ctx;
		const id = ctx.sessionManager.getSessionId();
		if (!SESSION_ID.test(id)) return;
		const dir = join(root, id);
		try { mkdirSync(dir, { recursive: true }); } catch { return; }
		const claim = acquireOwner(dir, ctx.sessionManager.getSessionFile?.() ?? null, alive);
		if (!claim.owned) {
			ctx.ui.notify?.(`Steering inbox for session ${id} is not watched here: ${claim.reason}`, "warning");
			return;
		}
		owned = { dir, token: claim.token };
		dropOldAcks(dir);
		timer = setInterval(() => {
			try { sweep(dir, ctx); } catch (error) { ctx.ui.notify?.(`Steering inbox failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
		}, options.pollMs ?? POLL_MS);
		timer.unref?.();
	});
	// Pi emits `input` after its compaction guard, once per submission, with streamingBehavior set only when the
	// message is queued behind a running turn. Our header makes the event ours; a human cannot produce source "extension".
	pi.on("input", (event) => {
		const e = event as { text: string; source?: string; streamingBehavior?: string };
		const id = e.source === "extension" ? headerId(e.text) : undefined;
		const entry = id ? pending.get(id) : undefined;
		if (!entry || !e.streamingBehavior) return;
		entry.queued = true;
		acknowledge(entry, { status: "delivered", delivery: "steer" }, `Steering message received from ${entry.from}`);
	});
	pi.on("message_start", (event) => {
		const text = userText((event as { message: unknown }).message);
		const id = text === undefined ? undefined : headerId(text);
		const entry = id ? pending.get(id) : undefined;
		if (!entry) return;
		acknowledge(entry, { status: "delivered", delivery: entry.queued ? "steer" : "prompt" }, `Message received from ${entry.from}`);
		pending.delete(entry.id);
	});
	pi.on("session_shutdown", () => { stop(); latest = undefined; });
}
