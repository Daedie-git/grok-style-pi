import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTarget } from "./open-in-cursor.ts";

export const FILE_LINK_SCHEME = "grok-pi-file";
const LINK = /^grok-pi-file:\/\/open\/([a-f0-9]{32})\/([a-f0-9]{64})$/;
const TIMEOUT = 90_000;

function socketDirectory(): string {
	return join(tmpdir(), `grok-pi-links-${process.getuid?.() ?? "user"}`);
}

function checkDirectory(directory: string, create: boolean): void {
	if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
		throw new Error("The Pi file-link socket directory must be private and owned by the current user.");
	}
}

/** Session-owned transport. Only rendered targets can be opened; URLs contain no commands or file paths. */
export function createFileLinkBridge(open: (target: OpenTarget) => Promise<boolean>, directory = socketDirectory()) {
	let token = randomBytes(16).toString("hex");
	const targets = new Map<string, OpenTarget>();
	let server: Server | undefined;
	const sockets = new Set<Socket>();
	return {
		urlFor(target: OpenTarget): string {
			const id = createHash("sha256").update(JSON.stringify(target)).digest("hex");
			targets.set(id, { ...target });
			return `${FILE_LINK_SCHEME}://open/${token}/${id}`;
		},
		start(onError: (error: Error) => void): void {
			if (server) return;
			checkDirectory(directory, true);
			const activeToken = token;
			server = createServer(socket => {
				sockets.add(socket);
				socket.unref();
				socket.setTimeout(TIMEOUT, () => socket.destroy());
				socket.on("error", () => {});
				socket.on("close", () => sockets.delete(socket));
				let input = "", requested = false;
				socket.on("data", data => {
					if (requested) return;
					input += data.toString("utf8");
					if (input.length > 65) { socket.destroy(); return; }
					if (!input.endsWith("\n")) return;
					requested = true;
					const id = input.slice(0, -1);
					const target = /^[a-f0-9]{64}$/.test(id) ? targets.get(id) : undefined;
					if (!target || token !== activeToken) { socket.end("expired\n"); return; }
					void (async () => {
						try {
							const opened = await open({ ...target });
							if (!socket.destroyed) socket.end(opened ? "ok\n" : "failed\n");
						} catch {
							if (!socket.destroyed) socket.end("failed\n");
						}
					})();
				});
			});
			server.on("error", onError);
			server.listen(join(directory, `${token}.sock`));
			server.unref();
		},
		stop(): void {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			server?.close();
			server = undefined;
			targets.clear();
			token = randomBytes(16).toString("hex");
		},
	};
}

/** Called by the desktop URL handler, not Pi. Never launches an editor independently. */
export async function dispatchFileLink(url: string, directory = socketDirectory()): Promise<void> {
	const match = LINK.exec(url);
	if (!match) throw new Error("Invalid Pi file link.");
	checkDirectory(directory, false);
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(join(directory, `${match[1]}.sock`));
		const fail = () => { socket.destroy(); reject(new Error("The Pi file link expired or could not be opened. Reload its Pi session and try again.")); };
		socket.setTimeout(TIMEOUT, fail);
		socket.on("error", fail);
		socket.on("connect", () => socket.write(`${match[2]}\n`));
		let response = "";
		socket.on("data", data => {
			response += data.toString("utf8");
			if (response.length > 64) fail();
		});
		socket.on("end", () => {
			if (response === "ok\n") { socket.destroy(); resolve(); }
			else fail();
		});
	});
}
