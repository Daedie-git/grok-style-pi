// sync-machine: fast-forwards a saved machine's tooling checkouts from origin by running scripts/sync-machine.cjs there.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface MachineConfig { tooling?: Record<string, unknown>; home?: string; paths?: Record<string, string> }

/** Options for the remote program, as the Bash launcher computed them. */
export function syncOptions(config: MachineConfig, cwd: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
	const timeout = Number(env.SIDECAR_SYNC_TIMEOUT_S ?? 60);
	if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("SIDECAR_SYNC_TIMEOUT_S must be a positive integer");
	const mapping = Object.entries(config.paths ?? {}).map(([prefix, value]) => [prefix.replace(/\/+$/, ""), value] as const)
		.filter(([prefix]) => cwd === prefix || cwd.startsWith(prefix + "/"))
		.sort((a, b) => a[0].length - b[0].length).at(-1);
	return {
		tooling: config.tooling ?? {},
		runtimeHome: env.SIDECAR_REMOTE_HOME || config.home || null,
		workDir: mapping ? mapping[1] + cwd.slice(mapping[0].length) : null,
		timeoutMs: timeout * 1000,
	};
}

/** A base64 program inside double quotes runs under both cmd.exe and POSIX shells; arguments travel inside it. */
export function remoteNodeCommand(program: string, args: unknown[]): string {
	const source = `const fs=require("fs"),path=require("path"),os=require("os");const args=${JSON.stringify(args.map(String))};\n${program}`;
	return `node -e "eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())"`;
}

export function syncMachine(machine: { id: string; label: string; target: string }, cwd: string, env: NodeJS.ProcessEnv, out: (text: string) => void): number {
	const file = env.SIDECAR_MACHINES_FILE || join(env.HOME || homedir(), ".config", "claude-sidecar", "machines.json");
	let config: MachineConfig = {};
	if (existsSync(file)) {
		try {
			const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, MachineConfig>;
			config = all[machine.id] ?? all[machine.label] ?? {};
		} catch { throw new Error(`invalid machine configuration: ${file}`); }
	}
	const program = readFileSync(new URL("../scripts/sync-machine.cjs", import.meta.url), "utf8");
	const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", machine.target,
		remoteNodeCommand('eval(fs.readFileSync(0,"utf8"));', [JSON.stringify(syncOptions(config, cwd, env))])], { input: program, stdio: ["pipe", "inherit", "inherit"] });
	if (result.status === 0) { out(`${machine.label} tooling synchronized\n`); return 0; }
	if (result.status === 255) throw new Error(`cannot reach ${machine.label} (${machine.target}) over SSH; test: ssh ${machine.target} true`);
	throw new Error(`tooling sync failed on ${machine.label} (exit ${result.status ?? "signal"}); check the checkout/SSH/Git messages above`);
}
