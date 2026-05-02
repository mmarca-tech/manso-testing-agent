import type { ContextPack, PullRequest, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { PullRequestDiff, PullRequestUnderstanding } from "../../domain/prChanges/schema.js";

export interface PullRequestSummarizer {
  readonly provider: string;
  readonly model: string;
  summarize(input: PullRequestSummaryInput): Promise<PullRequestUnderstanding>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}

export interface PullRequestSummaryInput {
  context: Pick<ContextPack, "ticket" | "description" | "xrayTestCases">;
  pullRequest: PullRequest;
  diff: PullRequestDiff;
}
