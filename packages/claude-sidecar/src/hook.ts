// SessionStart support: which Claude may own sidecars, and the context the hook gives it.
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { HerdrMachine } from "../herdr-runner/src/client.ts";

/**
 * 0: an interactive Claude owns this hook. 1: a print-mode Claude, or a sidecar's own Claude, which must not start
 * sidecars. 2: undetermined (no /proc), treated as an owner that sweeps leave alone.
 */
export function claudeAncestry(start: number, proc = "/proc"): 0 | 1 | 2 {
	for (let pid = start; pid > 1;) {
		let argv: string[];
		try { argv = readFileSync(join(proc, String(pid), "cmdline"), "utf8").split("\0").filter((word, i, all) => word || i < all.length - 1); }
		catch { return 2; }
		const base = (word = "") => word.replaceAll("\\", "/").toLowerCase().split("/").pop() ?? "";
		const executable = base(argv[0]);
		const script = (argv[1] ?? "").replaceAll("\\", "/").toLowerCase();
		const claude = executable === "claude" || executable === "claude.exe"
			|| ((executable === "node" || executable === "node.exe") && (["claude", "claude.exe"].includes(base(script)) || script.endsWith("/claude-code/cli.js")));
		if (claude) {
			for (let i = 1; i < argv.length; i++) {
				const word = argv[i];
				if (word === "-p" || word === "--print" || word.startsWith("--print=")) return 1;
				if (((word === "-n" || word === "--name") && argv[i + 1] === "claude-sidecar") || word === "--name=claude-sidecar") return 1;
			}
			return 0;
		}
		try { pid = Number(readFileSync(join(proc, String(pid), "stat"), "utf8").replace(/^.*\) /s, "").split(" ")[1]); }
		catch { return 2; }
	}
	return 2;
}

export function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
	const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
	return (env.PATH ?? "").split(delimiter).some((dir) => dir && names.some((name) => existsSync(join(dir, name))));
}

export function sessionContext(machines: HerdrMachine[], cli: string): string {
	const enabled = machines.filter((machine) => machine.enabled).map((machine) => machine.label === machine.target ? machine.label : `${machine.label} (${machine.target})`);
	return "Persistent pi and Claude Code sidecars are available on demand in Herdr; none is started at startup. Follow the claude-sidecar:sidecar-review skill and drive them with the mcp__claude-sidecar__sidecar tool, one call per request; each result arrives as a message. Requests start their sidecar automatically. Use --slot N before a command for independent parallel sidecars; reuse that slot for follow-ups and answers."
		+ (enabled.length ? ` Use --machine NAME before a command to run that slot's sidecar on a saved ${cli} machine, only when the user asks; the slot then stays on that machine, and edits it makes land in that machine's checkout. Saved machines: ${enabled.join(", ")}.` : "");
}
