/**
 * Curator-facing render of the region being summarized: index.ts's renderHead, but cut down.
 *
 * The region keeps the reasoning that produced each decision, because a summarized turn's
 * conclusions, negative findings and rejected approaches exist only in that reasoning - and
 * after curation that text is gone from the session for good. Two differences from pi's own
 * serializeConversation, which this otherwise matches: thinking is kept as a head+tail
 * excerpt instead of dropped, and labels match renderHead so both blocks read the same way.
 * Pure and import-free, like boundary.ts, so it runs under plain node.
 */

/** Structural subset of pi's LLM messages (Message from @earendil-works/pi-ai). */
interface ContentBlock {
	type: string;
	id?: string;
	text?: string;
	thinking?: string;
	redacted?: boolean;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface LLMMessage {
	role: string;
	content: string | ContentBlock[];
	isError?: boolean;
	toolName?: string;
}

const TOOL_RESULT_MAX_CHARS = 2000; // pi's own truncation budget
// shortcut: per-block caps only, no global reasoning budget per pass; add one if a first
// pass over a long session ever makes the curation request bigger than the region it summarizes.
const REASONING_HEAD_CHARS = 200;
const REASONING_TAIL_CHARS = 200;

function contentText(content: string | ContentBlock[]): string {
	if (typeof content === "string") return content;
	const texts: string[] = [];
	let images = 0;
	for (const c of content) {
		if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
		else if (c.type === "image") images += 1;
	}
	return images ? `${texts.join("\n")} [+${images} image(s)]` : texts.join("\n");
}

/** Head cut with pi's marker, so tool results read the same as in pi's summaries. */
function truncateToolResult(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/**
 * A thinking block opens with problem restatement and closes with the decision, so a
 * head-only cut drops the conclusion. Keep both ends.
 */
function reasoningExcerpt(thinking: string): string {
	const keep = REASONING_HEAD_CHARS + REASONING_TAIL_CHARS;
	if (thinking.length <= keep) return thinking;
	const omitted = thinking.length - keep;
	return `${thinking.slice(0, REASONING_HEAD_CHARS)}\n[... ${omitted} characters of reasoning omitted ...]\n${thinking.slice(-REASONING_TAIL_CHARS)}`;
}

export function serializeConversationWithReasoning(messages: LLMMessage[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = contentText(msg.content).trim();
			if (text) parts.push(`[User]: ${text}`);
			continue;
		}
		if (msg.role === "assistant") {
			const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
			// Redacted thinking carries no readable text, only an opaque signature.
			const reasoning = blocks
				.filter((b) => b.type === "thinking" && !b.redacted && (b.thinking ?? "").trim())
				.map((b) => reasoningExcerpt(b.thinking!.trim()));
			if (reasoning.length) parts.push(`[Assistant thinking (excerpt)]: ${reasoning.join("\n")}`);
			const visible = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("")
				.trim();
			if (visible) parts.push(`[Assistant]: ${visible}`);
			const calls = blocks
				.filter((b) => b.type === "toolCall")
				.map((b) => `${b.name}(${Object.entries(b.arguments ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`);
			if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
			continue;
		}
		if (msg.role === "toolResult") {
			const text = contentText(msg.content).trim();
			parts.push(`${msg.isError ? "[Tool error]" : `[Tool result: ${msg.toolName ?? "tool"}]`}${text ? `: ${truncateToolResult(text, TOOL_RESULT_MAX_CHARS)}` : ""}`);
		}
	}
	return parts.join("\n\n");
}
