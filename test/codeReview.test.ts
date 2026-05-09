import { describe, expect, it } from "vitest";
import { CodeReviewPackSchema } from "../src/domain/codeReview/schema.js";
import type { CodeReviewPullRequest, CodeReviewResult } from "../src/domain/codeReview/schema.js";
import type { ContextPack, ToolProvenance, Warning } from "../src/domain/contextPack/schema.js";
import type { PullRequestDiff } from "../src/domain/prChanges/schema.js";
import { AzureDevOpsClient } from "../src/integrations/azureDevOps/client.js";
import {
  AzureDevOpsPullRequestCommentSink,
  AzureDevOpsPullRequestReviewSource,
} from "../src/integrations/azureDevOps/pullRequestReview.js";
import { renderCodeReviewComment, renderCodeReviewMarkdown } from "../src/output/code-review/renderer.js";
import { extractCodeReview } from "../src/workflows/code-review/extractor.js";
import type { CodeReviewInput, PullRequestCodeReviewer } from "../src/workflows/code-review/reviewer.js";
import { detectJiraIssueKey, detectJiraIssueKeyInText } from "../src/workflows/code-review/ticketDetection.js";

describe("ticket detection", () => {
  it("finds the first Jira key from branch, title, or description", () => {
    expect(detectJiraIssueKey(["feature/pay-123-checkout", "PAY-456 title"])).toBe("PAY-123");
    expect(detectJiraIssueKey(["feature/no-ticket", "Implement PAY-456 checkout validation"])).toBe("PAY-456");
    expect(detectJiraIssueKey(["feature/no-ticket", "No issue here"])).toBeUndefined();
  });

  it("does not include adjacent key-like text", () => {
    expect(detectJiraIssueKeyInText("fix PAY-123ABC")).toBeUndefined();
    expect(detectJiraIssueKeyInText("fix/PAY-123_checkout")).toBe("PAY-123");
  });
});

describe("extractCodeReview", () => {
  it("creates a validated review pack and renders markdown/comment output", async () => {
    const pack = await extractCodeReview(pullRequest(), contextPack(), diff(), new FakeReviewer(), {
      detectedTicketKey: "PAY-1",
      tools: [{ method: "getIssue", toolName: "jira:test", calledAt: "2026-05-02T12:00:00.000Z", success: true }],
      warnings: [{ section: "pullRequests", message: "Diff was truncated." }],
    });

    expect(CodeReviewPackSchema.parse(pack)).toEqual(pack);
    expect(pack.review.approvalRecommendation).toBe("changes-requested");
    expect(pack.review.findings).toEqual([
      expect.objectContaining({
        category: "business",
        filePath: "/src/checkout.ts",
        title: "Expired card reason is not visible",
      }),
    ]);

    const markdown = renderCodeReviewMarkdown(pack);
    expect(markdown).toContain("## Business Review");
    expect(markdown).toContain("Expired card reason is not visible");

    const comment = renderCodeReviewComment(pack);
    expect(comment).toContain("## Manso Code Review");
    expect(comment).toContain("**Recommendation:** changes-requested");
  });
});

describe("AzureDevOpsPullRequestReviewSource", () => {
  it("loads PR metadata and posts a review thread", async () => {
    let postedBody: unknown;
    let postedUrl = "";
    const client = new AzureDevOpsClient({
      token: "token",
      fetchFn: async (input, init) => {
        const url = String(input);

        if (init?.method === "GET" && url.includes("/pullrequests/42?")) {
          return jsonResponse({
            title: "Implement checkout validation",
            description: "PAY-1 acceptance criteria",
            sourceRefName: "refs/heads/feature/PAY-1-checkout",
            targetRefName: "refs/heads/main",
            repository: { name: "payments-api" },
          });
        }

        if (init?.method === "POST" && url.includes("/pullRequests/42/threads?")) {
          postedUrl = url;
          postedBody = JSON.parse(String(init.body));
          return jsonResponse({ id: 7 });
        }

        return jsonResponse({}, 404, "Not Found");
      },
    });
    const ref = {
      repository: { organization: "org", project: "project", repository: "repo" },
      pullRequestId: 42,
    };

    const source = new AzureDevOpsPullRequestReviewSource(client);
    const pullRequest = await source.getPullRequest(ref);

    expect(pullRequest).toEqual(
      expect.objectContaining({
        id: 42,
        title: "Implement checkout validation",
        sourceBranch: "feature/PAY-1-checkout",
        targetBranch: "main",
        repository: "payments-api",
        url: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
      }),
    );

    const sink = new AzureDevOpsPullRequestCommentSink(client);
    await sink.createThread(ref, "## Manso Code Review\n\nLooks good.");

    expect(postedUrl).toContain("/pullRequests/42/threads?");
    expect(postedBody).toEqual({
      comments: [{ parentCommentId: 0, content: "## Manso Code Review\n\nLooks good.", commentType: 1 }],
      status: "active",
    });
    expect(source.getProvenance().every((item) => item.success)).toBe(true);
    expect(sink.getProvenance().every((item) => item.success)).toBe(true);
  });
});

class FakeReviewer implements PullRequestCodeReviewer {
  readonly provider = "test-llm";
  readonly model = "test-model";

  async review(input: CodeReviewInput): Promise<CodeReviewResult> {
    expect(input.ticket?.ticket.key).toBe("PAY-1");
    expect(input.diff.files[0]?.path).toBe("/src/checkout.ts");

    return {
      summary: "The PR mostly implements checkout validation but misses the customer-visible decline reason.",
      businessImpact: "PAY-1 asks for a clear expired-card decline reason, which is not visible in the changed code.",
      technicalAssessment: "The changed validator detects expiry but returns only a boolean result.",
      approvalRecommendation: "changes-requested",
      findings: [
        {
          title: "Expired card reason is not visible",
          severity: "high",
          category: "business",
          details: "The ticket asks for a visible expired-card decline reason, but the changed function only returns false.",
          recommendation: "Return or surface a specific expired-card reason so the UI can show the required message.",
          evidence: ["PAY-1 description", "/src/checkout.ts returns false for expired cards"],
          filePath: "/src/checkout.ts",
          line: 2,
        },
      ],
      questions: ["Should declined payments expose a reason enum or localized message key?"],
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "reviewPullRequest", toolName: "llm:test", calledAt: "2026-05-02T12:00:01.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

function pullRequest(): CodeReviewPullRequest {
  return {
    id: 42,
    title: "Implement checkout validation",
    description: "PAY-1 acceptance criteria",
    sourceBranch: "feature/PAY-1-checkout",
    targetBranch: "main",
    repository: "payments-api",
    project: "project",
    organization: "org",
    url: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
  };
}

function contextPack(): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: {
      key: "PAY-1",
      title: "Expired card validation",
      issueType: "Story",
      status: "In Review",
      labels: ["checkout"],
      components: ["Payments"],
      links: [],
    },
    description: {
      format: "text",
      text: "Checkout should reject expired cards with a clear decline reason.",
    },
    comments: [],
    attachments: [],
    xrayTestCases: [],
    development: {
      branches: [],
      pullRequests: [],
    },
    confluencePages: [
      {
        title: "Checkout Design",
        body: "Expired cards must show a specific customer-facing message.",
      },
    ],
    provenance: {
      generatedAt: "2026-05-02T12:00:00.000Z",
      issueKey: "PAY-1",
      source: "jira-rest",
      tools: [],
    },
    warnings: [],
  };
}

function diff(): PullRequestDiff {
  return {
    provider: "azure-devops",
    files: [{ path: "/src/checkout.ts", changeType: "edit" }],
    sourceFiles: [
      {
        path: "/src/checkout.ts",
        role: "changed",
        changeType: "edit",
        language: "typescript",
        content: "export function validateExpired(card: Card) { return false; }",
        truncated: false,
        reason: "Changed in the pull request.",
      },
    ],
    commits: [{ id: "abcdef123456", comment: "Validate expired cards" }],
    changeCounts: { Edit: 1 },
    allChangesIncluded: true,
  };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}
