// Cross-platform executable hook fixture: tests always launch it with process.execPath.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const mode = process.argv[2] ?? "echo";
if (mode === "hang") {
	setInterval(() => {}, 1000);
} else if (mode === "exit2") {
	process.stdout.write("{malformed");
	process.stderr.write("Please finish the verification.");
	process.exitCode = 2;
} else if (mode === "missing-data") {
	process.stderr.write("No such file or directory: input.data");
	process.exitCode = 2;
} else if (mode === "missing") {
	process.stderr.write("python: can't open file '/missing/hook.py': [Errno 2] No such file or directory");
	process.exitCode = 2;
} else if (mode === "127") {
	process.stderr.write("hook command not found");
	process.exitCode = 127;
} else if (mode === "prevent") {
	process.stdout.write(JSON.stringify({ continue: false, decision: "block", stopReason: "Finish now" }));
	process.stderr.write("exit-2 feedback must not win");
	process.exitCode = 2;
} else if (mode === "schema") {
	process.stdout.write(JSON.stringify({ continue: "no" }));
} else if (mode === "plain") {
	process.stdout.write("Hook completed normally.");
} else if (mode === "large") {
	process.stdout.write("x".repeat(1_100_000));
} else {
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: JSON.stringify({ payload, cwd: process.cwd(), marker: process.env.HOOK_MARKER, args: process.argv.slice(3) }) } }));
}
