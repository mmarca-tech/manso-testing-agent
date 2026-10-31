/**
 * PR mention parsing + intent classification (M12).
 *
 * The responder reads PR comment threads, finds comments that address Manso
 * (`@manso ...`), works out what the reviewer is asking, and decides whether
 * to act. All pure and rule-based so the decision logic is fully testable
 * offline; the actual fix/reply happens in the orchestrator.
 */

export type MentionIntent = "fix" | "explain" | "acknowledge" | "ignore";

/** A marker the responder embeds in its own replies for loop-safety + counting. */
export const RESPONDER_MARKER = "manso-bot";

export interface ParsedMention {
  /** True when the comment addresses the configured mention handle. */
  mentioned: boolean;
  /** The instruction text after the handle (trimmed), or "" when none. */
  instruction: string;
}

/**
 * Detect whether `text` addresses `mention` (default "@manso") and extract
 * the instruction that follows it. Matching is case-insensitive and tolerates
 * the handle appearing anywhere in the comment.
 */
export function parseMention(text: string, mention = "@manso"): ParsedMention {
  const handle = mention.startsWith("@") ? mention : `@${mention}`;
  const lower = text.toLowerCase();
  const at = lower.indexOf(handle.toLowerCase());
  if (at < 0) {
    return { mentioned: false, instruction: "" };
  }
  const after = text.slice(at + handle.length);
  // Drop a leading separator (":", "," "-") then trim.
  const instruction = after.replace(/^\s*[:,\-]?\s*/, "").trim();
  return { mentioned: true, instruction };
}

const FIX_HINTS = [
  "fix",
  "update",
  "change",
  "correct",
  "adjust",
  "rework",
  "redo",
  "implement",
  "add",
  "remove",
  "rename",
  "make it",
  "should",
  "broken",
  "failing",
  "wrong",
  "instead",
  "use",
];

const EXPLAIN_HINTS = [
  "why",
  "what",
  "how",
  "explain",
  "clarify",
  "reason",
  "rationale",
  "?",
];

const ACK_HINTS = ["thanks", "thank you", "lgtm", "looks good", "great", "nice", "ok", "okay", "👍"];

/**
 * Classify the reviewer's instruction into an action intent. Rule-based: a
 * change verb → `fix`; a question → `explain`; pleasantries → `acknowledge`;
 * empty → `ignore`. The orchestrator may upgrade this with an LLM later, but the
 * heuristic keeps the common cases cheap and deterministic.
 */
export function classifyIntent(instruction: string): MentionIntent {
  const text = instruction.trim().toLowerCase();
  if (text.length === 0) {
    return "ignore";
  }
  if (ACK_HINTS.some((hint) => text === hint || text.startsWith(`${hint} `) || text.endsWith(` ${hint}`))) {
    return "acknowledge";
  }
  const hasFix = FIX_HINTS.some((hint) => containsWord(text, hint));
  const hasExplain = EXPLAIN_HINTS.some((hint) => (hint === "?" ? text.includes("?") : containsWord(text, hint)));
  if (hasFix) {
    return "fix";
  }
  if (hasExplain) {
    return "explain";
  }
  // A directive with no recognised verb is still treated as a fix request —
  // reviewers often phrase asks tersely ("the login button selector").
  return "fix";
}

function containsWord(text: string, hint: string): boolean {
  if (hint.includes(" ")) {
    return text.includes(hint);
  }
  return new RegExp(`(^|[^a-z])${escapeRegExp(hint)}([^a-z]|$)`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap a reply body with the responder marker so future runs recognise it. */
export function markReply(body: string, iteration: number): string {
  return `${body}\n\n<!-- ${RESPONDER_MARKER}:iteration:${iteration} -->`;
}

/** True when a comment body was authored by the responder (carries the marker). */
export function isResponderComment(body: string): boolean {
  return body.includes(`<!-- ${RESPONDER_MARKER}:`);
}

/** Highest iteration number recorded across the responder's own comments. */
export function highestIteration(bodies: string[]): number {
  let max = 0;
  const re = new RegExp(`<!--\\s*${RESPONDER_MARKER}:iteration:(\\d+)\\s*-->`);
  for (const body of bodies) {
    const match = re.exec(body);
    if (match) {
      const n = Number.parseInt(match[1] ?? "0", 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}
