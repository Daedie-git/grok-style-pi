// Launcher-run checks of an implementer's work. They persist on the slot, so answers and idle steers rerun them,
// until another ask replaces them or `--no-checks` clears them.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeManifest, toplevel, gitText } from "./git.ts";

interface SavedChecks {
	cwd: string;
	root: string;
	start: string;
	/** The manifest of the tree when the ask was sent. */
	before: string[];
	/** Escaped name to real path, recorded before the task. */
	names: Record<string, string>;
	accept: string[];
	scope: string[];
}

/** Bash glob matching, where `*` crosses directories. */
export function globMatch(path: string, glob: string): boolean {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") source += ".*";
		else if (c === "?") source += ".";
		else if (c === "\\" && i + 1 < glob.length) source += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		else if (c === "[") {
			const end = glob.indexOf("]", i + 2);
			if (end < 0) source += "\\[";
			else {
				const body = glob.slice(i + 1, end).replace(/^[!^]/, "^").replace(/\\/g, "\\\\");
				source += `[${body}]`;
				i = end;
			}
		} else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	try { return new RegExp(`^${source}$`, "s").test(path); } catch { return false; }
}

const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class Checks {
	private readonly file: string;
	private readonly dir: string;
	constructor(dir: string, slotName: string) {
		this.dir = dir;
		this.file = join(dir, `${slotName}.checks.json`);
	}

	private read(): SavedChecks | undefined {
		if (!existsSync(this.file)) return undefined;
		try { return JSON.parse(readFileSync(this.file, "utf8")) as SavedChecks; } catch { return undefined; }
	}

	active(): boolean { return !!this.read(); }
	clear(): void { rmSync(this.file, { force: true }); }

	/** Records the commands and scope with the tree as it is now. Throws Error with the launcher's message. */
	save(cwd: string, accept: string[], scope: string[]): void {
		const root = toplevel(cwd);
		if (!root) throw new Error("--accept and --scope need a git checkout; run the ask from the implementer's checkout");
		const start = gitText(cwd, ["rev-parse", "HEAD"])!;
		// Files already dirty before the task are not the implementer's unless they change again.
		const before = changeManifest(cwd, start, this.dir);
		if (!before) throw new Error("could not fingerprint the working tree");
		writeFileSync(this.file, JSON.stringify({ cwd, root, start, before: before.lines, names: Object.fromEntries(before.names), accept, scope } satisfies SavedChecks) + "\n");
	}

	/** The implementer's completion contract, with what the launcher will check. */
	contract(): string {
		const checks = this.read();
		const lines = [
			"## Completion contract",
			"",
			"- First line of your report: `Status: done`, `Status: partial` or `Status: blocked`. Partial work is never done.",
			"- Exercise the change through the real entry point a user or caller uses (the CLI command, editor action, app or service run), not only tests that call internals directly. A section `## Verified` quotes each command you ran and its result.",
			"- A section `## Not verified` lists what you did not run (GPU, other platforms, slow suites) and why.",
			"- Change only what the task needs, as the smallest diff in the surrounding code's style. List anything else you think should change under `## Suggested follow-ups` instead of doing it. A section `## Files changed` lists every file you touched.",
			"- A section `## Additions` names each new function, type, option, flag, fallback, file or dependency you added and the part of the task that required it, or says `none`. Remove any addition the task does not require before reporting.",
		];
		if (checks) {
			for (const command of checks.accept) lines.push(`- After your report, the launcher runs \`${command}\` itself in \`${checks.cwd}\` and shows its result to Claude. Run it first.`);
			if (checks.scope.length) lines.push(`- Scope: change only files matching ${checks.scope.map((glob) => `\`${glob}\``).join(", ")}. The launcher flags any other file you change.`);
		}
		return lines.join("\n");
	}

	/** Prepends the launcher's own scope and acceptance results to REPORT, whose log files go next to REPORT_PATH. */
	async run(report: string, reportPath: string, env: NodeJS.ProcessEnv): Promise<string> {
		const checks = this.read();
		if (!checks) return report;
		const out = ["## Launcher checks", "", `Run by the launcher after the sidecar reported, in \`${checks.cwd}\`.`, ""];
		if (checks.scope.length) {
			const now = changeManifest(checks.root, checks.start, this.dir);
			if (now) {
				// Both sides: a file the task created or edited, and a dirty file it reverted or deleted.
				const before = new Set(checks.before);
				const after = new Set(now.lines);
				const keys = new Set<string>();
				for (const line of before) if (!after.has(line)) keys.add(line.split("\t")[0]);
				for (const line of after) if (!before.has(line)) keys.add(line.split("\t")[0]);
				const outside = [...keys].filter(Boolean).sort(byBytes).filter((key) => {
					const path = now.names.get(key) ?? checks.names[key] ?? key;
					return !checks.scope.some((glob) => globMatch(path, glob));
				});
				out.push(outside.length ? `- **Outside the stated scope:** ${outside.join(" ")}` : `- Scope: every changed file is within ${checks.scope.join(", ")}.`);
			} else out.push(`- Scope: could not fingerprint \`${checks.root}\`.`);
		}
		const limit = Number(env.SIDECAR_ACCEPT_TIMEOUT_S ?? 1800) * 1000;
		let n = 0;
		for (const command of checks.accept) {
			const log = `${reportPath.replace(/\.md$/, "")}.accept-${++n}.log`;
			const code = await runCommand(command, checks.cwd, log, limit);
			const tail = readFileSync(log, "utf8").replace(/\n$/, "").split("\n").slice(-20).join("\n");
			out.push(`- Acceptance \`${command}\`: ${code === 0 ? "**PASS**" : `**FAIL, exit ${code}**`} (log: ${log})`, "", "```", ...(tail ? [tail] : []), "```");
		}
		out.push("", report);
		return out.join("\n");
	}
}

/** Runs `bash -c COMMAND` with output to LOG. Children it leaves behind do not delay the result. */
function runCommand(command: string, cwd: string, log: string, limit: number): Promise<number> {
	const fd = openSync(log, "w");
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", fd, fd], detached: true });
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGTERM"); } catch {} }, limit);
		const finish = (code: number) => { clearTimeout(timer); closeSync(fd); resolve(code); };
		child.on("error", () => finish(127));
		child.on("exit", (code, signal) => finish(timedOut ? 124 : code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1)));
	});
}
