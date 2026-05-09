import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { ContextPack } from "../../domain/contextPack/schema.js";
import type { CodeReviewPullRequest, CodeReviewResult } from "../../domain/codeReview/schema.js";
import type { PullRequestDiff } from "../../domain/prChanges/schema.js";

export interface CodeReviewInput {
  pullRequest: CodeReviewPullRequest;
  ticket?: ContextPack;
  diff: PullRequestDiff;
}

export interface PullRequestCodeReviewer {
  readonly provider: string;
  readonly model: string;
  review(input: CodeReviewInput): Promise<CodeReviewResult>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
