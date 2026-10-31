import type { AgentUsage } from "../domain/implementationPack/schema.js";
import { roundUsd } from "../shared/utils.js";

/**
 * USD prices per 1M tokens, for cost *estimation* (P2 governance follow-up).
 *
 * An exact SDK-reported cost (`usage.totalCostUsd`, Claude Agent SDK) always
 * wins. This table backfills the runners and clients that report tokens but no
 * cost — the Codex SDK and the design-phase text LLMs — so the budget ledger
 * and the Langfuse cost view stop being blind to them.
 *
 * Matching is by case-insensitive substring, longest key first (so
 * "claude-opus-4-1" beats "claude-opus-4" for the 4.1 model). Override or
 * extend with MANSO_MODEL_PRICES, a JSON object of the same shape, e.g.
 * `{"my-azure-deployment": {"input": 1.75, "cachedInput": 0.175, "output": 14}}`.
 */
export interface ModelPricePerMTok {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M cached/cache-read input tokens. Defaults to `input` when unset. */
  cachedInput?: number;
  /** USD per 1M output tokens (reasoning tokens bill as output). */
  output: number;
}

const DEFAULT_MODEL_PRICES: Record<string, ModelPricePerMTok> = {
  // OpenAI (verified against the official pricing page, 2026-06).
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.3-chat": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  // Anthropic (Claude reports exact cost via the agent SDK, so these mainly
  // serve the design-phase text client).
  "claude-sonnet-4": { input: 3, cachedInput: 0.3, output: 15 },
  "claude-haiku-4": { input: 1, cachedInput: 0.1, output: 5 },
  "claude-opus-4-1": { input: 15, cachedInput: 1.5, output: 75 },
  "claude-opus-4": { input: 5, cachedInput: 0.5, output: 25 },
};

/** Resolve the price for a model name; longest matching key wins. */
export function resolveModelPrice(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ModelPricePerMTok | undefined {
  if (!model) return undefined;
  const table = { ...DEFAULT_MODEL_PRICES, ...parseEnvPrices(env.MANSO_MODEL_PRICES) };
  const normalized = model.toLowerCase();
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.includes(key.toLowerCase())) return table[key];
  }
  return undefined;
}

/** Token counts the estimator understands (a subset of {@link AgentUsage}). */
export interface EstimableUsage {
  model?: string | undefined;
  /** Total input tokens, INCLUDING cached reads (OpenAI convention). */
  inputTokens?: number | undefined;
  /** Cached/cache-read input tokens (a subset of inputTokens). */
  cachedInputTokens?: number | undefined;
  /** Anthropic cache writes — billed at 1.25× input for the 5-minute cache. */
  cacheCreationInputTokens?: number | undefined;
  /** Output tokens (reasoning included, per provider convention). */
  outputTokens?: number | undefined;
  totalCostUsd?: number | undefined;
}

/**
 * USD cost for a usage record: the exact SDK-reported cost when present, else
 * tokens × the model's price-table entry, else `undefined` (unknown model or
 * no token counts — never silently 0, so callers can distinguish "free" from
 * "unmeterable").
 */
export function estimateUsageCostUsd(usage: EstimableUsage | AgentUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (usage.totalCostUsd !== undefined) return usage.totalCostUsd;

  const price = resolveModelPrice(usage.model);
  if (!price) return undefined;

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheCreation = ("cacheCreationInputTokens" in usage ? usage.cacheCreationInputTokens : undefined) ?? 0;
  if (input === 0 && output === 0 && cacheCreation === 0) return undefined;

  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const cachedRate = price.cachedInput ?? price.input;
  const usd =
    ((input - cached) * price.input +
      cached * cachedRate +
      cacheCreation * price.input * 1.25 +
      output * price.output) /
    1_000_000;
  return roundUsd(usd);
}

function parseEnvPrices(raw: string | undefined): Record<string, ModelPricePerMTok> {
  if (!raw || raw.trim().length === 0) return {};
  // Azure Pipelines leaves an unmapped variable as the literal `$(NAME)` —
  // treat that as "unset" so the ymls can pre-map MANSO_MODEL_PRICES
  // without a warning on every run.
  if (raw.trim().startsWith("$(")) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("MANSO_MODEL_PRICES is not valid JSON — ignoring.");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const out: Record<string, ModelPricePerMTok> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value === "object" && value !== null &&
      typeof (value as ModelPricePerMTok).input === "number" &&
      typeof (value as ModelPricePerMTok).output === "number"
    ) {
      out[key] = value as ModelPricePerMTok;
    } else {
      console.warn(`MANSO_MODEL_PRICES["${key}"] must have numeric input/output — ignoring this entry.`);
    }
  }
  return out;
}
