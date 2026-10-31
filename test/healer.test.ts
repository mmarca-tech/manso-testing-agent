import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHealingPrompt } from "../src/agents/implementer/prompts.js";
import { runImplementTests } from "../src/cli/implementTests.js";
import type { StackConfig } from "../src/config/agentConfig.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";
import type { TestDesignPack } from "../src/domain/testDesignPack/schema.js";
import type {
  ImplementationAgentRunInput,
  ImplementationAgentRunner,
} from "../src/integrations/llm/agentRunner.js";

const STACK: StackConfig = {
  id: "playwright-bdd-ts",
  root: ".",
  verifyCommand: "node -e 'process.exit(0)'",
  featureGlob: "tests/**/*.feature",
};

function design(): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "HEAL-1", title: "Heal sample" },
    outputMode: "gherkin",
    acceptanceCriteria: [{ id: "AC-1", text: "Customer can pay." }],
    strategySummary: "",
    coverageGaps: [],
    scenarios: [
      {
        kind: "gherkin",
        title: "Customer pays",
        feature: "Payments",
        tags: ["@payments", "@smoke"],
        acIds: ["AC-1"],
        risk: "high",
        readiness: "ready",
        objective: "Verify checkout completes.",
        preconditions: [],
        steps: [
          { keyword: "Given", text: "a logged-in customer" },
          { keyword: "When", text: "they pay" },
          { keyword: "Then", text: "the order is confirmed" },
        ],
        sourceEvidence: [{ source: "description", reference: "x", summary: "y" }],
        openQuestions: [],
        rationale: "Direct path.",
      },
    ],
    acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }],
    riskRanking: [{ level: "high", scenarioIndexes: [0] }],
    openQuestions: [],
    provenance: {
      generatedAt: "2024-01-01T00:00:00.000Z",
      issueKey: "HEAL-1",
      llm: { provider: "anthropic", model: "stub" },
      tools: [],
    },
    warnings: [],
  };
}

function stubRunner(
  impl: (input: ImplementationAgentRunInput) => Promise<CommandResult> | CommandResult,
): ImplementationAgentRunner {
  return {
    kind: "shell",
    commandLabel: "stub-agent",
    provider: "anthropic",
    model: "stub-model",
    run: async (input) => await impl(input),
  };
}

/** A verify command that exits 0 only when `markerPath` exists. */
function verifyForMarker(markerPath: string): string {
  // Use Node so this works on Windows and Linux/macOS the same way.
  const escaped = markerPath.replace(/\\/g, "\\\\");
  return `node -e "process.exit(require('fs').existsSync('${escaped}') ? 0 : 1)"`;
}

describe("buildHealingPrompt", () => {
  it("includes the failing verification output", () => {
    const prompt = buildHealingPrompt({
      issueKey: "HEAL-1",
      repoRoot: "/tmp/repo",
      attempt: 1,
      maxAttempts: 2,
      verification: {
        command: "npm test",
        exitCode: 1,
        durationMs: 1234,
        stdout: "some output",
        stderr: "boom — assertion failed",
      },
      changedFiles: ["tests/a.spec.ts"],
    });
    expect(prompt).toContain("# Heal generated tests for HEAL-1");
    expect(prompt).toContain("Healing attempt: 1 of 2");
    expect(prompt).toContain("boom — assertion failed");
    expect(prompt).toContain("tests/a.spec.ts");
  });
});

describe("runImplementTests — heal loop", () => {
  let workDir: string;
  let outDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-heal-"));
    outDir = join(workDir, "out");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("retries on verify failure and reaches 'completed' when the heal pass fixes it", async () => {
    const markerPath = join(workDir, "healed.flag");
    let healingCalls = 0;
    const runner = stubRunner(async (input) => {
      if (input.phase === "healing") {
        healingCalls += 1;
        await writeFile(markerPath, "healed", "utf8");
      }
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      verifyCommand: verifyForMarker(markerPath),
      maxHealAttempts: 2,
    });

    expect(healingCalls).toBe(1);
    expect(result.pack.healingAttempts).toHaveLength(1);
    expect(result.pack.healingAttempts[0]?.verification.exitCode).toBe(0);
    expect(result.pack.status).toBe("completed");
    expect(result.pack.verification?.exitCode).toBe(0);
  });

  it("exhausts max-heal-attempts and reports 'partial' when the heal pass still fails", async () => {
    const stableMissingMarker = join(workDir, "never-created.flag");
    let healingCalls = 0;
    const runner = stubRunner(async (input) => {
      if (input.phase === "healing") healingCalls += 1;
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      verifyCommand: verifyForMarker(stableMissingMarker),
      maxHealAttempts: 2,
    });

    expect(healingCalls).toBe(2);
    expect(result.pack.healingAttempts).toHaveLength(2);
    expect(result.pack.healingAttempts.every((attempt) => attempt.verification.exitCode === 1)).toBe(true);
    expect(result.pack.status).toBe("partial");
  });

  it("never invokes the healer when maxHealAttempts is 0", async () => {
    const stableMissingMarker = join(workDir, "never-created.flag");
    let healingCalls = 0;
    const runner = stubRunner(async (input) => {
      if (input.phase === "healing") healingCalls += 1;
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      verifyCommand: verifyForMarker(stableMissingMarker),
      maxHealAttempts: 0,
    });

    expect(healingCalls).toBe(0);
    expect(result.pack.healingAttempts).toHaveLength(0);
    expect(result.pack.status).toBe("partial");
  });

  it("writes the implementation.json reflecting the heal attempts", async () => {
    const markerPath = join(workDir, "healed.flag");
    const runner = stubRunner(async (input) => {
      if (input.phase === "healing") {
        await writeFile(markerPath, "healed", "utf8");
      }
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      verifyCommand: verifyForMarker(markerPath),
      maxHealAttempts: 2,
    });

    const written = JSON.parse(await readFile(result.jsonPath, "utf8"));
    expect(written.healingAttempts).toHaveLength(1);
    expect(written.status).toBe("completed");
  });
});
