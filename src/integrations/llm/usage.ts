import { isRecord } from "./json.js";
import type { LlmUsageTotals } from "./types.js";

/**
 * Token-usage extraction for the text-LLM clients (P2 cost metering).
 *
 * The text APIs return token counts but no dollar cost; each client
 * accumulates these per call and exposes the totals via
 * `getAccumulatedUsage()`, which the design CLI prices against the model
 * price table and records in the cost ledger.
 */

export interface UsageDelta {
  /** Total input tokens, INCLUDING cached reads (OpenAI convention). */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function newUsageTotals(): LlmUsageTotals {
  return { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

/** Count a call and fold in its (possibly missing) usage delta. */
export function addUsage(totals: LlmUsageTotals, delta: UsageDelta | undefined): void {
  totals.calls += 1;
  if (!delta) return;
  totals.inputTokens += delta.inputTokens;
  totals.cachedInputTokens += delta.cachedInputTokens;
  totals.outputTokens += delta.outputTokens;
}

/** Chat Completions: `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`. */
export function extractOpenAiChatUsage(payload: unknown): UsageDelta | undefined {
  const usage = usageRecord(payload);
  if (!usage) return undefined;
  return {
    inputTokens: num(usage.prompt_tokens),
    cachedInputTokens: num(isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : undefined),
    outputTokens: num(usage.completion_tokens),
  };
}

/** Responses API: `usage.input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`. */
export function extractOpenAiResponsesUsage(payload: unknown): UsageDelta | undefined {
  const usage = usageRecord(payload);
  if (!usage) return undefined;
  return {
    inputTokens: num(usage.input_tokens),
    cachedInputTokens: num(isRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined),
    outputTokens: num(usage.output_tokens),
  };
}

/**
 * Anthropic Messages: `usage.input_tokens` EXCLUDES cache reads/writes (the
 * fields are disjoint), so fold them back in to match the "input includes
 * cached" convention. Cache writes bill at 1.25× — folded in at 1× here, a
 * slight under-estimate acceptable for budgeting.
 */
export function extractAnthropicUsage(payload: unknown): UsageDelta | undefined {
  const usage = usageRecord(payload);
  if (!usage) return undefined;
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  return {
    inputTokens: num(usage.input_tokens) + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    outputTokens: num(usage.output_tokens),
  };
}

function usageRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  return payload.usage;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
