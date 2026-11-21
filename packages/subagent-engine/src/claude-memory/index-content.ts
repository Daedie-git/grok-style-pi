import { constants } from "node:fs";
import { open } from "node:fs/promises";

const FILE_LIMIT = 4 * 1024 * 1024;
const LINES = 200;
const UNITS = 25_000;

// Claude Code 2.1.330 `Pyo`: limits are measured before sanitization, in UTF-16 units, despite the KB label.
function boundedIndex(raw: string): string {
	const text = raw.trim();
	const lines = text.split("\n");
	const overLines = lines.length > LINES;
	const overUnits = text.length > UNITS;
	if (!overLines && !overUnits) return text;
	let kept = overLines ? lines.slice(0, LINES).join("\n") : text;
	if (kept.length > UNITS) {
		const newline = kept.lastIndexOf("\n", UNITS);
		kept = kept.slice(0, newline > 0 ? newline : UNITS);
	}
	const count = text[kept.length] === "\n" ? kept.split("\n").length : 0;
	const firstMissing = count ? lines[count].trim() : "";
	const prefix = firstMissing.slice(0, 79).replace(/[\uD800-\uDBFF]$/, "");
	const word = prefix.replace(/\s\S*$/, "").trimEnd();
	const example = firstMissing.length <= 80 ? firstMissing : `${word.length < prefix.length && word.length > 40 ? word : prefix.trimEnd()}…`;
	const omission = count ? `${lines.length - count} of ${lines.length} lines were cut off, starting at line ${count + 1}${example ? ` ("${example}")` : ""}` : `everything after the first ${kept.length} characters of line 1 was cut off`;
	const size = (n: number) => n < 1024 ** 2 ? `${Number((n / 1024).toFixed(1))}KB` : `${Number((n / 1024 ** 2).toFixed(1))}MB`;
	const total = overLines ? `${lines.length} lines${overUnits ? ` and ${size(text.length)}` : ` (limit: ${LINES})`}` : `${size(text.length)} (limit: ${size(UNITS)}) — index entries are too long`;
	return `${kept}\n\n> WARNING: MEMORY.md is ${total}. Only part of it was loaded: ${omission}. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

// Only block comments are omitted; inline comments and examples in fenced/indented code are index content.
function diskBody(text: string): string {
	const body = text.replace(/^\uFEFF?---\s*\n[\s\S]*?---\s*\n?/, "");
	if (!body.includes("<!--")) return body;
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	const output: string[] = [];
	let fence = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (mark && mark[1].startsWith(fence) && !mark[2].trim()) fence = "";
		} else if (mark && !(mark[1][0] === "`" && mark[2].includes("`"))) fence = mark[1];
		else if (/^ {0,3}<!--/.test(line)) {
			let end = i;
			while (end < lines.length && !lines[end].includes("-->")) end++;
			if (end === lines.length) return output.concat(lines.slice(i)).join("\n");
			const tail = lines.slice(i, end + 1).join("\n").replace(/<!--[\s\S]*?-->/g, "");
			if (tail.trim()) output.push(tail);
			i = end;
			continue;
		}
		output.push(line);
	}
	return output.join("\n");
}

const reserved = "bash-input bash-stdout bash-stderr bash-exit-code local-command-stdout local-command-stderr local-command-caveat command-name command-message command-args task-notification agent-message teammate-message cross-session-message remote-review slack-ping slack-tag-message tick fetched-web-content untrusted-widget-state coordinator-relay artifact-type-instructions cowritten-artifact-html artifact-file-content artifact-origin-notes artifact-stored-declaration system-reminder function-results tool-use-error sandbox-violations persisted-output total-tokens user-prompt-submit-hook".split(" ").join("|").replaceAll("-", "[-_]");
const reservedTag = new RegExp(`^[^a-z0-9_<>\\\\-]*(?:(?:${reserved})(?![a-z0-9_-])|antml:|channel(?![a-z0-9_-])[^>]{0,120}\\bsource\\s*=)`, "iu");

function sanitize(raw: string): string {
	const text = raw.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{DI}\p{Cc}]/gu, (ch) => /[\t\n\u200c\u200d\ufe0e\ufe0f]/u.test(ch) ? ch : "");
	// Keep ordinary Markdown and HTML intact. Reserved system/tool tag openers are displayed inertly (`<\...`).
	return text.replace(/[<＜﹤‹〈⟨]/gu, (open: string, offset: number) => {
		const tail = text.slice(offset + open.length, offset + 256).normalize("NFKC").replace(/[\p{Pd}\u2212]/gu, "-");
		return reservedTag.test(tail) ? "<\\" : open;
	}).trim();
}

/** Startup AutoMem reference for the main model. Overrides supply the body verbatim, bypassing Markdown preprocessing. */
export async function readMemoryIndex(path: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (/^(?:1|true|yes|on)$/i.test(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS?.trim() ?? "")) return;
	let raw = env.CLAUDE_COWORK_MEMORY_INDEX_CONTENT;
	if (raw === undefined) {
		// O_NONBLOCK keeps a FIFO from hanging startup before fstat can reject it.
		const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
		if (!file) return;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > FILE_LIMIT) return;
			const data = Buffer.alloc(stat.size + 1);
			let used = 0;
			while (used < data.length) {
				const { bytesRead } = await file.read(data, used, data.length - used);
				if (!bytesRead) break;
				used += bytesRead;
			}
			if (used > stat.size) return;
			raw = diskBody(data.toString("utf8", 0, used));
		} catch { return; } finally { await file.close(); }
	}
	const body = sanitize(boundedIndex(raw));
	if (!body) return;
	return `<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of ${path} (user's auto-memory, persists across conversations):\n\n${body}\n</system-reminder>`;
}
