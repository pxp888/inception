/**
 * Pure turn-boundary math for inception's protected head.
 * No package imports, so tests run under plain node (type stripping).
 */

/** Message roles that start a user-driven span; mirrors pi's isTurnStartMessage(). */
export const TURN_START_ROLES = new Set([
	"user",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

/** Structural subset of ProjectedSessionEntry that the planning functions need. */
export interface BoundaryEntry {
	sourceEntry: { type: string };
	messages: Array<{ role: string }>;
}

/** A curation plan over projected (oldest-first) session entries. */
export interface CurationPlan {
	/** Index of the first live entry, i.e. right after the newest content-bearing compaction. */
	boundaryStart: number;
	/** Index where the protected head begins; everything before it is curated away. */
	cutIndex: number;
	/** Summary from the previous curation pass, when one exists in the live region. */
	previousSummary?: string;
}

function startsSpan(entry: BoundaryEntry): boolean {
	return entry.messages.some((m) => m.role !== "system" && TURN_START_ROLES.has(m.role));
}

/** True when [from, to) holds at least one context-producing message (not system/compaction). */
function hasContextContent(entries: BoundaryEntry[], from: number, to: number): boolean {
	for (let k = from; k < to; k++) {
		if (entries[k].sourceEntry.type !== "compaction" && entries[k].messages.some((m) => m.role !== "system")) return true;
	}
	return false;
}

/**
 * Index of the first entry to keep so that exactly `protectedHead` assistant turns
 * (one per model call; a tool-calling response counts as one turn, like pi's turn_end)
 * remain after it. When the head's oldest turn starts its own user-like span and real
 * context exists before that span (earlier prompts/turns), the cut lands on the span
 * start so recent prompts stay verbatim with their responses. Otherwise — a single
 * long prompt, or only system messages before the span — the cut lands right before
 * the turn itself; that is what makes curation progress in long single-prompt runs.
 * Returns boundaryStart when fewer than `protectedHead` turns exist in the live region.
 */
export function findProtectedBoundary(entries: BoundaryEntry[], boundaryStart: number, protectedHead: number): number {
	let assistantsSeen = 0;
	for (let i = entries.length - 1; i >= boundaryStart; i--) {
		if (entries[i].sourceEntry.type === "compaction") continue; // no context contribution
		const hasAssistant = entries[i].messages.some((m) => m.role === "assistant");
		if (!hasAssistant) continue;
		assistantsSeen += 1;
		if (assistantsSeen !== protectedHead) continue;
		let spanStart = -1;
		for (let j = i; j >= boundaryStart; j--) {
			if (startsSpan(entries[j])) {
				spanStart = j;
				break;
			}
		}
		return spanStart > boundaryStart && hasContextContent(entries, boundaryStart, spanStart) ? spanStart : i;
	}
	return boundaryStart; // fewer turns than the head: nothing is eligible for curation
}

/**
 * Plan a curation pass over projected session entries (oldest first).
 * Returns null when there is nothing to curate (the whole live region fits inside
 * the protected head, or the region is empty).
 */
export function planCuration(entries: BoundaryEntry[], protectedHead: number): CurationPlan | null {
	const prevIdx = entries.findIndex((e) => e.sourceEntry.type === "compaction" && e.messages.length > 0);
	const boundaryStart = prevIdx >= 0 ? prevIdx + 1 : 0;
	const cutIndex = findProtectedBoundary(entries, boundaryStart, protectedHead);
	if (cutIndex <= boundaryStart) return null;
	return {
		boundaryStart,
		cutIndex,
		previousSummary: prevIdx >= 0 ? (entries[prevIdx].sourceEntry as { summary?: string }).summary : undefined,
	};
}
