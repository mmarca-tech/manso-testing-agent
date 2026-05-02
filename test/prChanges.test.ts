import { describe, expect, it } from "vitest";
import type { ContextPack, PullRequest, ToolProvenance, Warning } from "../src/domain/contextPack/schema.js";
import type { PullRequestDiff, PullRequestUnderstanding } from "../src/domain/prChanges/schema.js";
import { PrChangesPackSchema } from "../src/domain/prChanges/schema.js";
import { AzureDevOpsClient } from "../src/integrations/azureDevOps/client.js";
import { AzureDevOpsPullRequestDiffSource } from "../src/integrations/azureDevOps/pullRequestDiffSource.js";
import { renderPrChangesMarkdown } from "../src/output/pr-changes/renderer.js";
import { extractPrChanges } from "../src/workflows/pr-changes/extractor.js";
import type { PrDiffSource } from "../src/workflows/pr-changes/prDiffSource.js";
import type { PullRequestSummarizer, PullRequestSummaryInput } from "../src/workflows/pr-changes/summarizer.js";

describe("extractPrChanges", () => {
  it("creates a validated PR changes pack with LLM understanding", async () => {
    const pack = await extractPrChanges(contextPack(), new FakeDiffSource(), new FakeSummarizer(), {
      sourceContextPath: "out/PROJ-1/context.json",
    });

    expect(PrChangesPackSchema.parse(pack)).toEqual(pack);
    expect(pack.pullRequests).toEqual([
      expect.objectContaining({
        title: "Implement checkout validation",
        diff: expect.objectContaining({
          provider: "azure-devops",
          files: [expect.objectContaining({ path: "/src/checkout.ts", changeType: "edit" })],
        }),
        understanding: expect.objectContaining({
          summary: "Updates checkout validation and its provider mapping.",
          changeAreas: ["checkout validation"],
        }),
      }),
    ]);
    expect(renderPrChangesMarkdown(pack)).toContain("## Pull Requests");
  });
});

describe("AzureDevOpsPullRequestDiffSource", () => {
  it("fetches PR details, commits, iterations, and latest iteration changes", async () => {
    const calls: string[] = [];
    const source = new AzureDevOpsPullRequestDiffSource(
      new AzureDevOpsClient({
        token: "token",
        fetchFn: async (input) => {
          const url = String(input);
          calls.push(url);

          if (url.includes("/pullrequests/42?")) {
            return jsonResponse({ title: "PR title" });
          }

          if (url.includes("/pullRequests/42/commits?")) {
            return jsonResponse({
              value: [
                {
                  commitId: "abcdef123456",
                  comment: "Change validation",
                  author: { name: "Dev", date: "2026-05-01T10:00:00.000Z" },
                  remoteUrl: "https://dev.azure.com/org/project/_git/repo/commit/abcdef123456",
                },
              ],
            });
          }

          if (url.includes("/pullRequests/42/iterations?")) {
            return jsonResponse({ value: [{ id: 1 }, { id: 2 }] });
          }

          if (url.includes("/pullRequests/42/iterations/2/changes?")) {
            return jsonResponse({
              allChangesIncluded: true,
              changeCounts: { Edit: 1 },
              changeEntries: [
                {
                  changeType: "edit",
                  item: { path: "/src/checkout.ts", isFolder: false, url: "https://dev.azure.com/item" },
                },
              ],
            });
          }

          if (url.includes("/items?") && url.includes("path=%2Fsrc%2Fcheckout.ts")) {
            return new Response("export function validateCheckout() { return true; }", {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "text/plain" },
            });
          }

          return jsonResponse({}, 404, "Not Found");
        },
      }),
    );

    const diff = await source.getPullRequestDiff({
      title: "PR title",
      url: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
    });

    expect(diff).toEqual(
      expect.objectContaining({
        provider: "azure-devops",
        changeCounts: { Edit: 1 },
        files: [expect.objectContaining({ path: "/src/checkout.ts", changeType: "edit" })],
        sourceFiles: [expect.objectContaining({ path: "/src/checkout.ts", role: "changed", language: "typescript" })],
        commits: [expect.objectContaining({ id: "abcdef123456", comment: "Change validation" })],
        allChangesIncluded: true,
      }),
    );
    expect(calls.some((url) => url.includes("/iterations/2/changes?"))).toBe(true);
    expect(source.getProvenance().every((item) => item.success)).toBe(true);
  });

  it("fetches bounded changed source files without language-specific related-file expansion", async () => {
    const calls: string[] = [];
    const source = new AzureDevOpsPullRequestDiffSource(
      new AzureDevOpsClient({
        token: "token",
        fetchFn: async (input) => {
          const url = String(input);
          calls.push(url);

          if (url.includes("/pullrequests/43?")) {
            return jsonResponse({ title: "PR title", lastMergeSourceCommit: { commitId: "head-sha" } });
          }

          if (url.includes("/pullRequests/43/commits?")) {
            return jsonResponse({ value: [] });
          }

          if (url.includes("/pullRequests/43/iterations?")) {
            return jsonResponse({ value: [{ id: 1 }] });
          }

          if (url.includes("/pullRequests/43/iterations/1/changes?")) {
            return jsonResponse({
              changeCounts: { Edit: 1 },
              changeEntries: [
                {
                  changeType: "edit",
                  item: { path: "/src/checkout_validation.py", isFolder: false },
                },
              ],
            });
          }

          if (url.includes("/items?") && url.includes("path=%2Fsrc%2Fcheckout_validation.py")) {
            return textResponse(`
def validate_checkout(card_number: str) -> bool:
    return len(card_number) > 0`);
          }

          return jsonResponse({}, 404, "Not Found");
        },
      }),
    );

    const diff = await source.getPullRequestDiff({
      title: "PR title",
      url: "https://dev.azure.com/org/project/_git/repo/pullrequest/43",
    });

    expect(diff.sourceFiles.map((file) => ({ path: file.path, role: file.role }))).toEqual([
      { path: "/src/checkout_validation.py", role: "changed" },
    ]);
    expect(diff.sourceFiles[0]?.language).toBe("python");
    expect(calls.some((url) => url.includes("recursionLevel=full"))).toBe(false);
    expect(source.getWarnings()).toEqual([]);
  });
});

class FakeDiffSource implements PrDiffSource {
  async getPullRequestDiff(): Promise<PullRequestDiff> {
    return {
      provider: "azure-devops",
      files: [{ path: "/src/checkout.ts", changeType: "edit" }],
      sourceFiles: [
        {
          path: "/src/checkout.ts",
          role: "changed",
          changeType: "edit",
          language: "typescript",
          content: "export function validateCheckout() { return true; }",
          truncated: false,
          reason: "Changed in the pull request.",
        },
      ],
      commits: [{ id: "abcdef123456", comment: "Change validation" }],
      changeCounts: { Edit: 1 },
      allChangesIncluded: true,
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "getPullRequestDiff", toolName: "azure-devops:test", calledAt: "2026-05-02T12:00:00.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

class FakeSummarizer implements PullRequestSummarizer {
  readonly provider = "test-llm";
  readonly model = "test-model";

  async summarize(input: PullRequestSummaryInput): Promise<PullRequestUnderstanding> {
    expect(input.context.ticket.key).toBe("PROJ-1");
    return {
      summary: "Updates checkout validation and its provider mapping.",
      changeAreas: ["checkout validation"],
      risks: ["provider mapping regression"],
      testingNotes: ["Verify validation rejects invalid cards."],
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "summarizePullRequest", toolName: "llm:test", calledAt: "2026-05-02T12:00:01.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

function contextPack(): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: {
      key: "PROJ-1",
      title: "Checkout validation",
      labels: [],
      components: [],
      links: [],
    },
    description: {
      format: "text",
      text: "Checkout should reject invalid cards.",
    },
    comments: [],
    attachments: [],
    xrayTestCases: [{ key: "TEST-1", title: "Invalid card is rejected", labels: [] }],
    development: {
      branches: [],
      pullRequests: [
        {
          title: "Implement checkout validation",
          status: "MERGED",
          url: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
          repository: "repo",
          sourceBranch: "feature/PROJ-1",
          targetBranch: "main",
        },
      ],
    },
    confluencePages: [],
    provenance: {
      generatedAt: "2026-05-02T12:00:00.000Z",
      issueKey: "PROJ-1",
      source: "jira-rest",
      tools: [],
    },
    warnings: [],
  };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/plain" },
  });
}
