import { describe, expect, it } from "vitest";
import {
  addUsage,
  extractAnthropicUsage,
  extractOpenAiChatUsage,
  extractOpenAiResponsesUsage,
  newUsageTotals,
} from "../src/integrations/llm/usage.js";
import { resolveM22Options } from "../src/cli/designTests.js";

describe("LLM usage extraction (design-phase cost metering)", () => {
  it("extracts Chat Completions usage incl. cached prompt tokens", () => {
    expect(
      extractOpenAiChatUsage({
        choices: [],
        usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 } },
      }),
    ).toEqual({ inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 300 });
  });

  it("extracts Responses API usage incl. cached input tokens", () => {
    expect(
      extractOpenAiResponsesUsage({
        output: [],
        usage: { input_tokens: 800, output_tokens: 150, input_tokens_details: { cached_tokens: 600 } },
      }),
    ).toEqual({ inputTokens: 800, cachedInputTokens: 600, outputTokens: 150 });
  });

  it("folds Anthropic's disjoint cache fields back into total input", () => {
    expect(
      extractAnthropicUsage({
        content: [],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 200 },
      }),
    ).toEqual({ inputTokens: 700, cachedInputTokens: 400, outputTokens: 50 });
  });

  it("returns undefined when the payload has no usage block", () => {
    expect(extractOpenAiChatUsage({ choices: [] })).toBeUndefined();
    expect(extractOpenAiChatUsage("nope")).toBeUndefined();
  });

  it("accumulates across calls (and counts calls even without usage)", () => {
    const totals = newUsageTotals();
    addUsage(totals, { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 });
    addUsage(totals, undefined);
    addUsage(totals, { inputTokens: 50, cachedInputTokens: 0, outputTokens: 5 });
    expect(totals).toEqual({ calls: 3, inputTokens: 150, cachedInputTokens: 20, outputTokens: 15 });
  });
});

describe("resolveM22Options (one default for every run shape)", () => {
  it("defaults to ON with the warn gate when nothing is configured (repo-less run)", () => {
    expect(resolveM22Options({}, {})).toEqual({
      deriveRequirements: true,
      adversarialCritique: true,
      riskCoverageGate: "warn",
    });
  });

  it("repo config can turn the passes off / raise the gate", () => {
    expect(resolveM22Options({}, { deriveRequirements: false, riskCoverageGate: "required" })).toEqual({
      deriveRequirements: false,
      adversarialCritique: true,
      riskCoverageGate: "required",
    });
  });

  it("flags override the repo config", () => {
    expect(
      resolveM22Options(
        { deriveRequirements: true, riskCoverageGate: "off" },
        { deriveRequirements: false, riskCoverageGate: "required" },
      ),
    ).toEqual({ deriveRequirements: true, adversarialCritique: true, riskCoverageGate: "off" });
  });
});
