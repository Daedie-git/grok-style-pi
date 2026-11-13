// Cooperative review: a Pi and a Claude Code reviewer each review the same change, then each checks the other's
// findings. The combined report decides nothing; the caller adjudicates. Ported from the Bash launcher's coop-review.

export interface Finding { id: string; title: string; body: string }

/** CommonMark-style fences: the launcher's awk tracked them so headings inside code blocks are not structure. */
class Fences {
	private open = false;
	private char = "";
	private length = 0;
	/** True for a fence line, which also toggles the state. */
	line(text: string): boolean {
		const match = /^( *)(`{3,}|~{3,})/.exec(text);
		if (!match || match[1].length > 3) return false;
		const fence = match[2];
		const rest = text.slice(match[0].length);
		if (!this.open) {
			if (fence[0] === "`" && rest.includes("`")) return false;
			this.open = true;
			this.char = fence[0];
			this.length = fence.length;
			return true;
		}
		if (fence[0] === this.char && fence.length >= this.length && /^[ \t]*$/.test(rest)) { this.open = false; return true; }
		return false;
	}
	get inside(): boolean { return this.open; }
}

const lines = (text: string) => text.split("\n").map((line) => line.replace(/\r$/, ""));
const chomp = (text: string) => text.replace(/\n+$/, "");

/** A reviewer's findings are its `### N. Title` headings, numbered in order and tagged with PREFIX (P1, C2, ...). */
export function inventory(report: string, prefix: string): Finding[] {
	const findings: Finding[] = [];
	const fences = new Fences();
	let current: Finding | undefined;
	const flush = () => { if (current) findings.push({ ...current, body: chomp(current.body) }); current = undefined; };
	for (const line of lines(report)) {
		if (fences.line(line) || fences.inside) { if (current) current.body += line + "\n"; continue; }
		if (/^#{1,3} /.test(line)) flush();
		if (line.startsWith("### ")) {
			const title = line.replace(/^### +/, "").replace(/^[0-9]+[.):]? +/, "").replace(/[ \t]+$/, "").replaceAll("\t", " ");
			current = { id: `${prefix}${findings.length + 1}`, title, body: "" };
			continue;
		}
		if (current) current.body += line + "\n";
	}
	flush();
	return findings;
}

const list = (findings: Finding[]) => findings.map((finding) => `- ${finding.id}: ${finding.title}`).join("\n");

/** The cross-verification request: the peer's report to check, the IDs to cite, and the entry format combine() parses. */
export function verifyRequest(peer: string, report: string, peerFindings: Finding[], ownFindings: Finding[]): string {
	return `# Cooperative review: check ${peer}'s findings

${peer} reviewed the same change independently. Its report is below. Do not re-review the change from scratch: check each of its findings against the code, reproducing where you can.

## Findings to check

${list(peerFindings)}
${peerFindings.length ? "" : "(none found: its report has no `###` finding headings)"}

Answer with exactly one entry per finding above, citing its ID, using exactly these headings so the launcher can combine the reports:

\`\`\`
### [CONFIRMED] <ID> <title>
Evidence: <command and its output, or file:line>

### [REJECTED] <ID> <title>
Reason: <why it is wrong, with evidence>
\`\`\`

Use \`[UNVERIFIED]\` with the reason only when you cannot decide either way. If you reported the same issue yourself, say so in the evidence. Findings with no entry count as unchecked.

## Your own findings

${list(ownFindings)}

If this report shows one of your own findings to be wrong, add \`### [WITHDRAWN] <your ID> <title>\` with the reason. Do not edit files. Use \`###\` headings only for these entries.

## ${peer}'s report

${report.replace(/\n+$/, "")}`;
}

type Kind = "CONFIRMED" | "REJECTED" | "UNVERIFIED" | "WITHDRAWN";
interface Entry { kind: Kind; id: string; title: string; body: string }

const ENTRY = /^### *\[(CONFIRMED|REJECTED|UNVERIFIED|WITHDRAWN)\]/i;

function entries(report: string): Entry[] {
	const found: Entry[] = [];
	const fences = new Fences();
	let current: Entry | undefined;
	const save = () => { if (current) found.push({ ...current, body: chomp(current.body) }); current = undefined; };
	for (const line of lines(report)) {
		if (fences.line(line) || fences.inside) { if (current) current.body += line + "\n"; continue; }
		const entry = ENTRY.exec(line);
		if (!entry && /^#{1,2} /.test(line)) { save(); continue; }
		if (entry) {
			save();
			let rest = line.slice(line.toUpperCase().indexOf("]") + 1).trim();
			let id = "";
			const word = rest.split(/[ \t]/)[0];
			if (/^[A-Z][0-9]+:?$/.test(word.toUpperCase())) { id = word.toUpperCase().replace(/:$/, ""); rest = rest.slice(word.length).trim(); }
			current = { kind: entry[1].toUpperCase() as Kind, id, title: rest, body: "" };
			continue;
		}
		if (current) current.body += line + "\n";
	}
	save();
	return found;
}

const norm = (text: string) => text.toLowerCase().replace(/[ \t]+/g, " ").trim();

/**
 * Combines both reviews and their checks into three sections. Every inventoried finding lands in exactly one.
 * Confirmed by both: confirmed by the peer and not withdrawn. Rejected by both: rejected by the peer and withdrawn by
 * its author. Everything else (rejected only, unverified, unchecked, repeated, or a lone withdrawal) is disputed.
 * Entries that match no finding are flagged, never reported as findings.
 */
export function combine(labels: [string, string], findings: [Finding[], Finding[]], verifications: [string, string]): string {
	const who = (side: number) => labels[side];
	const owner = new Map<string, [number, number]>();
	const titles = [new Map<string, number[]>(), new Map<string, number[]>()];
	findings.forEach((side, o) => side.forEach((finding, i) => {
		owner.set(finding.id.toUpperCase(), [o, i]);
		const key = norm(finding.title);
		titles[o].set(key, [...titles[o].get(key) ?? [], i]);
	}));
	const checks = findings.map((side) => side.map(() => [] as Entry[]));
	const withdrawn = findings.map((side) => side.map(() => undefined as Entry | undefined));
	const unmatched: string[] = [];
	verifications.forEach((report, r) => {
		for (const entry of entries(report)) {
			const want = entry.kind === "WITHDRAWN" ? r : 1 - r;
			let index: number | undefined;
			let why = "";
			const key = norm(entry.title);
			const owned = entry.id ? owner.get(entry.id) : undefined;
			if (owned) {
				if (owned[0] !== want) why = `ID ${entry.id} belongs to ${who(owned[0])}'s findings`;
				else if (key && key !== norm(findings[want][owned[1]].title) && titles[want].has(key)) why = `it cites ${entry.id} but its title matches another finding`;
				else index = owned[1];
			} else {
				const matches = titles[want].get(key) ?? [];
				if (matches.length === 1) index = matches[0];
				else if (matches.length > 1) why = `its title matches several of ${who(want)}'s findings and it cites no ID`;
				else why = `no finding of ${who(want)} has this ID or title`;
			}
			if (index === undefined) {
				unmatched.push(`- ${who(r)} entry \`[${entry.kind}] ${entry.id} ${entry.title}\` matches no finding (${why}); ignored.`);
				continue;
			}
			if (entry.kind === "WITHDRAWN") withdrawn[want][index] ??= entry;
			else checks[want][index].push(entry);
		}
	});
	const both: string[] = [], disputed: string[] = [], rejected: string[] = [];
	findings.forEach((side, o) => side.forEach((finding, i) => {
		const v = 1 - o;
		const seen = checks[o][i];
		const gone = withdrawn[o][i];
		const head = `### ${finding.id}: ${finding.title}\nOrigin: ${who(o)}. `;
		const argument = `\n\n**${who(o)}'s finding:**\n\n${finding.body}`;
		if (seen.length === 1 && seen[0].kind === "CONFIRMED" && !gone) {
			both.push(`${head}Confirmed by ${who(v)}.${argument}\n\n**${who(v)}'s evidence:** ${seen[0].body}`);
		} else if (seen.length === 1 && seen[0].kind === "REJECTED" && gone) {
			rejected.push(`${head}Rejected by ${who(v)} and withdrawn by ${who(o)}.${argument}\n\n**${who(v)} rejected:** ${seen[0].body}\n\n**${who(o)} withdrew:** ${gone.body}`);
		} else {
			const state = seen.length === 0 ? `${who(v)} did not check it; unverified`
				: seen.length > 1 ? `${who(v)} gave ${seen.length} conflicting or repeated entries (flagged); unverified`
				: seen[0].kind === "REJECTED" ? `${who(v)} rejected it`
				: seen[0].kind === "CONFIRMED" ? `${who(v)} confirmed it`
				: `${who(v)} could not decide; unverified`;
			let out = `${head}${state}${gone ? `; ${who(o)} withdrew it` : ""}.${argument}`;
			for (const check of seen) out += `\n\n**${who(v)}'s check (${check.kind.toLowerCase()}):** ${check.body}`;
			if (gone) out += `\n\n**${who(o)} withdrew:** ${gone.body}`;
			disputed.push(out);
		}
	}));
	const warnings: string[] = [];
	findings.forEach((side, o) => {
		if (!side.length) warnings.push(`- No findings were extracted from ${who(o)}'s review (expected \`### N. Title\` headings); if it reported any, they are not covered below. Read its report.`);
		if (findings[1 - o].length && !entries(verifications[o]).length) warnings.push(`- ${who(o)} returned no parseable verdicts; every finding of ${who(1 - o)} is listed as unchecked.`);
	});
	const section = (title: string, items: string[]) => `## ${title} (${items.length})\n\n${items.length ? items.map((item) => item + "\n\n").join("") : "None.\n\n"}`;
	return `Findings: ${findings[0].length} from ${labels[0]}, ${findings[1].length} from ${labels[1]}. Confirmed by both ${both.length}, disputed ${disputed.length}, rejected by both ${rejected.length}.\n\n`
		+ (warnings.length || unmatched.length ? `## Warnings\n\n${[...warnings, ...unmatched].map((line) => line + "\n").join("")}\n` : "")
		+ section("Confirmed by both", both) + section("Disputed", disputed) + section("Rejected by both", rejected);
}

/** The cooperative report's context addition: each finding gets a numbered `###` heading the peer can cite. */
export const COOP_FORMAT = "## Report format (cooperative review)\nGive each finding its own `### N. Title` heading, numbered from 1, and use no other `###` headings. The other reviewer will check every finding by its number.";

/** One reviewer request, run as its own launcher process so it keeps its slot locking, progress and exit code. */
export type Launch = (args: string[], stdin: string, onStderr: (line: string) => void) => Promise<{ code: number; stdout: string }>;

export interface CoopOptions {
	launch: Launch;
	base: string;
	context: string;
	piSlot: string;
	claudeSlot: string;
	/** Global options for both reviewers, such as --machine. */
	extra: string[];
	/** Where the combined report is saved; printed first, like every request. */
	reportPath: string;
	save(text: string): void;
	readReport(path: string): string;
	stdout(text: string): void;
	stderr(text: string): void;
}

const reportPathOf = (stdout: string) => /^# Sidecar report \((.*)\)$/m.exec(stdout.split("\n")[0] ?? "")?.[1];

/** Exit codes follow the other requests: 0 combined report, 3 a reviewer asked a question, else the first nonzero exit. */
export async function coopReview(options: CoopOptions): Promise<number> {
	const { launch, piSlot, claudeSlot } = options;
	const piLabel = `pi (slot ${piSlot})`;
	const claudeLabel = `Claude Code (slot ${claudeSlot})`;
	const context = `${options.context || "(none)"}\n\n${COOP_FORMAT}`;
	options.stdout(`# Sidecar report (${options.reportPath})\n`);
	const sides = [
		{ side: "pi", label: piLabel, slot: piSlot, tag: `pi slot ${piSlot}` },
		{ side: "claude", label: claudeLabel, slot: claudeSlot, tag: `claude slot ${claudeSlot}` },
	] as const;
	const run = (phase: string, requests: [string[], string][]) => Promise.all(sides.map(({ side, slot, tag }, i) =>
		launch(["--slot", slot, "--agent", side, "--role", "reviewer", ...options.extra, ...requests[i][0]], requests[i][1], (line) => options.stderr(`[${tag}] ${line}\n`))));
	const reviews = await run("review", [[["diff", options.base, context], ""], [["diff", options.base, context], ""]]);
	if (reviews.some((result) => result.code !== 0)) return incomplete(options, "review", reviews, sides);
	const paths = reviews.map((result) => reportPathOf(result.stdout)!);
	const reports = paths.map((path) => options.readReport(path));
	const found: [Finding[], Finding[]] = [inventory(reports[0], "P"), inventory(reports[1], "C")];
	const checks = await run("verify", [
		[["ask", "-"], verifyRequest(claudeLabel, reports[1], found[1], found[0])],
		[["ask", "-"], verifyRequest(piLabel, reports[0], found[0], found[1])],
	]);
	if (checks.some((result) => result.code !== 0)) return incomplete(options, "verify", checks, sides);
	const checkPaths = checks.map((result) => reportPathOf(result.stdout)!);
	const combined = `# Cooperative review

Base \`${options.base}\`. Reviewers: ${piLabel} and ${claudeLabel}. Each finding names its origin. This report decides nothing: the caller settles disputes and fixes.

- ${piLabel} review: ${paths[0]}
- ${claudeLabel} review: ${paths[1]}
- ${piLabel} check of ${claudeLabel}'s findings: ${checkPaths[0]}
- ${claudeLabel} check of ${piLabel}'s findings: ${checkPaths[1]}

${combine([piLabel, claudeLabel], found, [options.readReport(checkPaths[0]), options.readReport(checkPaths[1])])}`;
	options.save(combined);
	options.stdout(combined);
	return 0;
}

function incomplete(options: CoopOptions, phase: string, results: { code: number; stdout: string }[], sides: readonly { label: string; slot: string }[]): number {
	const lines = [`# Cooperative review incomplete (during ${phase})`, ""];
	results.forEach((result, i) => {
		const path = reportPathOf(result.stdout);
		const { label, slot } = sides[i];
		if (result.code === 0) lines.push(`- ${label}: done${path ? `; report ${path}` : ""}`);
		else if (result.code === 3) {
			const question = /^NEEDS_ANSWER: (.*)$/m.exec(result.stdout)?.[1] ?? "";
			lines.push(`- ${label}: asked a question: ${question}`, `  Reply with: sidecar --slot ${slot} answer TEXT${path ? ` (report ${path})` : ""}`);
		} else lines.push(`- ${label}: failed with exit ${result.code}${path ? `; report ${path}` : ""}`);
	});
	const text = lines.join("\n") + "\n";
	options.save(text);
	options.stdout(text);
	if (results.some((result) => result.code === 3)) {
		options.stderr("sidecar: coop-review is blocked on a question; answer it with sidecar --slot N answer TEXT, then run coop-review again\n");
		return 3;
	}
	options.stderr(`sidecar: coop-review stopped during ${phase} (pi exit ${results[0].code}, claude exit ${results[1].code})\n`);
	return results.find((result) => result.code !== 0)!.code;
}
