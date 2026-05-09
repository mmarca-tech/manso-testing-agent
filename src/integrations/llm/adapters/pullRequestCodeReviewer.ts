import type { ToolProvenance, Warning } from "../../../domain/contextPack/schema.js";
import { CodeReviewResultSchema } from "../../../domain/codeReview/schema.js";
import type { CodeReviewResult } from "../../../domain/codeReview/schema.js";
import type { CodeReviewInput, PullRequestCodeReviewer } from "../../../workflows/code-review/reviewer.js";
import { juanaSystemPrompt } from "./juanaPersona.js";
import { parseJsonObject } from "../json.js";
import type { LlmTextClient } from "../types.js";

export interface LlmPullRequestCodeReviewerOptions {
  client: LlmTextClient;
}

export class LlmPullRequestCodeReviewer implements PullRequestCodeReviewer {
  private readonly client: LlmTextClient;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: LlmPullRequestCodeReviewerOptions) {
    this.client = options.client;
  }

  get provider(): string {
    return this.client.provider;
  }

  get model(): string {
    return this.client.model;
  }

  async review(input: CodeReviewInput): Promise<CodeReviewResult> {
    const calledAt = new Date().toISOString();

    try {
      const text = await this.client.generateText({
        operation: "reviewPullRequest",
        systemPrompt: juanaSystemPrompt(
          "Review an Azure DevOps pull request using Jira ticket context and diff evidence. Return strict JSON with summary, businessImpact, technicalAssessment, approvalRecommendation, findings, and questions. Focus on actionable technical defects and business requirement mismatches. Use only supplied evidence; do not invent changed behavior. Be concise and avoid style-only comments unless they hide a real risk.",
        ),
        userPrompt: buildPrompt(input),
      });
      const parsed = parseJsonObject(text);
      this.provenance.push({ method: "reviewPullRequest", toolName: this.client.toolName, calledAt, success: true });
      return CodeReviewResultSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "reviewPullRequest", toolName: this.client.toolName, calledAt, success: false, message });
      throw error;
    }
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }
}

function buildPrompt(input: CodeReviewInput): string {
  const payload = {
    pullRequest: input.pullRequest,
    ticket: input.ticket
      ? {
          key: input.ticket.ticket.key,
          title: input.ticket.ticket.title,
          issueType: input.ticket.ticket.issueType,
          status: input.ticket.ticket.status,
          labels: input.ticket.ticket.labels,
          components: input.ticket.ticket.components,
          description: trimText(input.ticket.description.text, 8000),
          recentComments: input.ticket.comments.slice(-8).map((comment) => ({
            author: comment.author?.name ?? comment.author?.email,
            createdAt: comment.createdAt,
            body: trimText(comment.body, 1500),
          })),
          confluencePages: input.ticket.confluencePages.slice(0, 8).map((page) => ({
            title: page.title,
            body: trimText(page.body ?? "", 5000),
          })),
        }
      : undefined,
    diff: {
      provider: input.diff.provider,
      changeCounts: input.diff.changeCounts,
      allChangesIncluded: input.diff.allChangesIncluded,
      files: input.diff.files.slice(0, 250),
      sourceFiles: input.diff.sourceFiles.slice(0, 30).map((file) => ({
        path: file.path,
        role: file.role,
        changeType: file.changeType,
        language: file.language,
        truncated: file.truncated,
        reason: file.reason,
        content: trimText(file.content, 20000),
      })),
      commits: input.diff.commits.slice(0, 80).map((commit) => ({
        id: commit.id,
        comment: commit.comment,
        author: commit.author?.name,
        authoredAt: commit.authoredAt,
      })),
    },
  };

  return `Review this pull request and return JSON.

Required JSON shape:
{
  "summary": "short review summary",
  "businessImpact": "how well the PR appears to satisfy the Jira ticket or where it may diverge",
  "technicalAssessment": "technical review summary",
  "approvalRecommendation": "approve | approve-with-comments | changes-requested | needs-human-review",
  "findings": [
    {
      "title": "concise issue title",
      "severity": "blocker | high | medium | low | info",
      "category": "technical | business",
      "details": "specific concern and why it matters",
      "recommendation": "specific fix or review action",
      "evidence": ["file, snippet, Jira requirement, or diff clue"],
      "filePath": "optional changed file path",
      "line": 123
    }
  ],
  "questions": ["question for the author or reviewer"]
}

Rules:
- Prefer no finding over a weak or speculative finding.
- Technical findings should identify likely bugs, missing error handling, unsafe data handling, incorrect tests, deployment risk, or maintainability risks that matter.
- Business findings should identify likely mismatch with Jira description, comments, acceptance criteria, or linked Confluence content.
- If ticket context is missing or weak, say so in questions or needs-human-review.
- Use filePath only when the source file evidence clearly supports the finding. Use line only when obvious from the snippet.
- Return JSON only, without Markdown fences.

Input:
${JSON.stringify(payload, null, 2)}`;
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n[... truncated ...]`;
}
