import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReviewPullRequest, type ReviewPullRequestInput } from "../src/cli/reviewPullRequest.js";
import { parseAgentConfig } from "../src/config/agentConfig.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import type { LlmTextClient } from "../src/integrations/llm/types.js";
import type { VcsAdapter, VcsPullRequest } from "../src/integrations/vcs/adapter.js";
import { readDayCost, appendRunCost } from "../src/policy/costLedger.js";
import command from "../src/cli/reviewPullRequest.js";
import { runCli } from "../src/cli/main.js";
import { runResearcher } from "../src/agents/researcher/index.js";
import { buildPullRequestReviewRequest } from "../src/agents/pullRequestReviewer/index.js";

const locatedFinding = {
  title: "Incorrect return value", severity: "high", category: "technical",
  details: "The changed return value is incorrect.", recommendation: "Return the required value.",
  evidence: ["+new"], filePath: "file.ts", line: 1,
};

const review = {
  summary: "The PR implements the requirement.",
  businessImpact: "Matches the ticket.", technicalAssessment: "No defects found.",
  approvalRecommendation: "approve", findings: [], questions: [],
};
const pr: VcsPullRequest = {
  id: 42, title: "QATG-3369: review capability", sourceBranch: "feature/QATG-3369",
  targetBranch: "main", sourceCommit: "head", targetCommit: "base", url: "https://example.test/pr/42",
};
const patch = "@@ -1 +1 @@\n-old\n+new";
function provider(): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => ({
      ticket: { key, title: "Proactive review", labels: [], components: [], links: [] },
      description: { format: "text", text: "Review PRs against requirements." },
      comments: [], linkedIssues: [],
    }),
    getComments: async () => [], getAttachments: async () => [], getLinkedIssues: async () => [],
    getDevelopmentLinks: async () => ({ branches: [], pullRequests: [] }),
    getConfluencePages: async () => [], getProvenance: () => [], getWarnings: () => [], close: async () => undefined,
  };
}
function policy(budgets: { maxCostPerRunUsd?: number; maxCostPerDayUsd?: number } = {}) {
  return parseAgentConfig({
    schemaVersion: "1.0.0", product: "test",
    policy: {
      budgets,
      redactPatterns: ["PRIVATE_VALUE"],
    },
  }, "test").policy;
}

describe("proactive review workflow", () => {
  let outDir: string;
  let adapter: VcsAdapter;
  let llm: LlmTextClient;
  // The client meters usage itself (like the real clients); the verb reads it back.
  const totals = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const meter = (usage: { inputTokens: number; outputTokens: number }) => {
    totals.calls += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
  };
  beforeEach(async () => {
    Object.assign(totals, { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    vi.stubEnv("MANSO_MODEL_PRICES", JSON.stringify({ test: { input: 1, output: 2 } }));
    outDir = await mkdtemp(join(tmpdir(), "manso-review-"));
    adapter = {
      kind: "azure-devops", raisePullRequest: vi.fn(),
      getPullRequest: vi.fn(async () => pr),
      getPullRequestDiff: vi.fn(async () => ({
        files: [{ path: "file.ts", changeType: "edit" as const, patch }], hasPatches: true, allChangesIncluded: true,
      })),
      postPullRequestComment: vi.fn(async () => ({ status: "posted" as const, threadId: 1 })),
    };
    llm = {
      provider: "openai", model: "test", toolName: "test:llm",
      getAccumulatedUsage: () => ({ ...totals }),
      generateText: vi.fn(async (request) => {
        meter({ inputTokens: 100, outputTokens: 50 });
        return JSON.stringify(review);
      }),
    };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(outDir, { recursive: true, force: true });
  });
  const input = (overrides: Partial<ReviewPullRequestInput> = {}): ReviewPullRequestInput => ({
    pullRequestId: 42, outDir, adapter, llm, provider: provider(), policy: policy(), ...overrides,
  });

  it("detects Jira context, writes both reports, posts exactly one top-level comment and records governance", async () => {
    const result = await runReviewPullRequest(input());
    expect(result.pack.detectedTicketKey).toBe("QATG-3369");
    expect(result.pack.review.approvalRecommendation).toBe("approve");
    expect(result.commentPosted).toBe(true);
    expect(result.failed).toBe(false);
    expect(adapter.postPullRequestComment).toHaveBeenCalledTimes(1);
    expect(adapter.postPullRequestComment).toHaveBeenCalledWith({
      pullRequestId: 42, content: expect.stringContaining("## Manso Code Review"),
    });
    expect(JSON.parse(await readFile(result.jsonPath, "utf8")).schemaVersion).toBe("1.0.0");
    expect(await readFile(result.markdownPath, "utf8")).toContain("### Business Review");
    expect(await readDayCost(join(outDir, "cost-ledger.jsonl"))).toBe(0.0002);
    const audit = (await readFile(join(outDir, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.map((entry) => entry.action)).toEqual([
      "run.started", "pr.reviewed", "pr.review-comment-requested", "pr.review-commented", "run.completed",
    ]);
    expect(adapter.raisePullRequest).not.toHaveBeenCalled();
  });

  describe("re-running on a PR that already has Manso comments", () => {
    const BOT = "bot-account";
    const findings = [
      locatedFinding,
      { title: "Requirement question", severity: "low", category: "business", details: "Please confirm requirements.",
        recommendation: "Clarify the ticket.", evidence: ["ticket"] },
    ];
    /** An in-memory PR: whatever is posted or updated is what the next run reads back. */
    function statefulAdapter() {
      const threads: Array<{ id: number; comments: Array<{ id: number; content: string; authorId?: string }> }> = [];
      const post = vi.fn(async (request: { content: string }) => {
        const id = threads.length + 1;
        threads.push({ id, comments: [{ id: 1, authorId: BOT, content: request.content }] });
        return { status: "posted" as const, threadId: id, commentId: 1 };
      });
      const update = vi.fn(async (request: { threadId: number; commentId: number; content: string }) => {
        threads.find((thread) => thread.id === request.threadId)!.comments.find((c) => c.id === request.commentId)!.content = request.content;
        return { status: "posted" as const, threadId: request.threadId, commentId: request.commentId };
      });
      Object.assign(adapter, {
        postPullRequestComment: post,
        updatePullRequestComment: update,
        getAuthenticatedUserId: vi.fn(async () => BOT),
        listPullRequestThreads: vi.fn(async () => threads.map((thread) => ({ id: thread.id, comments: thread.comments.map((c) => ({ ...c })) }))),
      });
      return { post, update, threads };
    }
    const respondWith = (summary: string) => {
      llm.generateText = vi.fn(async (request) => {
        meter({ inputTokens: 100, outputTokens: 50 });
        return JSON.stringify({ ...review, summary, findings });
      });
    };

    it("posts nothing new when the findings and summary are unchanged", async () => {
      const { post, update, threads } = statefulAdapter();
      respondWith("Same result.");
      const first = await runReviewPullRequest(input());
      expect(first.inlineCommentsPosted).toBe(1);
      expect(post).toHaveBeenCalledTimes(2);
      post.mockClear();
      const second = await runReviewPullRequest(input());
      expect(second.inlineCommentsPosted).toBe(0);
      expect(second.inlineCommentsSkipped).toBe(1);
      expect(second.commentPosted).toBe(true);
      expect(post).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(threads).toHaveLength(2);
    });

    it("updates the earlier summary in place instead of opening another thread", async () => {
      const { post, update, threads } = statefulAdapter();
      respondWith("First result.");
      await runReviewPullRequest(input());
      post.mockClear();
      respondWith("Second result after another push.");
      await runReviewPullRequest(input());
      expect(post).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledOnce();
      expect(threads).toHaveLength(2);
      expect(threads[1]!.comments[0]!.content).toContain("Second result after another push.");
      expect(threads[1]!.comments[0]!.content).not.toContain("First result.");
    });

    it("posts a new finding but not the ones already on the PR", async () => {
      const { post } = statefulAdapter();
      respondWith("Result.");
      await runReviewPullRequest(input());
      post.mockClear();
      llm.generateText = vi.fn(async (request) => {
        meter({ inputTokens: 100, outputTokens: 50 });
        return JSON.stringify({ ...review, findings: [locatedFinding, { ...locatedFinding, title: "Another defect" }] });
      });
      const result = await runReviewPullRequest(input());
      expect(result.inlineCommentsPosted).toBe(1);
      expect(result.inlineCommentsSkipped).toBe(1);
      expect(post).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Another defect") }));
    });

    it("posts a finding only once when the model returns it twice in one response", async () => {
      const { post } = statefulAdapter();
      llm.generateText = vi.fn(async () => {
        meter({ inputTokens: 100, outputTokens: 50 });
        return JSON.stringify({ ...review, findings: [locatedFinding, { ...locatedFinding }] });
      });
      const result = await runReviewPullRequest(input());
      expect(result.inlineCommentsPosted).toBe(1);
      expect(result.inlineCommentsSkipped).toBe(1);
      expect(post.mock.calls.filter(([request]) => "inline" in request)).toHaveLength(1);
    });

    it("does not trust markers copied into someone else's comments", async () => {
      const { post, update, threads } = statefulAdapter();
      respondWith("Result.");
      await runReviewPullRequest(input());
      // A PR participant copies Manso's markers into their own comments.
      for (const thread of threads) for (const comment of thread.comments) comment.authorId = "someone-else";
      post.mockClear();
      const result = await runReviewPullRequest(input());
      expect(result.inlineCommentsSkipped).toBe(0);
      expect(update).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(2); // the inline finding and a new summary, not suppressed
    });

    it("posts without deduplicating when the posting identity cannot be determined", async () => {
      const { post, update } = statefulAdapter();
      (adapter.getAuthenticatedUserId as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      respondWith("Result.");
      await runReviewPullRequest(input());
      post.mockClear();
      const result = await runReviewPullRequest(input());
      expect(result.inlineCommentsSkipped).toBe(0);
      expect(update).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(2);
    });

    it("does not post when existing threads cannot be read, to avoid duplicates", async () => {
      const { post } = statefulAdapter();
      (adapter.listPullRequestThreads as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
      respondWith("Result.");
      await expect(runReviewPullRequest(input())).rejects.toThrow("not posting to avoid duplicate comments");
      expect(post).not.toHaveBeenCalled();
    });
  });

  it.each([{ noComment: true }, { dryRun: true }])("does not mutate PRs with %j", async (guard) => {
    const result = await runReviewPullRequest(input(guard));
    expect(result.commentPosted).toBe(false);
    expect(llm.generateText).toHaveBeenCalledOnce();
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
  });

  it("posts located findings inline and retains unlocated findings in exactly one summary", async () => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({
        ...review, findings: [locatedFinding, { ...locatedFinding, title: "Removed guard", side: "left" },
          { title: "Requirement question", severity: "low", category: "business", details: "Please confirm requirements.",
            recommendation: "Clarify the ticket.", evidence: ["ticket"] }],
      });
    });
    const result = await runReviewPullRequest(input());
    expect(result.inlineCommentsPosted).toBe(2);
    expect(result.commentPosted).toBe(true);
    expect(adapter.postPullRequestComment).toHaveBeenCalledTimes(3);
    expect(adapter.postPullRequestComment).toHaveBeenNthCalledWith(1, {
      pullRequestId: 42, content: expect.stringContaining("Incorrect return value"),
      inline: { path: "file.ts", line: 1, side: "right", sourceCommit: "head" },
    });
    expect(adapter.postPullRequestComment).toHaveBeenNthCalledWith(2, {
      pullRequestId: 42, content: expect.stringContaining("Removed guard"),
      inline: { path: "file.ts", line: 1, side: "left", sourceCommit: "head" },
    });
    expect(adapter.postPullRequestComment).toHaveBeenNthCalledWith(3, {
      pullRequestId: 42, content: expect.stringContaining("Requirement question"),
    });
    expect(adapter.postPullRequestComment).toHaveBeenLastCalledWith({
      pullRequestId: 42, content: expect.not.stringContaining("Incorrect return value"),
    });
    const report = await readFile(result.markdownPath, "utf8");
    expect(report).toContain("Incorrect return value");
    expect(report).toContain("Removed guard");
    expect(report).toContain("Requirement question");
    expect(report).toContain("file.ts:1 (left)");
    const audit = (await readFile(join(outDir, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.filter((entry) => entry.action === "pr.review-commented").map((entry) => entry.detail.kind)).toEqual(["inline", "inline", "summary"]);
  });

  it.each([{ noComment: true }, { dryRun: true }])("suppresses both inline and summary writes for %j", async (guard) => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({ ...review, findings: [locatedFinding] });
    });
    const result = await runReviewPullRequest(input(guard));
    expect(result.inlineCommentsPosted).toBe(0);
    expect(result.commentPosted).toBe(false);
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
    expect(result.pack.review.findings).toHaveLength(1);
  });

  it("retains a file-only finding in the summary instead of guessing an inline line", async () => {
    const { line: _line, ...fileOnly } = locatedFinding;
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({ ...review, findings: [fileOnly] });
    });
    const result = await runReviewPullRequest(input());
    expect(result.inlineCommentsPosted).toBe(0);
    expect(adapter.postPullRequestComment).toHaveBeenCalledExactlyOnceWith({
      pullRequestId: 42, content: expect.stringContaining("Incorrect return value"),
    });
  });

  it("does not invent an inline commit when the reviewed commit is unavailable", async () => {
    const { sourceCommit: _sourceCommit, ...withoutCommit } = pr;
    adapter.getPullRequest = vi.fn(async () => withoutCommit);
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({ ...review, findings: [locatedFinding] });
    });
    const result = await runReviewPullRequest(input());
    expect(result.inlineCommentsPosted).toBe(0);
    expect(result.pack.warnings.join(" ")).toContain("source commit is unavailable");
    expect(adapter.postPullRequestComment).toHaveBeenCalledExactlyOnceWith({
      pullRequestId: 42, content: expect.stringContaining("Incorrect return value"),
    });
  });

  it("redacts inline finding content before posting", async () => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({ ...review, findings: [{ ...locatedFinding, details: "PRIVATE_VALUE mail@example.com" }] });
    });
    await runReviewPullRequest(input());
    expect(adapter.postPullRequestComment).toHaveBeenNthCalledWith(1, {
      pullRequestId: 42, inline: { path: "file.ts", line: 1, side: "right", sourceCommit: "head" },
      content: expect.stringContaining("[REDACTED] [REDACTED]"),
    });
  });

  it("stops and reports partial inline posting rather than claiming success", async () => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({ ...review, findings: [locatedFinding, { ...locatedFinding, title: "Second finding" }] });
    });
    let posts = 0;
    adapter.postPullRequestComment = vi.fn(async () => posts++ === 0
      ? { status: "posted" as const, threadId: 1 }
      : { status: "failed" as const, message: "API rejected line" });
    await expect(runReviewPullRequest(input())).rejects.toThrow("after 1 successful inline comment");
    expect(adapter.postPullRequestComment).toHaveBeenCalledTimes(2);
    const audit = await readFile(join(outDir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"kind":"inline"');
    expect(audit).toContain('"failed":true');
  });

  it("rechecks commits before each inline comment and stops when the PR changes", async () => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({ ...review, findings: [locatedFinding, { ...locatedFinding, title: "Second finding" }] });
    });
    let reads = 0;
    adapter.getPullRequest = vi.fn(async () => ({ ...pr, sourceCommit: reads++ < 3 ? "head" : "updated" }));
    await expect(runReviewPullRequest(input())).rejects.toThrow("stopped after 1 inline");
    expect(adapter.postPullRequestComment).toHaveBeenCalledOnce();
  });

  it("suppresses inline findings as well as the summary when cost exceeds budget", async () => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 2_000_000, outputTokens: 0 });
      return JSON.stringify({ ...review, findings: [locatedFinding] });
    });
    const result = await runReviewPullRequest(input({ policy: policy({ maxCostPerRunUsd: 1 }) }));
    expect(result.failed).toBe(true);
    expect(result.inlineCommentsPosted).toBe(0);
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
  });

  it("uses an explicit issue key before branch detection", async () => {
    const result = await runReviewPullRequest(input({ issueKey: "ABC-123" }));
    expect(result.pack.ticket?.ticket.key).toBe("ABC-123");
  });

  it("reviews technical evidence without a Jira key, but never claims approval", async () => {
    adapter.getPullRequest = vi.fn(async () => ({ ...pr, title: "Fix logic", sourceBranch: "fix/logic" }));
    const withoutProvider = input();
    delete withoutProvider.provider;
    const result = await runReviewPullRequest(withoutProvider);
    expect(result.pack.review.approvalRecommendation).toBe("needs-human-review");
    expect(result.pack.warnings.join(" ")).toContain("No Jira ticket context");
  });

  it("requires Jira credentials if a key is detected, before paying for review", async () => {
    const withoutProvider = input();
    delete withoutProvider.provider;
    await expect(runReviewPullRequest(withoutProvider)).rejects.toThrow("Jira credentials");
    expect(llm.generateText).not.toHaveBeenCalled();
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
  });

  it("redacts nested context, prompts, reports and posted output with standard and custom rules", async () => {
    const source = provider();
    source.getIssue = async (key) => ({
      ticket: { key, title: "PRIVATE_VALUE", labels: [], components: [], links: [] },
      description: { format: "text", text: "mail@example.com PRIVATE_VALUE sk-12345678901234567890" },
      comments: [], linkedIssues: [],
    });
    llm.generateText = vi.fn(async (request) => {
      expect(request.userPrompt).not.toMatch(/mail@example.com|PRIVATE_VALUE|sk-12345678901234567890/);
      meter({ inputTokens: 100, outputTokens: 50 });
      return JSON.stringify({ ...review, summary: "PRIVATE_VALUE mail@example.com" });
    });
    const result = await runReviewPullRequest(input({ provider: source }));
    expect(await readFile(result.jsonPath, "utf8")).not.toMatch(/mail@example.com|PRIVATE_VALUE|sk-12345678901234567890/);
    expect(await readFile(result.markdownPath, "utf8")).toContain("[REDACTED]");
    expect(adapter.postPullRequestComment).toHaveBeenCalledWith(expect.objectContaining({ content: expect.not.stringContaining("PRIVATE_VALUE") }));
  });

  it.each(["run", "day"])("halts before the LLM request when the reserved %s cost exceeds budget", async (scope) => {
    if (scope === "day") await appendRunCost(join(outDir, "cost-ledger.jsonl"), { runCostUsd: 1 });
    await expect(runReviewPullRequest(input({
      policy: policy(scope === "day" ? { maxCostPerDayUsd: 1 } : { maxCostPerRunUsd: 0 }),
    }))).rejects.toThrow("before the LLM");
    expect(llm.generateText).not.toHaveBeenCalled();
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
    expect(await readFile(join(outDir, "audit.jsonl"), "utf8")).toContain("budget.breached");
  });

  it("prices the run with the shared model price table, including the cached-input rate", async () => {
    vi.stubEnv("MANSO_MODEL_PRICES", JSON.stringify({ test: { input: 1, cachedInput: 0.1, output: 2 } }));
    llm.generateText = vi.fn(async () => {
      meter({ inputTokens: 1_000_000, outputTokens: 0 });
      totals.cachedInputTokens += 1_000_000;
      return JSON.stringify(review);
    });
    const result = await runReviewPullRequest(input());
    expect(result.pack.provenance.runCostUsd).toBe(0.1);
    expect(await readDayCost(join(outDir, "cost-ledger.jsonl"))).toBe(0.1);
  });

  it("only charges the usage of this run when the client was already used", async () => {
    meter({ inputTokens: 5_000_000, outputTokens: 5_000_000 });
    const result = await runReviewPullRequest(input());
    expect(result.pack.provenance.runCostUsd).toBe(0.0002);
  });

  it("fails closed when a configured budget has no pricing", async () => {
    const configured = policy({ maxCostPerRunUsd: 1 });
    vi.stubEnv("MANSO_MODEL_PRICES", JSON.stringify({ unrelated: { input: 1, output: 2 } }));
    await expect(runReviewPullRequest(input({ policy: configured }))).rejects.toThrow("unknown LLM cost");
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it("allows a reservation exactly at both configured budget thresholds", async () => {
    const context = await runResearcher({ issueKey: "QATG-3369", provider: provider(), attachmentUnderstanding: false });
    const request = buildPullRequestReviewRequest({
      pullRequest: pr, ticket: context,
      diff: { files: [{ path: "file.ts", changeType: "edit", patch }], hasPatches: true, allChangesIncluded: true },
      redactPatterns: ["PRIVATE_VALUE"],
    }).request;
    const limit = (Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.userPrompt) + 1024 + 4000 * 2) / 1_000_000;
    const result = await runReviewPullRequest(input({ policy: policy({ maxCostPerRunUsd: limit, maxCostPerDayUsd: limit }) }));
    expect(result.failed).toBe(false);
    expect(result.commentPosted).toBe(true);
  });

  it("fails closed on missing usage even when the model returns an otherwise valid review", async () => {
    llm.generateText = vi.fn(async () => JSON.stringify(review));
    const result = await runReviewPullRequest(input());
    expect(result.failed).toBe(true);
    expect(result.pack.review.approvalRecommendation).toBe("needs-human-review");
    expect(result.pack.provenance.runCostUsd).toBeGreaterThan(0);
    expect(result.pack.warnings.join(" ")).toContain("Measured token usage unavailable");
  });

  it("suppresses comment if measured cost exceeds the budget", async () => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 2_000_000, outputTokens: 0 });
      return JSON.stringify(review);
    });
    const result = await runReviewPullRequest(input({ policy: policy({ maxCostPerRunUsd: 1 }) }));
    expect(result.failed).toBe(true);
    expect(result.pack.provenance.runCostUsd).toBe(2);
    expect(result.pack.review.approvalRecommendation).toBe("needs-human-review");
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
  });

  it("records paid usage even when model output is malformed", async () => {
    llm.generateText = vi.fn(async (request) => {
      meter({ inputTokens: 100, outputTokens: 50 });
      return "not JSON";
    });
    const result = await runReviewPullRequest(input());
    expect(result.failed).toBe(true);
    expect(result.pack.review.approvalRecommendation).toBe("needs-human-review");
    expect(result.pack.review.findings).toEqual([]);
    expect(await readDayCost(join(outDir, "cost-ledger.jsonl"))).toBe(0.0002);
  });

  it("reports LLM failure and accounts the reservation instead of pretending success", async () => {
    llm.generateText = vi.fn(async () => { throw new Error("provider unavailable PRIVATE_VALUE"); });
    const result = await runReviewPullRequest(input());
    expect(result.failed).toBe(true);
    expect(result.pack.warnings.join(" ")).toContain("provider unavailable [REDACTED]");
    expect(result.pack.provenance.runCostUsd).toBeGreaterThan(0);
    expect(result.pack.review.approvalRecommendation).toBe("needs-human-review");
  });

  it("forces manual review for missing patches", async () => {
    adapter.getPullRequestDiff = vi.fn(async () => ({
      files: [{ path: "file.ts", changeType: "edit" as const }], hasPatches: false, allChangesIncluded: true,
    }));
    const result = await runReviewPullRequest(input());
    expect(result.pack.review.approvalRecommendation).toBe("needs-human-review");
    expect(result.pack.warnings.join(" ")).toContain("Incomplete patch");
  });

  it("suppresses stale-commit comments", async () => {
    let reads = 0;
    adapter.getPullRequest = vi.fn(async () => ({ ...pr, sourceCommit: reads++ === 0 ? "head" : "new-head" }));
    const result = await runReviewPullRequest(input());
    expect(result.failed).toBe(true);
    expect(result.pack.review.approvalRecommendation).toBe("needs-human-review");
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
  });

  it("surfaces posting failures without returning success", async () => {
    adapter.postPullRequestComment = vi.fn(async () => ({ status: "failed" as const, message: "API forbidden" }));
    await expect(runReviewPullRequest(input())).rejects.toThrow("API forbidden");
  });

  it("refuses a corrupt ledger and never spends", async () => {
    await writeFile(join(outDir, "cost-ledger.jsonl"), "broken\n");
    await expect(runReviewPullRequest(input())).rejects.toThrow();
    expect(llm.generateText).not.toHaveBeenCalled();
    expect(adapter.postPullRequestComment).not.toHaveBeenCalled();
  });

  it("refuses a concurrent review without deleting its lock", async () => {
    const lock = join(outDir, "cost-ledger.jsonl.review.lock");
    await writeFile(lock, "other review");
    await expect(runReviewPullRequest(input())).rejects.toThrow("locked");
    expect(await readFile(lock, "utf8")).toBe("other review");
  });

  it("takes over a lock left behind by a crashed run, with a warning, and releases it afterwards", async () => {
    const lock = join(outDir, "cost-ledger.jsonl.review.lock");
    await writeFile(lock, JSON.stringify({ pid: 424242, host: "other-host", startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }));
    const result = await runReviewPullRequest(input());
    expect(result.commentPosted).toBe(true);
    expect(result.pack.review.approvalRecommendation).toBe("approve");
    expect(result.pack.warnings.some((warning) => warning.includes("abandoned review lock"))).toBe(true);
    await expect(readFile(lock, "utf8")).rejects.toThrow();
  });

  it("does not call the LLM if audit logging cannot be persisted", async () => {
    const path = join(outDir, "blocked-audit");
    await writeFile(path, "not a directory");
    vi.stubEnv("MANSO_AUDIT_LOG", join(path, "audit.jsonl"));
    await expect(runReviewPullRequest(input())).rejects.toThrow();
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it("dispatches help without config or network calls", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runCli(["review-pull-request", "--help"])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--no-comment"));
  });

  it.each(["1junk", "0", "-1", "1.2", "9007199254740992"])("rejects invalid PR id %s", async (id) => {
    await expect(command.run([`--pr=${id}`])).rejects.toThrow("positive safe integer");
  });

  it("rejects an invalid issue override before reading configuration", async () => {
    await expect(command.run(["--pr", "42", "--issue", "../invalid"])).rejects.toThrow("Jira issue key");
  });
});
