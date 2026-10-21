import { availableParallelism } from "node:os";

export class FifoPermits {
	private available: number;
	private waiting: (() => void)[] = [];
	constructor(n: number) {
		if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("Permit count must be a positive integer");
		this.available = n;
	}
	async acquire(): Promise<() => void> {
		if (this.available > 0) this.available--;
		else await new Promise<void>(resolve => this.waiting.push(resolve));
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiting.shift();
			if (next) next();
			else this.available++;
		};
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try { return await fn(); } finally { release(); }
	}
}

export function defaultConcurrency(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PI_WORKFLOW_CONCURRENCY?.trim();
	const value = raw && /^\+?\d+$/.test(raw) ? Number(raw) : NaN;
	return Number.isSafeInteger(value) && value >= 1 && value <= 256 ? value : Math.min(16, Math.max(2, availableParallelism() - 2));
}
