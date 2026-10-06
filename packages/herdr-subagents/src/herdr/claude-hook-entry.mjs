import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HerdrStore } = await jiti.import("./store.ts");
const { handleClaudeHook } = await jiti.import("./claude.ts");
const store = new HerdrStore(process.argv[2]);
let event;
try {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.length > 1024 * 1024) throw new Error("Claude hook input exceeds 1 MB");
	}
	event = JSON.parse(input);
	const output = await handleClaudeHook(store, process.argv[3], event);
	if (output) process.stdout.write(JSON.stringify(output) + "\n");
} catch (error) {
	process.stderr.write(`Herdr Claude hook failed: ${error.message}\n`);
	// Claude treats exit 2 as an input rejection, but StopFailure/SessionEnd ignore exit codes.
	process.exitCode = event?.hook_event_name === "UserPromptSubmit" ? 2 : 1;
} finally {
	await store.close();
}
