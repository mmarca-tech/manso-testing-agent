import { describe, expect, it } from "vitest";
import type { XrayTestGenerationPack } from "../src/domain/xrayTestGeneration/schema.js";
import {
  resolveAzureDevOpsRepositoryFromEnvironment,
  resolveAzureDevOpsRepositoryFromRemote,
} from "../src/integrations/azureDevOps/pullRequestCreator.js";
import { parseGitChangedFiles } from "../src/integrations/git/localGit.js";
import { buildXrayTestImplementationPrompt } from "../src/workflows/xray-test-implementation/prompt.js";

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
    expect(prompt).toContain("Actionable create/update cases: 1");
    expect(prompt).toContain("Ready actionable cases: 1");
    expect(prompt).toContain("Manual Xray steps to automate");
    expect(prompt).toContain("Use Playwright for browser workflows.");
    expect(prompt).toContain('"testDirectory": "tests/e2e"');
    expect(prompt).toContain("Requested validation command: npm test");
  });
});

describe("parseGitChangedFiles", () => {
  it("extracts changed paths from porcelain status including renames", () => {
    expect(
      parseGitChangedFiles([" M src/foo.ts", "A  test/new.spec.ts", "R  old-name.ts -> new-name.ts", "?? .manso/out.md"].join("\n")),
    ).toEqual(["src/foo.ts", "test/new.spec.ts", "new-name.ts", ".manso/out.md"]);
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
