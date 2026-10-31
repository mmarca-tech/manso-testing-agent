import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImplementTests } from "../src/cli/implementTests.js";
import type { StackConfig } from "../src/config/agentConfig.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";
import type { TestDesignPack } from "../src/domain/testDesignPack/schema.js";
import type { ImplementationAgentRunInput, ImplementationAgentRunner } from "../src/integrations/llm/agentRunner.js";
import { runShellCommand } from "../src/integrations/shell/runShellCommand.js";

function design(): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "RESCUE-1", title: "Rescue sample" },
    outputMode: "gherkin",
    acceptanceCriteria: [{ id: "AC-1", text: "x" }],
    strategySummary: "", coverageGaps: [],
    scenarios: [{
      kind: "gherkin", title: "A scenario", feature: "F", tags: [], acIds: ["AC-1"], risk: "low", readiness: "ready",
      objective: "verify", preconditions: [],
      steps: [{ keyword: "Given", text: "a" }, { keyword: "When", text: "b" }, { keyword: "Then", text: "c" }],
      sourceEvidence: [], openQuestions: [], rationale: "",
    }],
    acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }],
    riskRanking: [{ level: "low", scenarioIndexes: [0] }],
    openQuestions: [],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "RESCUE-1", llm: { provider: "anthropic", model: "stub" }, tools: [] },
    warnings: [],
  };
}

/** Agent stub that edits a file and then "crashes" (non-zero exit), like the
 *  observed Codex WebSocket drop after a finished implementation. */
function crashingRunnerThatDoesTheWork(repoDir: string): ImplementationAgentRunner {
  return {
    kind: "shell",
    commandLabel: "stub-agent",
    provider: "openai",
    model: "stub",
    run: async (_input: ImplementationAgentRunInput): Promise<CommandResult> => {
      await writeFile(join(repoDir, "steps.ts"), "// implemented step definitions\n", "utf8");
      return { command: "stub-agent", exitCode: 1, durationMs: 5, stderr: "Reconnecting... 5/5 (unexpected status 302 Found)" };
    },
  };
}

describe("runImplementTests — rescue verified work from a failed agent exit (P1-2)", () => {
  let repoDir: string;
  let outDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "manso-rescue-"));
    outDir = await mkdtemp(join(tmpdir(), "manso-rescue-out-"));
    for (const cmd of [
      "git init -q -b main",
      'git config user.email "ci@example.com"',
      'git config user.name "Manso CI"',
      'git commit -q --allow-empty -m "init"',
    ]) {
      const result = await runShellCommand(cmd, { cwd: repoDir });
      if (result.exitCode !== 0) throw new Error(`setup failed: ${cmd}\n${result.stderr}`);
    }
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("reports 'partial' (not 'failed') and still commits when verify passed with changed files", async () => {
    const stack: StackConfig = { id: "playwright-bdd-ts", root: ".", verifyCommand: 'node -e "process.exit(0)"' };
    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: repoDir,
      outDir,
      stack,
      runner: crashingRunnerThatDoesTheWork(repoDir),
      commit: {},
    });

    expect(result.pack.status).toBe("partial");
    expect(result.pack.branch).toBeDefined();
    expect(result.pack.changedFiles).toContain("steps.ts");
    expect(result.pack.warnings.some((w) => w.section === "implementation" && w.message.includes("verify passed"))).toBe(true);
  });

  it("still reports 'failed' when the agent crashed AND verify is red", async () => {
    const stack: StackConfig = { id: "playwright-bdd-ts", root: ".", verifyCommand: 'node -e "process.exit(1)"' };
    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: repoDir,
      outDir,
      stack,
      runner: crashingRunnerThatDoesTheWork(repoDir),
    });

    expect(result.pack.status).toBe("failed");
  });

  it("still reports 'failed' when the agent crashed without changing anything", async () => {
    const stack: StackConfig = { id: "playwright-bdd-ts", root: ".", verifyCommand: 'node -e "process.exit(0)"' };
    const noWorkRunner: ImplementationAgentRunner = {
      kind: "shell",
      commandLabel: "stub-agent",
      run: async () => ({ command: "stub-agent", exitCode: 1, durationMs: 5, stderr: "boom" }),
    };
    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: repoDir,
      outDir,
      stack,
      runner: noWorkRunner,
    });

    expect(result.pack.status).toBe("failed");
  });
});
