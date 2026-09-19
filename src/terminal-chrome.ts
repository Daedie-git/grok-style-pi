/** GrokNight canvas — same values as Grok Build, not the host terminal theme. */
export const GROK_FG = "#f3f3f3";
export const GROK_BG = "#141414";
export const GROK_CURSOR = "#bb9af7";

export function grokTerminalOscApply(): string {
	return `\x1b]10;${GROK_FG}\x07\x1b]11;${GROK_BG}\x07\x1b]12;${GROK_CURSOR}\x07`;
}

export function grokTerminalOscReset(): string {
	return "\x1b]110\x07\x1b]111\x07\x1b]112\x07";
}

export function applyGrokTerminalChrome(write: (data: string) => void): void {
	write(grokTerminalOscApply());
}

export function resetGrokTerminalChrome(write: (data: string) => void): void {
	write(grokTerminalOscReset());
}

export type TerminalLike = { write: (data: string) => void };
export type TuiLike = { terminal?: TerminalLike };

export function tuiWrite(tui: unknown): ((data: string) => void) | undefined {
	const write = (tui as TuiLike | undefined)?.terminal?.write;
	if (typeof write !== "function") return undefined;
	return (data) => write.call((tui as TuiLike).terminal, data);
}

/** Reset before Pi's suspend action; do not intercept SIGTSTP itself. */
export function suspendTerminalChrome(write: (data: string) => void, resumeEvents: Pick<NodeJS.Process, "once" | "removeListener"> = process) {
	let waiting = false;
	const resume = () => {
		waiting = false;
		applyGrokTerminalChrome(write);
	};
	const dispose = () => {
		resumeEvents.removeListener("SIGCONT", resume);
		waiting = false;
	};
	return {
		dispose,
		run(suspend: () => void) {
			if (process.platform === "win32") return suspend();
			resetGrokTerminalChrome(write);
			if (!waiting) { waiting = true; resumeEvents.once("SIGCONT", resume); }
			try { suspend(); }
			catch (error) { dispose(); applyGrokTerminalChrome(write); throw error; }
		},
	};
}
