import { describe, expect, it } from "vitest";
import { agentUsageSpanAttributes, codexBaseUrlWarning, runImplementationAgent, type ImplementationAgentRunInput, type ImplementationAgentRunner } from "../src/integrations/llm/agentRunner.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";

const input: ImplementationAgentRunInput = {
  issueKey: "FINT-1",
  repoRoot: "/repo",
  prompt: "do it",
  env: {},
  phase: "implementation",
};

const claudeRunner = { kind: "claude-sdk", provider: "anthropic", model: "claude-sonnet-4-6", commandLabel: "claude-sdk" } as unknown as ImplementationAgentRunner;
const codexRunner = { kind: "codex-sdk", provider: "openai", model: "gpt-5.3", commandLabel: "codex-sdk" } as unknown as ImplementationAgentRunner;

describe("agentUsageSpanAttributes — Langfuse cost/usage mapping", () => {
  it("emits Langfuse-native generation attributes with exact cost for Claude", () => {
    const result: CommandResult = {
      command: "claude-sdk",
      exitCode: 0,
      durationMs: 100,
      usage: { provider: "anthropic", model: "claude-sonnet-4-6", inputTokens: 1200, outputTokens: 340, totalCostUsd: 0.0123 },
    };

    const attrs = agentUsageSpanAttributes(result, input, claudeRunner);

    expect(attrs["langfuse.observation.type"]).toBe("generation");
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(1200);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(340);
    expect(attrs["langfuse.observation.cost_details"]).toBe(JSON.stringify({ total: 0.0123 }));
    // Back-compat / Phoenix attributes are still present.
    expect(attrs["llm.model_name"]).toBe("claude-sonnet-4-6");
    expect(attrs["llm.cost.total_usd"]).toBe(0.0123);
  });

  it("emits a cache-aware ESTIMATED cost for Codex (no SDK cost) from the price table", () => {
    const result: CommandResult = {
      command: "codex-sdk",
      exitCode: 0,
      durationMs: 100,
      usage: { provider: "openai", model: "gpt-5.3-codex", inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 },
    };

    const attrs = agentUsageSpanAttributes(result, input, codexRunner);

    expect(attrs["langfuse.observation.type"]).toBe("generation");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(1000);
    expect(attrs["gen_ai.usage.cached_input_tokens"]).toBe(800);
    // (1000-800)×$1.75 + 800×$0.175 + 100×$14 per MTok = $0.00189
    expect(attrs["langfuse.observation.cost_details"]).toBe(JSON.stringify({ total: 0.00189 }));
    // No exact SDK cost → the legacy exact-cost attribute stays unset.
    expect(attrs["llm.cost.total_usd"]).toBeUndefined();
  });

  it("omits cost_details when the model has no price-table entry", () => {
    const result: CommandResult = {
      command: "codex-sdk",
      exitCode: 0,
      durationMs: 100,
      usage: { provider: "openai", model: "some-unknown-deployment", inputTokens: 500, outputTokens: 80 },
    };

    const attrs = agentUsageSpanAttributes(result, input, codexRunner);
    expect(attrs["langfuse.observation.cost_details"]).toBeUndefined();
  });

  it("falls back to the runner model when usage carries none", () => {
    const result: CommandResult = { command: "claude-sdk", exitCode: 1, durationMs: 5 };
    const attrs = agentUsageSpanAttributes(result, input, claudeRunner);
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attrs["langfuse.observation.cost_details"]).toBeUndefined();
  });
});

describe("codexBaseUrlWarning (Azure Foundry WebSocket 302)", () => {
  it("warns for the services.ai.azure.com host", () => {
    expect(codexBaseUrlWarning("https://myres.services.ai.azure.com/openai/v1")).toContain("openai.azure.com");
  });

  it("is silent for openai.azure.com, api.openai.com, and unset", () => {
    expect(codexBaseUrlWarning("https://myres.openai.azure.com/openai/v1")).toBeUndefined();
    expect(codexBaseUrlWarning("https://api.openai.com/v1")).toBeUndefined();
    expect(codexBaseUrlWarning(undefined)).toBeUndefined();
  });
});

describe("runImplementationAgent — telemetry wiring", () => {
  it("passes through to the runner (and returns its result) when telemetry is off", async () => {
    const calls: ImplementationAgentRunInput[] = [];
    const runner = {
      kind: "shell",
      commandLabel: "stub",
      run: async (i: ImplementationAgentRunInput): Promise<CommandResult> => {
        calls.push(i);
        return { command: "stub", exitCode: 0, durationMs: 1 };
      },
    } as unknown as ImplementationAgentRunner;

    // undefined telemetry → createTracedWorkflow returns the runner unchanged,
    // so the agent still runs (this is the property the implementer/healer rely
    // on now that they route through runImplementationAgent instead of runner.run).
    const result = await runImplementationAgent(runner, input, undefined);

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.issueKey).toBe("FINT-1");
  });
});
