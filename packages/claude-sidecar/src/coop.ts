// Cooperative review: a pi adversarial reviewer and a Claude Code reviewer review the same change independently.
// The report lists both reviews; the caller cross-references and adjudicates them.

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
	const sides = [
		{ agent: "pi", role: "adversarial-reviewer", label: `pi adversarial reviewer (slot ${options.piSlot})`, slot: options.piSlot, tag: `pi slot ${options.piSlot}` },
		{ agent: "claude", role: "reviewer", label: `Claude Code reviewer (slot ${options.claudeSlot})`, slot: options.claudeSlot, tag: `claude slot ${options.claudeSlot}` },
	] as const;
	options.stdout(`# Sidecar report (${options.reportPath})\n`);
	const reviews = await Promise.all(sides.map(({ agent, role, slot, tag }) =>
		options.launch(["--slot", slot, "--agent", agent, "--role", role, ...options.extra, "diff", options.base, options.context], "", (line) => options.stderr(`[${tag}] ${line}\n`))));
	if (reviews.some((result) => result.code !== 0)) return incomplete(options, reviews, sides);
	const paths = reviews.map((result) => reportPathOf(result.stdout)!);
	const combined = `# Cooperative review

Base \`${options.base}\`. Two independent reviews of the same change. Cross-reference them yourself: verify each finding against the code, and note where the reviewers agree or only one found an issue.

${sides.map(({ label }, i) => `## ${label}\n\nReport: ${paths[i]}\n\n${options.readReport(paths[i]).replace(/\n+$/, "")}`).join("\n\n")}
`;
	options.save(combined);
	options.stdout(combined);
	return 0;
}

function incomplete(options: CoopOptions, results: { code: number; stdout: string }[], sides: readonly { label: string; slot: string }[]): number {
	const lines = ["# Cooperative review incomplete", ""];
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
	options.stderr(`sidecar: coop-review stopped (pi exit ${results[0].code}, claude exit ${results[1].code})\n`);
	return results.find((result) => result.code !== 0)!.code;
}
