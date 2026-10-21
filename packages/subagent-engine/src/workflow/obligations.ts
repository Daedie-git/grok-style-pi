/** Strengthened profile: tracks logical execution and journal writes, not public abort promises. */
export class WorkflowObligations {
	private pending = 0;
	private closed = false;
	private listeners = new Set<() => void>();
	get count(): number { return this.pending; }
	get isClosed(): boolean { return this.closed; }
	register(): () => void {
		if (this.closed) throw new Error("Workflow invocation is already closed");
		this.pending++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.pending === 0) for (const listener of [...this.listeners]) listener();
		};
	}
	close(): void { this.closed = true; }
	async wait(timeoutMs = 30_000): Promise<boolean> {
		if (this.pending === 0) return true;
		return new Promise(resolve => {
			const done = () => { clearTimeout(timer); this.listeners.delete(done); resolve(true); };
			const timer = setTimeout(() => { this.listeners.delete(done); resolve(false); }, timeoutMs);
			this.listeners.add(done);
		});
	}
}
