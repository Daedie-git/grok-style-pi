/** Consume newest-first pieces until the character budget is exhausted, without joining omitted history. */
export function textTail(newest: Iterable<string>, limit = 64_000, separator = "\n"): string {
	const pieces: string[] = [];
	let remaining = limit;
	for (const text of newest) {
		if (!text) continue;
		if (pieces.length) {
			const gap = separator.slice(-remaining);
			pieces.push(gap); remaining -= gap.length;
		}
		if (remaining <= 0) break;
		const tail = text.slice(-remaining);
		pieces.push(tail); remaining -= tail.length;
		if (remaining <= 0) break;
	}
	return pieces.reverse().join("");
}
