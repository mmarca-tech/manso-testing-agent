import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImplementTests, type EnvHooks } from "../src/cli/implementTests.js";
import type { StackConfig } from "../src/config/agentConfig.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";
import type { TestDesignPack } from "../src/domain/testDesignPack/schema.js";
import type { ImplementationAgentRunInput, ImplementationAgentRunner } from "../src/integrations/llm/agentRunner.js";

const STACK: StackConfig = { id: "playwright-bdd-ts", root: ".", verifyCommand: "node -e \"process.exit(0)\"" };

function design(): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "ENV-9", title: "Env-aware story" },
    outputMode: "gherkin",
    acceptanceCriteria: [{ id: "AC-1", text: "x" }],
    strategySummary: "", coverageGaps: [],
    scenarios: [{
      kind: "gherkin", title: "Open page", feature: "F", tags: ["@AC-1"], acIds: ["AC-1"], risk: "low", readiness: "ready",
      objective: "Open the page", preconditions: [],
      steps: [{ keyword: "Given", text: "I open" }, { keyword: "When", text: "x" }, { keyword: "Then", text: "y" }],
      sourceEvidence: [], openQuestions: [], rationale: "",
    }],
    acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }], riskRanking: [{ level: "low", scenarioIndexes: [0] }], openQuestions: [],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "ENV-9", llm: { provider: "anthropic", model: "stub" }, tools: [] },
    warnings: [],
  };
}

function capturingRunner(prompts: string[]): ImplementationAgentRunner {
  return {
    kind: "shell", commandLabel: "stub", provider: "anthropic", model: "stub",
    run: async (input: ImplementationAgentRunInput): Promise<CommandResult> => {
      prompts.push(input.prompt);
      return { command: "stub", exitCode: 0, durationMs: 1 };
    },
  };
}

describe("runImplementTests — M20 environment-aware", () => {
  let repoDir: string;
  let outDir: string;
  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "manso-env-"));
    outDir = await mkdtemp(join(tmpdir(), "manso-env-out-"));
  });
  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("explores, injects the brief into the implement prompt, and tears down", async () => {
    const prompts: string[] = [];
    const start = vi.fn(async () => ({ started: true, message: "ready" }));
    const stop = vi.fn(async () => undefined);
    const explore = vi.fn(async () => ({ modality: "ui" as const, brief: "BRIEF-XYZ real locators", warnings: [] }));
    const hooks: EnvHooks = { start, stop, explore };

    await runImplementTests({
      testDesign: design(), repoRoot: repoDir, outDir, stack: STACK,
      runner: capturingRunner(prompts),
      environment: { setupCommand: "echo up", appUrl: "http://localhost:9" },
      envHooks: hooks,
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(explore).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain("Live environment exploration");
    expect(prompts[0]).toContain("BRIEF-XYZ real locators");
    const briefFile = await readFile(join(outDir, "ENV-9", "exploration.md"), "utf8");
    expect(briefFile).toContain("BRIEF-XYZ");
  });

  it("falls back gracefully when the environment does not start (no brief, still tears down)", async () => {
    const prompts: string[] = [];
    const start = vi.fn(async () => ({ started: false, message: "docker unavailable" }));
    const stop = vi.fn(async () => undefined);
    const explore = vi.fn(async () => ({ modality: "ui" as const, brief: "should not be used", warnings: [] }));
    const hooks: EnvHooks = { start, stop, explore };

    const result = await runImplementTests({
      testDesign: design(), repoRoot: repoDir, outDir, stack: STACK,
      runner: capturingRunner(prompts),
      environment: { setupCommand: "echo up", appUrl: "http://localhost:9" },
      envHooks: hooks,
    });

    expect(explore).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1); // teardown attempted even though not started
    expect(prompts[0]).not.toContain("Live environment exploration");
    // the env warning is surfaced on the pack
    expect(result.pack.warnings.some((w) => w.message.includes("docker unavailable"))).toBe(true);
  });

  it("behaves exactly like today when no environment is configured", async () => {
    const prompts: string[] = [];
    const explore = vi.fn();
    const start = vi.fn();
    const stop = vi.fn();
    await runImplementTests({
      testDesign: design(), repoRoot: repoDir, outDir, stack: STACK,
      runner: capturingRunner(prompts),
      envHooks: { start, stop, explore } as unknown as EnvHooks,
    });
    expect(start).not.toHaveBeenCalled();
    expect(explore).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(prompts[0]).not.toContain("Live environment exploration");
  });
});
