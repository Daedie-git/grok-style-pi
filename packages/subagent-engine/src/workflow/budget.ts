/** The ledger is session-wide output tokens, not USD or a run-relative counter. */
export class OutputBudget {
	readonly total: number | null;
	private ledger: () => number;
	constructor(total: number | null, ledger: () => number) {
		if (total !== null && (!Number.isFinite(total) || total <= 0)) throw new RangeError("Budget total must be positive or null");
		this.total = total;
		this.ledger = ledger;
	}
	spent(): number { return this.ledger(); }
	remaining(): number { return this.total === null ? Infinity : Math.max(0, this.total - this.spent()); }
	check(): void { if (this.total !== null && this.spent() >= this.total) throw new Error("Workflow output-token budget exhausted"); }
}
