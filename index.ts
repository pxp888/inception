/**
 * inception — curator-agent compaction for pi.
 *
 * Replaces pi's standard compaction routine with a "Context Gardener": every N turns
 * (each model call counts as a turn, tool calls included) the history older than the
 * protected head of recent turns is handed to a second LLM that rewrites it into a
 * compact factual replacement. The newest N turns are always kept verbatim.
 *
 * Scheduled curation commits its compaction entry from the `turn_end` boundary, so an
 * in-flight agent run pauses for the curator call and then resumes — pi's manual
 * `ctx.compact()` entry point is deliberately not used because it aborts the current
 * run first. Pi's own threshold/overflow compactions (and `/compact`) are intercepted
 * via `session_before_compact` and curated the same way, which keeps long single-prompt
 * runs safe mid-loop.
 *
 * Usage:
 *   pi --extension /path/to/inception/index.ts
 *   pi --extension ... --inception-frequency 4 --inception-protected-head 6 \
 *      --inception-model google/gemini-2.5-flash
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionProjection } from "@earendil-works/pi-coding-agent";
import { buildSessionProjection, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { CurationPlan } from "./boundary.ts";
import { planCuration } from "./boundary.ts";

const DEFAULT_FREQUENCY = 3; // curate every N turns (a model call + its tool batch is one turn)
const DEFAULT_PROTECTED_HEAD = 5; // keep the newest N turns verbatim
const MAX_SUMMARY_TOKENS = 8192;

// Suggested curator prompt from design.md, verbatim.
const CURATOR_PROMPT = `You are the Context Gardener for a coding agent. Your responsibility is to reduce
the agent's conversation context while preserving everything necessary to continue
its current objective correctly.

Review the eligible historical conversation and produce a concise replacement that
allows the main agent to resume work without repeating investigations, losing
important discoveries, or undoing successful changes.

Prioritize preserving:
1. The current objective, requirements, acceptance criteria, and constraints.
2. Current implementation state, including relevant files, functions, interfaces,
   and successful changes.
3. Important discoveries, including failed searches, negative findings,
   environmental limitations, and rejected approaches.
4. Decisions already made and their rationale.
5. Outstanding work, unresolved questions, blockers, and the next useful steps.
6. Relevant user instructions and preferences.

Remove verbose tool outputs, irrelevant exploration, redundant explanations,
superseded plans, and boilerplate that can safely be regenerated.

Do not treat a failed investigation as worthless. Preserve its conclusion whenever
it prevents repeated work or constrains future decisions. Prefer a short factual
statement over a transcript of the investigation.

Do not invent facts, infer that an operation succeeded when only an attempt is
recorded, or claim that files contain particular code unless the available context
supports that claim.

The newest protected turns are outside your editing scope. Preserve their contents exactly.

Produce a compact, factual context replacement. Optimize for the main agent's ability
to continue working, not for a comprehensive historical narrative. When uncertain
whether information is essential, preserve it in a concise form rather than deleting it.

Operational rules:
- Keep your internal reasoning/thinking concise. Do not overthink; proceed directly
  to extracting and updating the state.
- Your replacement will be shown to the main agent as its session state, in place of
  the summarized history.
- Output only the replacement context: no preamble, no closing remarks, no markdown code fences.`;

export default function inception(pi: ExtensionAPI) {
	pi.registerFlag("inception-frequency", {
		description: "Run curation every N turns (tool calls count as turns)",
		type: "string",
		default: String(DEFAULT_FREQUENCY),
	});
	pi.registerFlag("inception-protected-head", {
		description: "Keep the newest N turns untouched by curation",
		type: "string",
		default: String(DEFAULT_PROTECTED_HEAD),
	});
	pi.registerFlag("inception-model", {
		description: "Curator model as provider/modelId (default: current session model)",
		type: "string",
	});

	let turnsSinceCuration = 0;
	let curationInFlight = false;

	const flagInt = (name: string, fallback: number): number => {
		const raw = pi.getFlag(name);
		if (typeof raw !== "string") return fallback;
		const n = Number.parseInt(raw, 10);
		return Number.isInteger(n) && n >= 1 ? n : fallback;
	};

	const notify = (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	};

	const resolveCuratorModel = (ctx: ExtensionContext): Model<any> | undefined => {
		const raw = pi.getFlag("inception-model");
		if (typeof raw === "string" && raw.includes("/")) {
			const slash = raw.indexOf("/");
			return ctx.modelRegistry.find(raw.slice(0, slash), raw.slice(slash + 1));
		}
		return ctx.model;
	};

	/** Messages eligible for curation: the live region before the protected head. */
	const eligibleMessages = (projection: SessionProjection, plan: CurationPlan) =>
		projection.entries
			.slice(plan.boundaryStart, plan.cutIndex)
			.flatMap((e) => (e.sourceEntry.type === "compaction" ? [] : e.messages.filter((m) => m.role !== "system")));

	const runCurator = async (
		ctx: ExtensionContext,
		options: { conversationText: string; eligibleCount: number; previousSummary?: string; instructions?: string; signal?: AbortSignal },
	): Promise<{ summary: string; usage?: Usage } | undefined> => {
		const model = resolveCuratorModel(ctx);
		if (!model) return undefined; // caller decides how to react (skip vs default fallback)

		const previousBlock = options.previousSummary
			? `\n\nPrevious curated context from an earlier curation pass. Your output replaces it, so carry forward anything still relevant:\n${options.previousSummary}\n`
			: "";
		const instructionsBlock = options.instructions ? `\nAdditional focus for this curation pass:\n${options.instructions}\n` : "";

		notify(ctx, `inception: curating ${options.eligibleCount} messages with ${model.provider}/${model.id}`, "info");
		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: `${CURATOR_PROMPT}${previousBlock}${instructionsBlock}\n\n<conversation>\n${options.conversationText}\n</conversation>` }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: Math.min(MAX_SUMMARY_TOKENS, model.maxTokens ?? MAX_SUMMARY_TOKENS),
				signal: options.signal, // user abort cancels the curator call; curation is simply skipped
				cacheRetention: "none", // one-off prompt; do not write to the prompt cache
				sessionId: uuidv7(),
			},
		);
		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		return { summary, usage: response.usage };
	};

	const planEligible = (projection: SessionProjection) => {
		const plan = planCuration(projection.entries, flagInt("inception-protected-head", DEFAULT_PROTECTED_HEAD));
		if (!plan) return undefined; // live region fits inside the protected head
		const eligible = eligibleMessages(projection, plan);
		const firstKeptId = projection.entries[plan.cutIndex].sourceEntry.id as string | undefined;
		if (eligible.length === 0 || !firstKeptId) return undefined;
		return { plan, eligible, firstKeptId };
	};

	// Frequency trigger. Each turn_end is one model call plus its tool batch, so
	// tool calls are counted as turns per the design. The compaction entry is
	// committed at this boundary and the run resumes with the curated context;
	// returning undefined leaves the transcript untouched.
	pi.on("turn_end", async (_event, ctx) => {
		if (curationInFlight) return undefined;
		turnsSinceCuration += 1;
		if (turnsSinceCuration < flagInt("inception-frequency", DEFAULT_FREQUENCY)) return undefined;

		const target = planEligible(ctx.sessionManager.buildSessionProjection());
		if (!target) return undefined; // nothing outside the protected head yet: keep counting

		curationInFlight = true;
		try {
			const result = await runCurator(ctx, {
				conversationText: serializeConversation(convertToLlm(target.eligible)),
				eligibleCount: target.eligible.length,
				previousSummary: target.plan.previousSummary,
				signal: ctx.signal,
			});
			if (!result || !result.summary) return undefined; // empty curator output: keep counting, retry in N turns
			turnsSinceCuration = 0;
			return {
				entries: [{ type: "compaction" as const, summary: result.summary, firstKeptEntryId: target.firstKeptId, usage: result.usage }],
				continue: false, // the run's own continuation rules apply; never force an extra model call
			};
		} catch (error) {
			if (!ctx.signal?.aborted) notify(ctx, `inception: curation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined; // run continues uncurated; next opportunity is N turns later
		} finally {
			curationInFlight = false;
		}
	});

	// Any compaction committed through pi's own paths (threshold, overflow, /compact)
	// just trimmed the context: restart the schedule.
	pi.on("session_compact", () => {
		turnsSinceCuration = 0;
		curationInFlight = false;
	});

	// Intercept pi's standard compaction routine (manual /compact, threshold and overflow
	// recovery during long runs) and replace it with curator curation + protected head.
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, signal } = event;
		try {
			const target = planEligible(buildSessionProjection(branchEntries));
			if (!target) return undefined; // live region fits in the protected head: let pi no-op

			if (!resolveCuratorModel(ctx)) {
				notify(ctx, "inception: no curator model available (bad --inception-model?), using default compaction", "warning");
				return undefined; // fall back to pi's default routine
			}

			let result: Awaited<ReturnType<typeof runCurator>>;
			try {
				result = await runCurator(ctx, {
					conversationText: serializeConversation(convertToLlm(target.eligible)),
					eligibleCount: target.eligible.length,
					previousSummary: target.plan.previousSummary,
					instructions: customInstructions,
					signal, // honor aborts of the compaction itself
				});
			} catch (error) {
				if (!signal.aborted) notify(ctx, `inception: curation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined; // fall back to pi's default compaction routine
			}

			if (!result || !result.summary) {
				if (signal.aborted) return { cancel: true }; // user cancelled; do not fall through to another LLM call
				notify(ctx, "inception: curator returned an empty summary, using default compaction", "warning");
				return undefined;
			}

			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: target.firstKeptId,
					tokensBefore: preparation.tokensBefore,
					usage: result.usage,
				},
			};
		} catch (error) {
			if (!signal.aborted) notify(ctx, `inception: curation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined; // fall back to pi's default compaction routine
		}
	});
}
