import assert from "node:assert/strict";

type Mouse = ((event: any) => unknown) | undefined;
const ev = (extra: Record<string, unknown> = {}) => ({ type: "click", button: "left", x: 4, y: 0, width: 40, ...extra }) as any;

/**
 * The gesture contract every diamond must satisfy. Pass the header and body
 * handlers of a freshly rendered, open diamond; call it from the new
 * content's test so a missed wiring fails here.
 */
export function assertDiamondGestures(label: string, diamond: {
	header: Mouse; body: Mouse; isOpen: () => boolean;
	/** Edit and created-write diamonds close from the header only on Alt-click. */
	closeNeedsAlt?: boolean;
	/** Ctrl-click opens a file; omit when the content names none. */
	opened?: () => unknown[];
}) {
	assert.equal(diamond.isOpen(), true, `${label}: starts open`);
	assert.deepEqual(diamond.body?.(ev({ y: 1 })), { handled: true }, `${label}: plain body click is consumed, so Pi does not toggle`);
	assert.equal(diamond.isOpen(), true, `${label}: plain body click keeps it open`);
	const before = diamond.opened?.().length ?? 0;
	const ctrl = diamond.header?.(ev({ ctrl: true }));
	if (diamond.opened) {
		assert.ok(ctrl, `${label}: Ctrl-click header is handled`);
		assert.ok(diamond.body?.(ev({ y: 1, ctrl: true })), `${label}: Ctrl-click body is handled`);
		assert.equal(diamond.opened().length, before + 2, `${label}: Ctrl-click opens the target`);
	} else assert.deepEqual(ctrl, { handled: true }, `${label}: Ctrl-click without a target is still consumed`);
	assert.equal(diamond.isOpen(), true, `${label}: Ctrl-click never toggles`);
	assert.ok(diamond.body?.(ev({ y: 1, alt: true })), `${label}: Alt-click body closes`);
	assert.equal(diamond.isOpen(), false, `${label}: closed`);
	assert.ok(diamond.header?.(ev()), `${label}: header click reopens`);
	assert.equal(diamond.isOpen(), true, `${label}: reopened`);
	assert.ok(diamond.header?.(ev()), `${label}: plain header click is consumed`);
	assert.equal(diamond.isOpen(), Boolean(diamond.closeNeedsAlt), `${label}: plain header click ${diamond.closeNeedsAlt ? "keeps" : "closes"} it`);
	assert.equal(diamond.header?.(ev({ type: "press" })), undefined, `${label}: presses stay native`);
	if (diamond.closeNeedsAlt) assert.ok(diamond.header?.(ev({ alt: true })), `${label}: Alt-click header closes`);
	assert.equal(diamond.isOpen(), false, `${label}: closes`);
}
