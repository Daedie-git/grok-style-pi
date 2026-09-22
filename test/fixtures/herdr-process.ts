import { HerdrStore } from "../../src/herdr-subagent-store.ts";

const store = new HerdrStore(process.argv[2]);
process.on("message", async (request: { id: number; operation: string; args: string[] }) => {
	try {
		let value: unknown;
		switch (request.operation) {
			case "lock": value = await store.tryPlacementLock(request.args[0]); break;
			case "unlock": value = await store.releasePlacementLock(request.args[0]); break;
			case "resume": value = await store.beginRun(request.args[0], request.args[1], request.args[2], true, Date.now()); break;
			case "agents": value = await store.listAgents(); break;
			case "close": await store.close(); process.disconnect(); return;
			default: throw new Error("Unknown test operation");
		}
		process.send?.({ id: request.id, value });
	} catch (error) {
		process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) });
	}
});
await store.listAgents();
process.send?.({ ready: true });
