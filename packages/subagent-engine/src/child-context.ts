// Marks code running while a child session loads its extensions, so the engine's own package entry does not
// install a second root engine inside its children (plan §0). Children get the child installer instead.
import { AsyncLocalStorage } from "node:async_hooks";

export interface ChildScope {
	agentId: string;
	depth: number;
}

const storage = new AsyncLocalStorage<ChildScope>();
const MARKER = Symbol.for("subagent-engine.child-scope.v1");

/** Shared across separately loaded copies of this module (extensions load with a fresh module cache). */
function sharedStorage(): AsyncLocalStorage<ChildScope> {
	const host = globalThis as Record<symbol, unknown>;
	if (!host[MARKER]) host[MARKER] = storage;
	return host[MARKER] as AsyncLocalStorage<ChildScope>;
}

export function runInChildScope<T>(scope: ChildScope, fn: () => T): T {
	return sharedStorage().run(scope, fn);
}

export function childScope(): ChildScope | undefined {
	return sharedStorage().getStore();
}

/** Other packages (Grok chrome) use this to stay inert inside subagent sessions. */
export function inChildContext(): boolean {
	return childScope() !== undefined;
}
