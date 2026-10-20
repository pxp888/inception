import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoundaryEntry } from "./boundary.ts";
import { findProtectedBoundary, planCuration } from "./boundary.ts";

const e = (role: string): BoundaryEntry => ({ sourceEntry: { type: "message" }, messages: [{ role }] });
/** A one-turn span: user prompt, tool-calling assistant response, tool result. */
const span = (): BoundaryEntry[] => [e("user"), e("assistant"), e("toolResult")];

test("cuts at the span-start of the head's oldest turn", () => {
	// three spans: assistants at idx 1, 4, 6; head=2 keeps the newest two turns + their prompt
	const entries = [...span(), ...span(), e("user"), e("assistant")];
	assert.equal(findProtectedBoundary(entries, 0, 2), 3);
});

test("single-prompt run: cut lands before the head's oldest turn so curation makes progress", () => {
	// one span, two turns (one user prompt, many model calls); system entry up front like a real projection
	const entries = [e("system"), e("user"), e("assistant"), e("toolResult"), e("assistant"), e("toolResult")];
	assert.equal(findProtectedBoundary(entries, 0, 1), 4);
	// eligible = the prompt + turn 1 (system filtered out); tool result after the cut stays with its call
	const plan = planCuration(entries, 1);
	assert.ok(plan);
	assert.deepEqual(
		entries.slice(plan.boundaryStart, plan.cutIndex).flatMap((x) => x.messages.map((m) => m.role)).filter((r) => r !== "system"),
		["user", "assistant", "toolResult"],
	);
});

test("multi-span: cut at the head's oldest prompt so recent prompts stay verbatim", () => {
	// span 1 [u a tr] fully curable, span 2 [u a] is the protected head
	const entries = [e("user"), e("assistant"), e("toolResult"), e("user"), e("assistant")];
	assert.equal(findProtectedBoundary(entries, 0, 1), 3);
});

test("returns boundaryStart when fewer turns than the head", () => {
	assert.equal(findProtectedBoundary([e("user"), e("assistant")], 0, 5), 0);
});

test("stale compaction entries inside the live region are ignored", () => {
	const stale: BoundaryEntry = { sourceEntry: { type: "compaction" }, messages: [] };
	// assistants at idx 1 and 5; if the stale entry were miscounted as a turn, head=1 would cut at 0
	const entries = [...span(), stale, ...span()];
	assert.equal(findProtectedBoundary(entries, 0, 1), 4); // keep second span: its prompt + turn
});

test("planCuration starts the live region after the newest content-bearing compaction", () => {
	const prevSource = { type: "compaction", summary: "old state" };
	const prev: BoundaryEntry = { sourceEntry: prevSource, messages: [{ role: "compactionSummary" }] };
	// live region: two spans (assistants at idx 2 and 5)
	const entries = [prev, ...span(), ...span()];
	const plan = planCuration(entries, 1);
	assert.ok(plan);
	assert.equal(plan.boundaryStart, 1);
	assert.equal(plan.cutIndex, 4); // head=1: keep last turn + its prompt; curate span 2
	assert.equal(plan.previousSummary, "old state");
});

test("planCuration returns null when the live region fits in the head", () => {
	assert.equal(planCuration([e("user"), e("assistant")], 5), null);
});
