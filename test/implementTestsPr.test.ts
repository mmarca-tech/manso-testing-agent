import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImplementTests } from "../src/cli/implementTests.js";
import type { StackConfig } from "../src/config/agentConfig.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";
import type { TestDesignPack } from "../src/domain/testDesignPack/schema.js";
import type {
  ImplementationAgentRunInput,
  ImplementationAgentRunner,
} from "../src/integrations/llm/agentRunner.js";
import { runShellCommand } from "../src/integrations/shell/runShellCommand.js";
import type {
  VcsAdapter,
  VcsRaisePullRequestInput,
  VcsRaisePullRequestResult,
} from "../src/integrations/vcs/adapter.js";

const STACK: StackConfig = {
  id: "playwright-bdd-ts",
  root: ".",
  verifyCommand: "node -e 'process.exit(0)'",
  featureGlob: "tests/**/*.feature",
};

function design(): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "PR-1", title: "PR sample" },
    outputMode: "gherkin",
    acceptanceCriteria: [{ id: "AC-1", text: "Customer can pay." }],
    strategySummary: "",
    coverageGaps: [],
    scenarios: [
      {
        kind: "gherkin",
        title: "Customer pays",
        feature: "Payments",
        tags: ["@AC-1", "@high"],
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
      issueKey: "PR-1",
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

function mockVcsAdapter(result: VcsRaisePullRequestResult): {
  adapter: VcsAdapter;
  raise: ReturnType<typeof vi.fn<(input: VcsRaisePullRequestInput) => Promise<VcsRaisePullRequestResult>>>;
} {
  const raise = vi.fn<(input: VcsRaisePullRequestInput) => Promise<VcsRaisePullRequestResult>>(async () => result);
  return {
    adapter: { kind: "azure-devops", raisePullRequest: raise },
    raise,
  };
}

async function initGitRepoWithRemote(workTree: string): Promise<string> {
  // Bare repo lives OUTSIDE the work tree so it does not show up as untracked
  // content when `git add -A` runs against the work tree.
  const remoteDir = await mkdtemp(join(tmpdir(), "manso-remote-"));

  const setup: { cmd: string; cwd: string }[] = [
    { cmd: "git init -q --bare", cwd: remoteDir },
    { cmd: "git init -q -b main", cwd: workTree },
    { cmd: 'git config user.email "ci@example.com"', cwd: workTree },
    { cmd: 'git config user.name "Manso CI"', cwd: workTree },
    { cmd: "git commit -q --allow-empty -m \"chore: init\"", cwd: workTree },
    { cmd: `git remote add origin "${remoteDir.replace(/\\/g, "/")}"`, cwd: workTree },
    { cmd: "git push -q -u origin main", cwd: workTree },
  ];
  for (const step of setup) {
    const result = await runShellCommand(step.cmd, { cwd: step.cwd });
    if (result.exitCode !== 0) {
      throw new Error(`Setup failed: ${step.cmd}\n${result.stderr}`);
    }
  }
  return remoteDir;
}

describe("runImplementTests — PR raise", () => {
  let workDir: string;
  let outDir: string;
  let remoteDir: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-pr-"));
    // outDir lives outside the git work tree so the implementation.prompt.md
    // file the Implementer writes is not picked up by `git add -A`.
    outDir = await mkdtemp(join(tmpdir(), "manso-pr-out-"));
    remoteDir = undefined;
  });

  afterEach(async () => {
    // Windows + git leaves file handles open briefly; retry the cleanup.
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (remoteDir) {
      await rm(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("calls the VcsAdapter after a successful commit (push not required when adapter is mocked)", async () => {
    remoteDir = await initGitRepoWithRemote(workDir);
    const runner = stubRunner(async (input) => {
      if (input.phase === "implementation") {
        await writeFile(join(workDir, "added.txt"), "hi\n", "utf8");
      }
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });
    const { adapter, raise } = mockVcsAdapter({
      status: "raised",
      url: "https://dev.azure.com/contoso/proj/_git/repo/pullrequest/1",
      pullRequestId: 1,
    });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      commit: { targetBranch: "main", push: true },
      pullRequest: { adapter, targetBranch: "main", title: "Manso: implement PR-1" },
    });

    expect(raise).toHaveBeenCalledTimes(1);
    const calledWith = raise.mock.calls[0]?.[0];
    expect(calledWith?.branch).toBe("PR-1");
    expect(calledWith?.targetBranch).toBe("main");
    expect(calledWith?.title).toBe("Manso: implement PR-1");
    expect(result.pack.pullRequest?.status).toBe("raised");
    expect(result.pack.pullRequest?.url).toContain("/pullrequest/1");
  });

  it("records status 'skipped' (with message) when there is nothing to commit", async () => {
    remoteDir = await initGitRepoWithRemote(workDir);
    const runner = stubRunner(async () => ({
      command: "stub-agent",
      exitCode: 0,
      durationMs: 1,
    }));
    const { adapter, raise } = mockVcsAdapter({ status: "raised" });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      commit: { targetBranch: "main", push: true },
      pullRequest: { adapter, targetBranch: "main" },
    });

    expect(raise).not.toHaveBeenCalled();
    expect(result.pack.pullRequest?.status).toBe("skipped");
    expect(result.pack.pullRequest?.message).toContain("Nothing to commit");
  });

  it("propagates adapter 'exists' status to the pack", async () => {
    remoteDir = await initGitRepoWithRemote(workDir);
    const runner = stubRunner(async (input) => {
      if (input.phase === "implementation") {
        await writeFile(join(workDir, "added.txt"), "hi\n", "utf8");
      }
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });
    const { adapter } = mockVcsAdapter({
      status: "exists",
      message: "PR already exists for PR-1 → main",
    });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      commit: { targetBranch: "main", push: true },
      pullRequest: { adapter, targetBranch: "main" },
    });

    expect(result.pack.pullRequest?.status).toBe("exists");
    expect(result.pack.pullRequest?.message).toContain("already exists");
  });

  it("honours pullRequest.dryRun and skips the network call via the adapter", async () => {
    remoteDir = await initGitRepoWithRemote(workDir);
    const runner = stubRunner(async (input) => {
      if (input.phase === "implementation") {
        await writeFile(join(workDir, "added.txt"), "hi\n", "utf8");
      }
      return { command: "stub-agent", exitCode: 0, durationMs: 1 };
    });
    const { adapter, raise } = mockVcsAdapter({ status: "dry-run", message: "would raise" });

    const result = await runImplementTests({
      testDesign: design(),
      repoRoot: workDir,
      outDir,
      stack: STACK,
      runner,
      commit: { targetBranch: "main", push: true },
      pullRequest: { adapter, targetBranch: "main", dryRun: true },
    });

    expect(raise).toHaveBeenCalledTimes(1);
    const arg = raise.mock.calls[0]?.[0];
    expect(arg?.dryRun).toBe(true);
    expect(result.pack.pullRequest?.status).toBe("dry-run");
  });
});
