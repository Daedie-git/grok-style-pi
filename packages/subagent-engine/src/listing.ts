// Agent-type listing as history (plan §16.7, §17.15): the offered types reach the model as persistent `agent-listing`
// entries carrying add/remove deltas against the last *committed* listing. Until Pi persists a pending listing, every request
// sees it through the `context` event; rendering alone never advances the baseline.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listingText, type PolicyInput } from "./policy/text.ts";

export const LISTING_TYPE = "agent-listing";

type Offered = PolicyInput["offered"][number];

interface ListingDetails {
	listingId: string;
	offered: Offered[];
}

interface Pending {
	id: string;
	text: string;
	offered: Offered[];
	submitted: boolean;
}

/** The offered set recorded by the newest persisted listing in the current branch. */
export function committedListing(entries: readonly { type: string; customType?: string; details?: unknown }[]): { offered: Offered[]; ids: Set<string> } {
	let offered: Offered[] = [];
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== LISTING_TYPE) continue;
		const details = entry.details as Partial<ListingDetails> | undefined;
		if (!details?.listingId || !Array.isArray(details.offered)) continue;
		ids.add(details.listingId);
		offered = details.offered;
	}
	return { offered, ids };
}

function signature(agent: Offered): string {
	return JSON.stringify([agent.agentType, agent.description, agent.tools ?? null]);
}

export function listingDelta(previous: Offered[], current: Offered[]): { added: Offered[]; removed: string[] } {
	const before = new Map(previous.map((agent) => [agent.agentType, signature(agent)]));
	const after = new Set(current.map((agent) => agent.agentType));
	return {
		added: current.filter((agent) => before.get(agent.agentType) !== signature(agent)),
		removed: previous.map((agent) => agent.agentType).filter((type) => !after.has(type)),
	};
}

/**
 * Keep the model's view of available agent types current. `offered` is evaluated per request, so model, tool, trust and
 * definition changes all surface (including removals) on the next request, notification-started runs included.
 */
export function installListingBridge(pi: ExtensionAPI, offered: (ctx: ExtensionContext) => Promise<Offered[]> | Offered[]): void {
	let pending: Pending | undefined;
	let counter = 0;
	pi.on("context", async (event, ctx) => {
		const committed = committedListing(ctx.sessionManager.getBranch() as never);
		if (pending && committed.ids.has(pending.id)) pending = undefined;
		const current = await offered(ctx);
		const base = pending?.offered ?? committed.offered;
		const delta = listingDelta(base, current);
		if (delta.added.length > 0 || delta.removed.length > 0 || (committed.ids.size === 0 && !pending)) {
			const initial = committed.ids.size === 0 && !pending;
			const id = `listing-${Date.now().toString(36)}-${(counter++).toString(36)}`;
			const text = listingText(initial ? current : delta.added, initial ? [] : delta.removed, initial);
			pending = { id, text, offered: current, submitted: false };
		}
		if (pending && !pending.submitted) {
			pending.submitted = true;
			// Appended now when idle, or at the end of the current turn while streaming; never starts a turn by itself.
			pi.sendMessage({ customType: LISTING_TYPE, content: pending.text, display: false, details: { listingId: pending.id, offered: pending.offered } satisfies ListingDetails }, { triggerTurn: false });
		}
		const projected = pending ? { role: "custom", customType: LISTING_TYPE, content: pending.text, display: false, details: { listingId: pending.id }, timestamp: Date.now() } : undefined;
		const placed = placeListings(event.messages, projected);
		return placed ? { messages: placed } : undefined;
	});
}

/**
 * Listings of the current turn go ahead of the input that started it, in their original order with any pending listing
 * last. Appended after the input, a listing becomes the newest message the model reads and can displace the request (a
 * listing committed mid-turn lands after the tool results). Listings of earlier turns stay put, keeping the cached prefix.
 */
function placeListings<T extends { role?: string; customType?: string }>(messages: readonly T[], pending: unknown): T[] | undefined {
	const isListing = (message: T) => message.role === "custom" && message.customType === LISTING_TYPE;
	const isInput = (message: T) => (message.role === "user" || message.role === "custom") && !isListing(message);
	let start = messages.length;
	while (start > 0 && !isInput(messages[start - 1])) start--;
	if (start === 0) return pending ? [...messages, pending as T] : undefined;
	while (start > 0 && isInput(messages[start - 1])) start--;
	const turn = messages.slice(start);
	const listings = turn.filter(isListing);
	if (listings.length === 0 && !pending) return undefined;
	return [...messages.slice(0, start), ...listings, ...(pending ? [pending as T] : []), ...turn.filter((message) => !isListing(message))];
}
