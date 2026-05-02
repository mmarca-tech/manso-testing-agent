import type { PullRequest, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { PullRequestDiff } from "../../domain/prChanges/schema.js";

export interface PrDiffSource {
  getPullRequestDiff(pullRequest: PullRequest): Promise<PullRequestDiff>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
