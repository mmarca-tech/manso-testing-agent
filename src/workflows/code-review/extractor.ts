import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import { CODE_REVIEW_SCHEMA_VERSION, CodeReviewPackSchema } from "../../domain/codeReview/schema.js";
import type { CodeReviewPack, CodeReviewPullRequest, CodeReviewResult } from "../../domain/codeReview/schema.js";
import type { ContextPack } from "../../domain/contextPack/schema.js";
import type { PullRequestDiff } from "../../domain/prChanges/schema.js";
import type { PullRequestCodeReviewer } from "./reviewer.js";

export async function extractCodeReview(
  pullRequest: CodeReviewPullRequest,
  ticket: ContextPack | undefined,
  diff: PullRequestDiff,
  reviewer: PullRequestCodeReviewer,
  options: { detectedTicketKey?: string; warnings?: Warning[]; tools?: ToolProvenance[] } = {},
): Promise<CodeReviewPack> {
  const warnings: Warning[] = [...(options.warnings ?? [])];
  const review = await reviewPullRequest(pullRequest, ticket, diff, reviewer, warnings);

  const pack: CodeReviewPack = {
    schemaVersion: CODE_REVIEW_SCHEMA_VERSION,
    pullRequest,
    ...(ticket ? { ticket } : {}),
    ...(options.detectedTicketKey ? { detectedTicketKey: options.detectedTicketKey } : {}),
    diff,
    review,
    provenance: {
      generatedAt: new Date().toISOString(),
      llm: {
        provider: reviewer.provider,
        model: reviewer.model,
      },
      tools: [...(options.tools ?? []), ...reviewer.getProvenance()],
    },
    warnings: [...warnings, ...reviewer.getWarnings()],
  };

  return CodeReviewPackSchema.parse(pack);
}

async function reviewPullRequest(
  pullRequest: CodeReviewPullRequest,
  ticket: ContextPack | undefined,
  diff: PullRequestDiff,
  reviewer: PullRequestCodeReviewer,
  warnings: Warning[],
): Promise<CodeReviewResult> {
  try {
    return await reviewer.review({ pullRequest, ...(ticket ? { ticket } : {}), diff });
  } catch (error) {
    warnings.push({
      section: "llm",
      message: `Could not review pull request ${pullRequest.url}: ${errorMessage(error)}`,
    });
    return {
      summary: "Automated code review was unavailable.",
      businessImpact: "Unknown.",
      technicalAssessment: "Unknown.",
      approvalRecommendation: "needs-human-review",
      findings: [],
      questions: ["Automated review failed. Please complete a manual review."],
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
