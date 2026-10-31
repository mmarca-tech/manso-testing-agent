import { describe, expect, it } from "vitest";
import { estimateUsageCostUsd, resolveModelPrice } from "../src/policy/modelPrices.js";
import { sumUsageCost } from "../src/policy/budget.js";

describe("resolveModelPrice", () => {
  it("matches known models by substring (azure deployment names included)", () => {
    expect(resolveModelPrice("gpt-5.3-codex")?.input).toBe(1.75);
    expect(resolveModelPrice("my-team-gpt-5.3-chat-deployment")?.output).toBe(14);
    expect(resolveModelPrice("claude-sonnet-4-6")?.input).toBe(3);
  });

  it("prefers the longest matching key (opus 4.1 ≠ opus 4.x pricing)", () => {
    expect(resolveModelPrice("claude-opus-4-1")?.input).toBe(15);
    expect(resolveModelPrice("claude-opus-4-8")?.input).toBe(5);
  });

  it("supports MANSO_MODEL_PRICES overrides and ignores invalid entries", () => {
    const env = {
      MANSO_MODEL_PRICES: JSON.stringify({
        "my-custom-model": { input: 2, cachedInput: 0.2, output: 8 },
        "broken-entry": { input: "x" },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveModelPrice("my-custom-model-v2", env)).toEqual({ input: 2, cachedInput: 0.2, output: 8 });
    expect(resolveModelPrice("broken-entry", env)).toBeUndefined();
  });

  it("returns undefined for unknown models", () => {
    expect(resolveModelPrice("totally-unknown")).toBeUndefined();
    expect(resolveModelPrice(undefined)).toBeUndefined();
  });

  it("silently ignores an unexpanded Azure macro in MANSO_MODEL_PRICES", () => {
    const env = { MANSO_MODEL_PRICES: "$(MANSO_MODEL_PRICES)" } as NodeJS.ProcessEnv;
    // No warning path, no throw — defaults still apply.
    expect(resolveModelPrice("gpt-5.3-codex", env)?.input).toBe(1.75);
  });
});

describe("estimateUsageCostUsd", () => {
  it("exact SDK-reported cost always wins", () => {
    expect(estimateUsageCostUsd({ model: "gpt-5.3-codex", inputTokens: 1000, outputTokens: 100, totalCostUsd: 0.5 })).toBe(0.5);
  });

  it("is cache-aware — reproduces the observed Codex run within rounding", () => {
    // The real FINT-1056 docker run: 560,186 input (482,688 cached) / 3,858 out.
    // Pricing total input at the full rate showed ~$1.03 in Langfuse; actual:
    const cost = estimateUsageCostUsd({
      model: "gpt-5.3-codex",
      inputTokens: 560_186,
      cachedInputTokens: 482_688,
      outputTokens: 3_858,
    });
    expect(cost).toBeCloseTo(0.274104, 5);
  });

  it("returns undefined (not 0) for unknown models or empty usage", () => {
    expect(estimateUsageCostUsd({ model: "mystery", inputTokens: 100, outputTokens: 10 })).toBeUndefined();
    expect(estimateUsageCostUsd({ model: "gpt-5.3-codex" })).toBeUndefined();
    expect(estimateUsageCostUsd(undefined)).toBeUndefined();
  });
});

describe("sumUsageCost (budget now sees Codex)", () => {
  it("sums exact Claude cost + estimated Codex cost", () => {
    const total = sumUsageCost([
      { provider: "anthropic", model: "claude-sonnet-4-6", totalCostUsd: 0.1 },
      { provider: "openai", model: "gpt-5.3-codex", inputTokens: 1_000_000, outputTokens: 0 }, // $1.75
      undefined,
    ]);
    expect(total).toBeCloseTo(1.85, 6);
  });

  it("still counts unmeterable usages as 0", () => {
    expect(sumUsageCost([{ provider: "openai", model: "mystery", inputTokens: 100 }])).toBe(0);
  });
});
