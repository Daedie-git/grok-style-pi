import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrMachine } from "./client.ts";

export interface MachineSettings {
	cwd: string;
}

export interface HerdrSettings {
	machines: Record<string, MachineSettings>;
	/** False keeps finished panes open. */
	closeWhenDone: boolean;
}

/** User-level settings shared by local and saved-machine runners. */
export function readHerdrSettings(agentDir: string): HerdrSettings {
	const path = join(agentDir, "herdr-subagents.json");
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { machines: {}, closeWhenDone: true };
		throw error;
	}
	try {
		const config: unknown = JSON.parse(text);
		if (!record(config)) throw new Error("expected a settings object");
		if (config.machines !== undefined && !record(config.machines)) throw new Error("expected a machines object");
		const closeWhenDone = config.closeWhenDone === undefined ? true : config.closeWhenDone;
		if (typeof closeWhenDone !== "boolean") throw new Error("closeWhenDone must be true or false");
		const machines: Record<string, MachineSettings> = Object.create(null);
		for (const [selector, settings] of Object.entries(config.machines ?? {})) {
			if (!record(settings) || typeof settings.cwd !== "string" || !settings.cwd.trim()) {
				throw new Error(`machines.${selector}.cwd must be a nonempty absolute directory`);
			}
			// Absolute paths are checked on the target machine, not with the local OS's rules.
			machines[selector] = { cwd: settings.cwd.trim() };
		}
		return { machines, closeWhenDone };
	} catch (error) {
		throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Compatibility API for callers that only need saved-machine directories. */
export function readMachineSettings(agentDir: string): Record<string, MachineSettings> {
	return readHerdrSettings(agentDir).machines;
}

export function machineDefaultCwd(selector: string, machines: HerdrMachine[], settings: Record<string, MachineSettings>): string | undefined {
	const byLabel = machines.filter((machine) => machine.label === selector);
	const machine = machines.find((machine) => machine.id === selector) ?? (byLabel.length === 1 ? byLabel[0] : undefined);
	if (!machine) return Object.hasOwn(settings, selector) ? settings[selector].cwd : undefined;
	if (Object.hasOwn(settings, machine.id)) return settings[machine.id].cwd;
	if (machines.filter((item) => item.label === machine.label).length === 1 && Object.hasOwn(settings, machine.label)) return settings[machine.label].cwd;
	return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
