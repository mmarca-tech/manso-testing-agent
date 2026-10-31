import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImplementer } from "../src/agents/implementer/index.js";
import { buildImplementationPrompt } from "../src/agents/implementer/prompts.js";
import { runVerifier } from "../src/agents/verifier/index.js";
import { runImplementTests } from "../src/cli/implementTests.js";
import type { StackConfig } from "../src/config/agentConfig.js";
import { ImplementationPackSchema } from "../src/domain/implementationPack/schema.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";
import type { TestDesignPack } from "../src/domain/testDesignPack/schema.js";
import type {
  ImplementationAgentRunInput,
  ImplementationAgentRunner,
} from "../src/integrations/llm/agentRunner.js";
import type { Skill } from "../src/skillLoader/types.js";

const PLAYWRIGHT_STACK: StackConfig = {
  id: "playwright-bdd-ts",
  root: ".",
  verifyCommand: "npx playwright test",
  featureGlob: "tests/**/*.feature",
};

const BINDING_SKILL: Skill = {
  name: "playwright-bdd-ts",
  description: "stub binding skill",
  appliesTo: { stacks: ["playwright-bdd-ts"], phase: "implementation" },
  body: "Skill body for tests.",
  source: "packaged",
  path: "/skills/playwright-bdd-ts/SKILL.md",
};

function testDesign(): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "IMPL-1", title: "Sample story" },
    outputMode: "gherkin",
    acceptanceCriteria: [{ id: "AC-1", text: "Customer can checkout." }],
    strategySummary: "",
    coverageGaps: [],
    scenarios: [
      {
        kind: "gherkin",
        title: "Customer checks out successfully",
        feature: "Checkout",
        tags: ["@checkout", "@smoke"],
        acIds: ["AC-1"],
        risk: "high",
        readiness: "ready",
        objective: "Verify checkout completes.",
        preconditions: ["A customer is signed in"],
        steps: [
          { keyword: "Given", text: "a customer is signed in" },
          { keyword: "When", text: "the customer pays" },
          { keyword: "Then", text: "the order is confirmed" },
        ],
        sourceEvidence: [{ source: "description", reference: "para 1", summary: "Direct positive path." }],
        openQuestions: [],
        rationale: "Direct positive path.",
      },
    ],
    acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }],
    riskRanking: [{ level: "high", scenarioIndexes: [0] }],
    openQuestions: [],
    provenance: {
      generatedAt: "2024-01-01T00:00:00.000Z",
      issueKey: "IMPL-1",
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

describe("buildImplementationPrompt", () => {
  it("includes the ticket key, stack, scenarios, and skill body", () => {
    const prompt = buildImplementationPrompt({
      testDesign: testDesign(),
      repoRoot: "/tmp/repo",
      stack: PLAYWRIGHT_STACK,
      bindingSkill: BINDING_SKILL,
      guidanceFiles: [
        { path: ".agents/test-architecture.md", content: "# Test Architecture\n\nRule one." },
      ],
      featurePaths: [],
    });
    expect(prompt).toContain("# Implement Gherkin tests for IMPL-1");
    expect(prompt).toContain("Stack: playwright-bdd-ts");
    expect(prompt).toContain("Skill body for tests.");
    expect(prompt).toContain("Rule one.");
    expect(prompt).toContain("Scenario 1 — Customer checks out successfully");
    expect(prompt).toContain("Given a customer is signed in");
  });

  it("lists available MCP tools when servers are supplied", () => {
    const prompt = buildImplementationPrompt({
      testDesign: testDesign(),
      repoRoot: "/tmp/repo",
      stack: PLAYWRIGHT_STACK,
      bindingSkill: BINDING_SKILL,
      guidanceFiles: [],
      featurePaths: [],
      mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
    });
    expect(prompt).toContain("## Available MCP tools");
    expect(prompt).toContain("- playwright (stdio): npx @playwright/mcp@latest");
  });

  it("omits the MCP section when no servers are supplied", () => {
    const prompt = buildImplementationPrompt({
      testDesign: testDesign(),
      repoRoot: "/tmp/repo",
      stack: PLAYWRIGHT_STACK,
      bindingSkill: BINDING_SKILL,
      guidanceFiles: [],
      featurePaths: [],
    });
    expect(prompt).not.toContain("## Available MCP tools");
  });
});

describe("runImplementer", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-impl-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("invokes the runner, derives 'completed' status on success", async () => {
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 0,
      durationMs: 12,
      stdout: "did the work",
    }));

    const result = await runImplementer({
      testDesign: testDesign(),
      repoRoot: workDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      bindingSkill: BINDING_SKILL,
    });

    expect(result.status).toBe("completed");
    expect(result.implementation.exitCode).toBe(0);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.status).toBe("implemented");
  });

  it("marks scenarios failed when the runner returns non-zero exit", async () => {
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 1,
      durationMs: 3,
      stderr: "boom",
    }));

    const result = await runImplementer({
      testDesign: testDesign(),
      repoRoot: workDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      bindingSkill: BINDING_SKILL,
    });

    expect(result.status).toBe("failed");
    expect(result.scenarios[0]?.status).toBe("failed");
    expect(result.scenarios[0]?.reason).toMatch(/non-zero/i);
  });

  it("writes the prompt to disk when promptPath is provided", async () => {
    const promptPath = join(workDir, "prompt.md");
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 0,
      durationMs: 1,
    }));

    const result = await runImplementer({
      testDesign: testDesign(),
      repoRoot: workDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      bindingSkill: BINDING_SKILL,
      promptPath,
    });

    expect(result.promptPath).toBe(promptPath);
    const onDisk = await readFile(promptPath, "utf8");
    expect(onDisk).toContain("# Implement Gherkin tests for IMPL-1");
  });

  it("resolves MCP secrets and passes the servers to the runner", async () => {
    let received: ImplementationAgentRunInput | undefined;
    const runner = stubRunner(async (input) => {
      received = input;
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });

    const result = await runImplementer({
      testDesign: testDesign(),
      repoRoot: workDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      bindingSkill: BINDING_SKILL,
      env: { FIGMA_TOKEN: "secret-xyz" } as NodeJS.ProcessEnv,
      mcpServers: {
        figma: { type: "http", url: "https://figma.example/mcp", headers: { Authorization: "Bearer ${FIGMA_TOKEN}" } },
      },
    });

    const figma = received?.mcpServers?.figma as { headers: Record<string, string> } | undefined;
    expect(figma?.headers.Authorization).toBe("Bearer secret-xyz");
    // The prompt advertises the server too.
    expect(result.prompt).toContain("## Available MCP tools");
    expect(result.prompt).toContain("- figma (http): https://figma.example/mcp");
  });

  it("picks up .agents guidance files from the target repo", async () => {
    await mkdir(join(workDir, ".agents"), { recursive: true });
    await writeFile(join(workDir, ".agents/test-architecture.md"), "# Custom Test Architecture\n\nUse fixtures from src/test-helpers.", "utf8");
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 0,
      durationMs: 1,
    }));

    const result = await runImplementer({
      testDesign: testDesign(),
      repoRoot: workDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      bindingSkill: BINDING_SKILL,
    });

    expect(result.prompt).toContain("Custom Test Architecture");
    expect(result.prompt).toContain("Use fixtures from src/test-helpers.");
  });
});

describe("runVerifier", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-verify-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("captures a passing command (exit 0)", async () => {
    const result = await runVerifier({
      command: `node -e "process.stdout.write('ok')"`,
      repoRoot: workDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("captures a failing command (exit 1) without throwing", async () => {
    const result = await runVerifier({
      command: `node -e "console.error('bad'); process.exit(1)"`,
      repoRoot: workDir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bad");
  });
});

describe("runImplementTests", () => {
  let workDir: string;
  let outDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-run-impl-"));
    outDir = join(workDir, "out");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("dry-run produces a dry-run ImplementationPack and writes artifacts", async () => {
    const runner = stubRunner(async () => {
      throw new Error("runner should not be invoked during dry-run");
    });

    const result = await runImplementTests({
      testDesign: testDesign(),
      repoRoot: workDir,
      outDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      dryRun: true,
    });

    expect(result.pack.status).toBe("dry-run");
    expect(result.pack.scenarios.every((scenario) => scenario.status === "skipped")).toBe(true);
    expect(() => ImplementationPackSchema.parse(result.pack)).not.toThrow();
    const written = await readFile(result.jsonPath, "utf8");
    expect(JSON.parse(written).status).toBe("dry-run");
  });

  it("runs implementer + verifier and reports completed when both succeed", async () => {
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 0,
      durationMs: 1,
      stdout: "implemented",
    }));

    const result = await runImplementTests({
      testDesign: testDesign(),
      repoRoot: workDir,
      outDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      verifyCommand: `node -e "process.exit(0)"`,
    });

    expect(result.pack.status).toBe("completed");
    expect(result.pack.verification?.exitCode).toBe(0);
    expect(result.pack.implementation.stdout).toBe("implemented");
  });

  it("reports partial when verification fails after a successful agent run", async () => {
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 0,
      durationMs: 1,
    }));

    const result = await runImplementTests({
      testDesign: testDesign(),
      repoRoot: workDir,
      outDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      verifyCommand: `node -e "process.exit(1)"`,
    });

    expect(result.pack.status).toBe("partial");
    expect(result.pack.verification?.exitCode).toBe(1);
  });

  it("skips verification when skipVerify is true", async () => {
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 0,
      durationMs: 1,
    }));

    const result = await runImplementTests({
      testDesign: testDesign(),
      repoRoot: workDir,
      outDir,
      stack: PLAYWRIGHT_STACK,
      runner,
      skipVerify: true,
    });

    expect(result.pack.verification).toBeUndefined();
  });
});
