import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolProvenance } from "../src/domain/contextPack/schema.js";
import type { XrayTestGenerationPack } from "../src/domain/xrayTestGeneration/schema.js";
import { AzureDevOpsClient } from "../src/integrations/azureDevOps/client.js";
import { AzureDevOpsPullRequestCreator } from "../src/integrations/azureDevOps/pullRequestCreator.js";
import {
  resolveAzureDevOpsRepositoryFromEnvironment,
  resolveAzureDevOpsRepositoryFromRemote,
} from "../src/integrations/azureDevOps/pullRequestCreator.js";
import { parseGitChangedFiles } from "../src/integrations/git/localGit.js";
import { agentUsageSpanAttributes, resolveImplementationAgentRunners } from "../src/workflows/xray-test-implementation/agentRunner.js";
import { parseXrayTestImplementationArgs, resolveImplementationCommands, type ParsedArgs } from "../src/workflows/xray-test-implementation/implementationArgs.js";
import { checkoutImplementationBranch } from "../src/workflows/xray-test-implementation/implementationGit.js";
import { buildXrayTestHealingPrompt, buildXrayTestImplementationPrompt } from "../src/workflows/xray-test-implementation/prompt.js";
import { runXrayTestImplementation } from "../src/xrayTestImplementationCli.js";

describe("buildXrayTestImplementationPrompt", () => {
  it("combines generated Xray cases with repo-owned guidance", () => {
    const prompt = buildXrayTestImplementationPrompt({
      generation: generationPack(),
      repoRoot: "/repo",
      branch: "tests/proj-1-xray-implementation",
      targetBranch: "main",
      sourceXrayTestGenerationPath: "out/PROJ-1/xray-test-generation.json",
      verifyCommand: "npm test",
      guidanceFiles: [
        {
          path: "architecture/test-architecture.md",
          content: "Use Playwright for browser workflows.",
        },
        {
          path: ".manso/repo-conventions.json",
          content: '{ "testDirectory": "tests/e2e" }',
        },
      ],
    });

    expect(prompt).toContain("Implement Generated Xray Test Cases for PROJ-1");
    expect(prompt).toContain("Total provided Xray cases: 3");
    expect(prompt).toContain("Ready implementation candidates: 2");
    expect(prompt).toContain("Xray create/update/deprecate issue actions: 2");
    expect(prompt).toContain("Existing Xray keep actions requiring repository duplicate check: 1");
    expect(prompt).toContain("Deprecated Xray cases excluded from automation: 1");
    expect(prompt).toContain("Manual Xray steps to automate");
    expect(prompt).toContain("Use Playwright for browser workflows.");
    expect(prompt).toContain('"testDirectory": "tests/e2e"');
    expect(prompt).toContain("Requested validation command: npm test");
    expect(prompt).toContain("## Implementation Contract");
    expect(prompt).toContain("Implement only the provided Xray cases");
    expect(prompt).toContain("Do not automate action \"deprecate\" cases");
    expect(prompt).toContain("\"keep\" means keep the existing Xray issue unchanged; \"deprecate\" means do not automate the obsolete case");
    expect(prompt).toContain("search the repository for the Xray key, manual title, and equivalent behavior");
    expect(prompt).toContain("Do not treat missing manual steps as proof of existing automated coverage");
    expect(prompt).toContain("Do not weaken assertions to make verification pass");
    expect(prompt).not.toContain("Keep-only existing cases provided for context");
    expect(prompt).not.toContain("Do not duplicate existing coverage for keep cases");
  });
});

describe("buildXrayTestHealingPrompt", () => {
  it("focuses the agent on the failed verification output and changed files", () => {
    const prompt = buildXrayTestHealingPrompt({
      issueKey: "PROJ-1",
      repoRoot: "/repo",
      branch: "tests/proj-1-xray-implementation",
      targetBranch: "main",
      originalPromptPath: "/repo/out/PROJ-1/xray-test-implementation-prompt.md",
      attempt: 2,
      maxAttempts: 4,
      changedFiles: ["tests/new.spec.ts"],
      verification: {
        command: "npm test",
        exitCode: 1,
        durationMs: 123,
        stdout: "Expected true to be false",
        stderr: "stack trace",
      },
    });

    expect(prompt).toContain("Heal Generated Xray Test Implementation for PROJ-1");
    expect(prompt).toContain("Healing attempt: 2 of 4");
    expect(prompt).toContain("tests/new.spec.ts");
    expect(prompt).toContain("Expected true to be false");
    expect(prompt).toContain("Fix only the generated or modified tests");
    expect(prompt).toContain("## Healing Contract");
    expect(prompt).toContain("Repair only the tests, test support, or directly required test documentation");
    expect(prompt).toContain("Do not add new Xray scenarios");
  });
});

describe("runXrayTestImplementation healing", () => {
  it("does not run healing when initial verification passes", async () => {
    const repo = await createImplementationRepo({
      verifyScript: "process.exit(0);\n",
      healScript: "require('node:fs').appendFileSync('generated.txt', 'heal\\n');\n",
    });

    try {
      await expect(
        runXrayTestImplementation(
          baseImplementationArgs(repo, {
            branch: "tests/proj-1-verify-passes",
            healAgentCommand: "node heal.cjs",
          }),
          () => undefined,
        ),
      ).rejects.toThrow(/Missing Azure DevOps token|Could not resolve Azure DevOps repository/);

      expect(existsSync(join(repo.path, "out/PROJ-1/xray-test-healing-attempt-1.md"))).toBe(false);
      expect(await readFile(join(repo.path, "generated.txt"), "utf8")).toBe("implementation\n");
    } finally {
      await repo.cleanup();
    }
  }, 20000);

  it("runs healing once when verification fails, then continues after verification passes", async () => {
    const repo = await createImplementationRepo({
      verifyScript: "process.exit(require('node:fs').readFileSync('generated.txt', 'utf8').includes('heal') ? 0 : 1);\n",
      healScript: "require('node:fs').appendFileSync('generated.txt', 'heal\\n');\n",
    });

    try {
      await expect(
        runXrayTestImplementation(
          baseImplementationArgs(repo, {
            branch: "tests/proj-1-heal-passes",
            healAgentCommand: "node heal.cjs",
          }),
          () => undefined,
        ),
      ).rejects.toThrow(/Missing Azure DevOps token|Could not resolve Azure DevOps repository/);

      expect(existsSync(join(repo.path, "out/PROJ-1/xray-test-healing-attempt-1.md"))).toBe(true);
      expect(await readFile(join(repo.path, "generated.txt"), "utf8")).toBe("implementation\nheal\n");
      expect(gitOutput(repo.path, ["ls-files", "out/PROJ-1/xray-test-healing-attempt-1.md"])).toBe("");
    } finally {
      await repo.cleanup();
    }
  }, 20000);

  it("runs healing attempts and writes a failed pack when verification keeps failing", async () => {
    const repo = await createImplementationRepo({
      verifyScript: "process.exit(1);\n",
      healScript: "require('node:fs').appendFileSync('generated.txt', 'heal\\n');\n",
    });

    try {
      await expect(
        runXrayTestImplementation(
          baseImplementationArgs(repo, {
            branch: "tests/proj-1-heal-fails",
            healAttempts: 4,
            healAgentCommand: "node heal.cjs",
          }),
          () => undefined,
        ),
      ).rejects.toThrow("Verification failed after 4 healing attempt(s)");

      const implementation = JSON.parse(await readFile(join(repo.path, "out/PROJ-1/xray-test-implementation.json"), "utf8"));
      expect(implementation.implementation.status).toBe("failed");
      expect(implementation.implementation.healingAttempts).toHaveLength(4);
      expect(await readFile(join(repo.path, "generated.txt"), "utf8")).toBe("implementation\nheal\nheal\nheal\nheal\n");
    } finally {
      await repo.cleanup();
    }
  }, 20000);

  it("does not run healing when noHeal is true", async () => {
    const repo = await createImplementationRepo({
      verifyScript: "process.exit(1);\n",
      healScript: "require('node:fs').appendFileSync('generated.txt', 'heal\\n');\n",
    });

    try {
      await expect(
        runXrayTestImplementation(
          baseImplementationArgs(repo, {
            branch: "tests/proj-1-no-heal",
            noHeal: true,
          }),
          () => undefined,
        ),
      ).rejects.toThrow("Verification failed after 0 healing attempt(s)");

      const implementation = JSON.parse(await readFile(join(repo.path, "out/PROJ-1/xray-test-implementation.json"), "utf8"));
      expect(implementation.implementation.status).toBe("failed");
      expect(implementation.implementation.healingAttempts).toBeUndefined();
      expect(await readFile(join(repo.path, "generated.txt"), "utf8")).toBe("implementation\n");
    } finally {
      await repo.cleanup();
    }
  });

  it("uses the configured heal agent command instead of the implementation command", async () => {
    const repo = await createImplementationRepo({
      verifyScript: "process.exit(1);\n",
      healScript: "require('node:fs').appendFileSync('generated.txt', 'custom-heal\\n');\n",
    });

    try {
      await expect(
        runXrayTestImplementation(
          baseImplementationArgs(repo, {
            branch: "tests/proj-1-custom-heal",
            healAttempts: 1,
            healAgentCommand: "node heal.cjs",
          }),
          () => undefined,
        ),
      ).rejects.toThrow("Verification failed after 1 healing attempt(s)");

      expect(await readFile(join(repo.path, "generated.txt"), "utf8")).toBe("implementation\ncustom-heal\n");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("resolveImplementationAgentRunners", () => {
  it("parses branch reuse opt-in", () => {
    const args = parseXrayTestImplementationArgs(["--issue", "PROJ-1", "--reuse-branch-if-possible"]);

    expect(args.reuseBranchIfPossible).toBe(true);
  });

  it("parses generic implementation agent overrides", () => {
    const args = parseXrayTestImplementationArgs([
      "--issue",
      "PROJ-1",
      "--agent-path",
      "agent",
      "--agent-arguments",
      "-p",
    ]);

    expect(args.agentPath).toBe("agent");
    expect(args.agentArguments).toBe("-p");
  });

  it("parses test design mode from both supported option names", () => {
    expect(parseXrayTestImplementationArgs(["--issue", "PROJ-1", "--TestDesignEnabled", "true"]).testDesignEnabled).toBe(true);
    expect(parseXrayTestImplementationArgs(["--issue", "PROJ-1", "--test-design-enabled", "false"]).testDesignEnabled).toBe(false);
  });

  it("rejects invalid test design mode values", () => {
    expect(() => parseXrayTestImplementationArgs(["--issue", "PROJ-1", "--TestDesignEnabled", "maybe"]))
      .toThrow("--TestDesignEnabled must be true or false");
  });

  it("uses the Codex SDK runner when LLM_PROVIDER is openai", () => {
    withTemporaryImplementationCommandEnv(() => {
      process.env.LLM_PROVIDER = "openai";
      process.env.MANSO_TEST_IMPLEMENTATION_COMMAND = "";
      const agents = resolveImplementationAgentRunners(parsedImplementationArgs(), undefined);

      expect(agents.implementation.kind).toBe("codex-sdk");
      expect(agents.implementation.provider).toBe("openai");
      expect(agents.healing).toBe(agents.implementation);
    });
  });

  it("uses the Claude SDK runner when LLM_PROVIDER is anthropic", () => {
    withTemporaryImplementationCommandEnv(() => {
      process.env.LLM_PROVIDER = "anthropic";
      const agents = resolveImplementationAgentRunners(parsedImplementationArgs(), undefined);

      expect(agents.implementation.kind).toBe("claude-sdk");
      expect(agents.implementation.provider).toBe("anthropic");
      expect(agents.healing).toBe(agents.implementation);
    });
  });

  it("defaults to the Codex SDK runner when no explicit implementation command is configured", () => {
    withTemporaryImplementationCommandEnv(() => {
      const agents = resolveImplementationAgentRunners(parsedImplementationArgs(), undefined);

      expect(agents.implementation.kind).toBe("codex-sdk");
      expect(agents.implementation.provider).toBe("openai");
    });
  });

  it("keeps explicit implementation and healing commands", () => {
    withTemporaryImplementationCommandEnv(() => {
      const commands = resolveImplementationCommands(parsedImplementationArgs({
        agentCommand: "custom-implement -",
        healAgentCommand: "custom-heal -",
      }));

      expect(commands.agentCommand).toBe("custom-implement -");
      expect(commands.healAgentCommand).toBe("custom-heal -");
    });
  });

  it("allows overriding the Codex SDK executable path", () => {
    withTemporaryImplementationCommandEnv(() => {
      process.env.LLM_PROVIDER = "openai";
      const agents = resolveImplementationAgentRunners(parsedImplementationArgs({
        agentPath: "C:/Tools/Codex/codex.exe",
      }), undefined);

      expect(agents.implementation.kind).toBe("codex-sdk");
    });
  });

  it("allows overriding the Claude SDK executable path", () => {
    withTemporaryImplementationCommandEnv(() => {
      process.env.LLM_PROVIDER = "anthropic";
      const agents = resolveImplementationAgentRunners(parsedImplementationArgs({
        agentPath: "C:/Tools/Claude Code/claude.exe",
      }), undefined);

      expect(agents.implementation.kind).toBe("claude-sdk");
    });
  });

  it("rejects legacy agent arguments for SDK runners", () => {
    withTemporaryImplementationCommandEnv(() => {
      process.env.LLM_PROVIDER = "openai";

      expect(() => resolveImplementationAgentRunners(parsedImplementationArgs({
        agentArguments: "exec --sandbox workspace-write -",
      }), undefined)).toThrow("--agent-arguments is only supported with --agent-command");
    });
  });
});

describe("agentUsageSpanAttributes", () => {
  it("maps SDK usage to Phoenix llm token and workflow attributes", () => {
    const attributes = agentUsageSpanAttributes(
      {
        command: "codex-sdk",
        exitCode: 0,
        durationMs: 10,
        usage: {
          provider: "openai",
          model: "gpt-5.5",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationInputTokens: 5,
          outputTokens: 25,
          reasoningOutputTokens: 8,
          totalCostUsd: 0.123,
        },
      },
      {
        issueKey: "PROJ-1",
        repoRoot: "/repo",
        prompt: "implement",
        env: {},
        phase: "implementation",
      },
      {
        kind: "codex-sdk",
        provider: "openai",
        model: "gpt-5.5",
        commandLabel: "codex-sdk",
        run: async () => ({ command: "codex-sdk", exitCode: 0, durationMs: 1 }),
      },
    );

    expect(attributes).toMatchObject({
      "llm.provider": "openai",
      "llm.model_name": "gpt-5.5",
      "llm.token_count.prompt": 100,
      "llm.token_count.completion": 25,
      "llm.token_count.cached_input": 40,
      "llm.token_count.cache_creation_input": 5,
      "llm.token_count.reasoning_output": 8,
      "llm.cost.total_usd": 0.123,
      "workflow.issue": "PROJ-1",
      "workflow.phase": "implementation",
    });
  });
});

describe("checkoutImplementationBranch", () => {
  it("reuses an existing remote implementation branch when requested", async () => {
    const repo = await createImplementationRepo({
      verifyScript: "process.exit(0);\n",
      healScript: "",
    });

    try {
      runGit(repo.path, ["checkout", "-b", "tests/proj-1-reuse", "main"]);
      await writeFile(join(repo.path, "existing-implementation.txt"), "existing\n");
      runGit(repo.path, ["add", "existing-implementation.txt"]);
      runGit(repo.path, ["commit", "-m", "existing implementation"]);
      runGit(repo.path, ["push", "-u", "origin", "tests/proj-1-reuse"]);
      runGit(repo.path, ["checkout", "main"]);

      const tools: ToolProvenance[] = [];
      const result = await checkoutImplementationBranch({
        repoRoot: repo.path,
        branch: "tests/proj-1-reuse",
        targetBranch: "main",
        reuseBranchIfPossible: true,
        tools,
        logProgress: () => undefined,
      });

      expect(result.reusedExistingBranch).toBe(true);
      expect(gitOutput(repo.path, ["branch", "--show-current"])).toBe("tests/proj-1-reuse");
      expect(await readFile(join(repo.path, "existing-implementation.txt"), "utf8")).toBe("existing\n");
      expect(tools.map((tool) => tool.method)).toContain("checkoutExistingImplementationBranch");
    } finally {
      await repo.cleanup();
    }
  }, 20000);
});

describe("parseGitChangedFiles", () => {
  it("extracts changed paths from porcelain status including renames", () => {
    expect(
      parseGitChangedFiles([" M src/foo.ts", "A  test/new.spec.ts", "R  old-name.ts -> new-name.ts", "?? .manso/out.md"].join("\n")),
    ).toEqual(["src/foo.ts", "test/new.spec.ts", "new-name.ts", ".manso/out.md"]);
  });
});

describe("AzureDevOpsPullRequestCreator", () => {
  it("finds an active pull request for source and target branches", async () => {
    const requests: URL[] = [];
    const creator = new AzureDevOpsPullRequestCreator(new AzureDevOpsClient({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        return new Response(JSON.stringify({
          value: [
            {
              pullRequestId: 41,
              sourceRefName: "refs/heads/tests/other-implementation",
              targetRefName: "refs/heads/main",
              title: "Other PR",
            },
            {
              pullRequestId: 42,
              sourceRefName: "refs/heads/tests/proj-1-implementation",
              targetRefName: "refs/heads/main",
              title: "PROJ-1 implementation",
            },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }));

    const pullRequest = await creator.findActive({
      repository: {
        organization: "acme",
        project: "Checkout",
        repository: "target-tests",
      },
      sourceBranch: "tests/proj-1-implementation",
      targetBranch: "main",
    });

    expect(pullRequest).toEqual({
      id: 42,
      url: "https://dev.azure.com/acme/Checkout/_git/target-tests/pullrequest/42",
      title: "PROJ-1 implementation",
      sourceBranch: "tests/proj-1-implementation",
      targetBranch: "main",
    });
    expect(requests[0]?.searchParams.get("searchCriteria.status")).toBe("active");
    expect(requests[0]?.searchParams.get("searchCriteria.sourceRefName")).toBeNull();
    expect(requests[0]?.searchParams.get("searchCriteria.targetRefName")).toBe("refs/heads/main");
  });

  it("finds an active pull request using a suffixed implementation branch for branch reuse", async () => {
    const creator = new AzureDevOpsPullRequestCreator(new AzureDevOpsClient({
      token: "token",
      fetchFn: async () => new Response(JSON.stringify({
        value: [
          {
            pullRequestId: 42,
            sourceRefName: "refs/heads/tests/proj-1-implementation-717094-1",
            targetRefName: "refs/heads/main",
            title: "PROJ-1 implementation",
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }));

    const pullRequest = await creator.findActiveForBranchReuse({
      repository: {
        organization: "acme",
        project: "Checkout",
        repository: "target-tests",
      },
      sourceBranch: "tests/proj-1-implementation",
      targetBranch: "main",
      issueKey: "PROJ-1",
    });

    expect(pullRequest?.id).toBe(42);
    expect(pullRequest?.sourceBranch).toBe("tests/proj-1-implementation-717094-1");
  });
});

describe("resolveAzureDevOpsRepository", () => {
  it("parses Azure DevOps https and ssh remotes", () => {
    expect(resolveAzureDevOpsRepositoryFromRemote("https://dev.azure.com/acme/My%20Project/_git/payments")).toEqual({
      organization: "acme",
      project: "My Project",
      repository: "payments",
    });

    expect(resolveAzureDevOpsRepositoryFromRemote("git@ssh.dev.azure.com:v3/acme/My%20Project/payments.git")).toEqual({
      organization: "acme",
      project: "My Project",
      repository: "payments",
    });
  });

  it("uses Azure Pipelines environment variables when available", () => {
    expect(
      resolveAzureDevOpsRepositoryFromEnvironment({
        SYSTEM_COLLECTIONURI: "https://dev.azure.com/acme/",
        SYSTEM_TEAMPROJECT: "Checkout",
        BUILD_REPOSITORY_ID: "repo-id-1",
      }),
    ).toEqual({
      organization: "acme",
      project: "Checkout",
      repository: "repo-id-1",
    });
  });
});

function generationPack(): XrayTestGenerationPack {
  return {
    schemaVersion: "1.0.0",
    ticket: {
      key: "PROJ-1",
      title: "Checkout validation",
    },
    plan: {
      strategySummary: "Automate invalid-card coverage.",
      coverageGaps: ["Invalid-card rejection is missing."],
      testCases: [
        {
          action: "create",
          title: "Invalid card is rejected",
          objective: "Verify invalid card handling.",
          priority: "high",
          coverageAreas: ["checkout validation"],
          preconditions: ["Checkout is available."],
          steps: [{ action: "Submit an invalid card", expectedResult: "The payment is rejected." }],
          sourceEvidence: [{ source: "jira", reference: "PROJ-1", summary: "Ticket requires invalid card rejection." }],
          riskCovered: "validation",
          readiness: "ready",
          openQuestions: [],
          rationale: "No existing test covers invalid card rejection.",
        },
        {
          action: "keep",
          existingTestKey: "TEST-1",
          title: "Existing happy path",
          objective: "Existing coverage remains valid.",
          priority: "medium",
          coverageAreas: ["checkout"],
          preconditions: [],
          steps: [],
          sourceEvidence: [{ source: "xray-review", reference: "TEST-1", summary: "Existing test covers valid checkout." }],
          riskCovered: "regression",
          readiness: "ready",
          openQuestions: [],
          rationale: "Already covered.",
        },
        {
          action: "deprecate",
          existingTestKey: "TEST-2",
          title: "Legacy approval path is deprecated",
          objective: "Mark the old approval behavior as obsolete because it no longer matches the ticket acceptance criteria.",
          priority: "medium",
          coverageAreas: ["checkout"],
          preconditions: [],
          steps: [],
          sourceEvidence: [{ source: "xray-review", reference: "TEST-2", summary: "Existing test validates behavior that is no longer accepted." }],
          riskCovered: "obsolete regression coverage",
          readiness: "ready",
          openQuestions: [],
          rationale: "The linked Xray test conflicts with the current acceptance criteria and should not remain active.",
        },
      ],
    },
    application: {
      status: "dry-run",
      tests: [],
      testSet: {
        status: "dry-run",
        title: "PROJ-1 Generated Test Set - Checkout validation",
        includedTestKeys: [],
        includedTestIssueIds: [],
        warnings: [],
      },
    },
    provenance: {
      generatedAt: "2026-05-02T12:00:00.000Z",
      sourceContextPath: "out/PROJ-1/context.json",
      llm: {
        provider: "test",
        model: "test-model",
      },
      tools: [],
    },
    warnings: [],
  };
}

interface ImplementationRepo {
  path: string;
  generationPath: string;
  cleanup: () => Promise<void>;
}

interface ImplementationRepoOptions {
  verifyScript: string;
  healScript: string;
}

async function createImplementationRepo(options: ImplementationRepoOptions): Promise<ImplementationRepo> {
  const root = await mkdtemp(join(tmpdir(), "manso-impl-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await mkdir(repo);
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.invalid"]);
  runGit(repo, ["config", "user.name", "Test Runner"]);

  await writeFile(join(repo, "guidance.md"), "Use generated tests only.\n");
  await writeFile(join(repo, "implement.cjs"), "require('node:fs').writeFileSync('generated.txt', 'implementation\\n');\n");
  await writeFile(join(repo, "heal.cjs"), options.healScript);
  await writeFile(join(repo, "verify.cjs"), options.verifyScript);
  await mkdir(join(repo, "out/PROJ-1"), { recursive: true });
  const generationPath = join(repo, "out/PROJ-1/xray-test-generation.json");
  await writeFile(generationPath, JSON.stringify(generationPack(), null, 2));

  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "initial"]);
  runGit(root, ["init", "--bare", remote]);
  runGit(repo, ["remote", "add", "origin", remote]);
  runGit(repo, ["push", "-u", "origin", "main"]);

  return {
    path: repo,
    generationPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function baseImplementationArgs(repo: ImplementationRepo, overrides: Partial<Parameters<typeof runXrayTestImplementation>[0]> = {}): Parameters<typeof runXrayTestImplementation>[0] {
  return {
    issue: "PROJ-1",
    outDir: join(repo.path, "out"),
    xrayTestGenerationPath: repo.generationPath,
    repoRoot: repo.path,
    guidancePaths: ["guidance.md"],
    agentCommand: "node implement.cjs",
    verifyCommand: "node verify.cjs",
    branch: "tests/proj-1-implementation",
    targetBranch: "main",
    promptOnly: false,
    dryRun: false,
    allowDirty: false,
    reuseBranchIfPossible: false,
    healAttempts: 4,
    noHeal: false,
    help: false,
    ...overrides,
  };
}

function parsedImplementationArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    outDir: "./out",
    repoRoot: ".",
    guidancePaths: [],
    healAttempts: 4,
    noHeal: false,
    promptOnly: false,
    dryRun: false,
    allowDirty: false,
    reuseBranchIfPossible: false,
    help: false,
    ...overrides,
  };
}

function withTemporaryImplementationCommandEnv(run: () => void): void {
  const originalLlmProvider = process.env.LLM_PROVIDER;
  const originalImplementationCommand = process.env.MANSO_TEST_IMPLEMENTATION_COMMAND;
  const originalAgentPath = process.env.MANSO_TEST_IMPLEMENTATION_AGENT_PATH;
  const originalAgentArguments = process.env.MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS;
  try {
    delete process.env.LLM_PROVIDER;
    delete process.env.MANSO_TEST_IMPLEMENTATION_COMMAND;
    delete process.env.MANSO_TEST_IMPLEMENTATION_AGENT_PATH;
    delete process.env.MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS;
    run();
  } finally {
    restoreEnvValue("LLM_PROVIDER", originalLlmProvider);
    restoreEnvValue("MANSO_TEST_IMPLEMENTATION_COMMAND", originalImplementationCommand);
    restoreEnvValue("MANSO_TEST_IMPLEMENTATION_AGENT_PATH", originalAgentPath);
    restoreEnvValue("MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS", originalAgentArguments);
  }
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function runGit(cwd: string, args: string[]): void {
  gitOutput(cwd, args);
}

function gitOutput(cwd: string, args: string[]): string {
  const git = process.platform === "win32" && existsSync("C:\\Program Files\\Git\\cmd\\git.exe")
    ? "C:\\Program Files\\Git\\cmd\\git.exe"
    : "git";
  return execFileSync(git, args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
}
