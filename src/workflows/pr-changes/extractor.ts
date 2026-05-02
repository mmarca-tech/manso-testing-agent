import { PR_CHANGES_SCHEMA_VERSION, PrChangesPackSchema } from "../../domain/prChanges/schema.js";
import type { PrChangesPack, PullRequestChangeSummary, PullRequestUnderstanding } from "../../domain/prChanges/schema.js";
import type { ContextPack, PullRequest, Warning } from "../../domain/contextPack/schema.js";
import { uniqueBy } from "../../shared/utils.js";
import type { PrDiffSource } from "./prDiffSource.js";
import type { PullRequestSummarizer } from "./summarizer.js";

interface ExtractPrChangesOptions {
  sourceContextPath: string;
  onProgress?: (message: string) => void;
}

export async function extractPrChanges(
  context: ContextPack,
  diffSource: PrDiffSource,
  summarizer: PullRequestSummarizer,
  options: ExtractPrChangesOptions,
): Promise<PrChangesPack> {
  const warnings: Warning[] = [];
  const pullRequests = uniqueBy(context.development.pullRequests, (pullRequest) => pullRequest.url ?? pullRequest.title);
  const summaries: PullRequestChangeSummary[] = [];

  options.onProgress?.(`Found ${pullRequests.length} unique linked pull request(s).`);
  let index = 0;
  for (const pullRequest of pullRequests) {
    index += 1;
    try {
      options.onProgress?.(`Fetching diff for pull request ${index}/${pullRequests.length}: ${pullRequest.title}.`);
      const diff = await diffSource.getPullRequestDiff(pullRequest);
      options.onProgress?.(`Summarizing pull request ${index}/${pullRequests.length}: ${pullRequest.title}.`);
      const understanding = await summarizePullRequest(context, pullRequest, diff, summarizer, warnings);

      summaries.push({
        ...copyPullRequestMetadata(pullRequest),
        diff,
        understanding,
      });
      options.onProgress?.(`Completed pull request ${index}/${pullRequests.length}: ${pullRequest.title}.`);
    } catch (error) {
      options.onProgress?.(`Could not process pull request ${index}/${pullRequests.length}: ${pullRequest.title}.`);
      warnings.push({
        section: "pullRequests",
        message: `Could not extract PR changes for ${pullRequest.url ?? pullRequest.title}: ${errorMessage(error)}`,
      });
    }
  }

  const pack: PrChangesPack = {
    schemaVersion: PR_CHANGES_SCHEMA_VERSION,
    ticket: {
      key: context.ticket.key,
      title: context.ticket.title,
      ...(context.ticket.url ? { url: context.ticket.url } : {}),
    },
    pullRequests: summaries,
    provenance: {
      generatedAt: new Date().toISOString(),
      sourceContextPath: options.sourceContextPath,
      llm: {
        provider: summarizer.provider,
        model: summarizer.model,
      },
      tools: [...diffSource.getProvenance(), ...summarizer.getProvenance()],
    },
    warnings: [...warnings, ...diffSource.getWarnings(), ...summarizer.getWarnings()],
  };

  return PrChangesPackSchema.parse(pack);
}

async function summarizePullRequest(
  context: ContextPack,
  pullRequest: PullRequest,
  diff: PullRequestChangeSummary["diff"],
  summarizer: PullRequestSummarizer,
  warnings: Warning[],
): Promise<PullRequestUnderstanding> {
  try {
    return await summarizer.summarize({
      context: {
        ticket: context.ticket,
        description: context.description,
        xrayTestCases: context.xrayTestCases,
      },
      pullRequest,
      diff,
    });
  } catch (error) {
    warnings.push({
      section: "llm",
      message: `Could not summarize ${pullRequest.url ?? pullRequest.title}: ${errorMessage(error)}`,
    });

    return {
      summary: "LLM summary unavailable for this pull request.",
      changeAreas: [],
      risks: [],
      testingNotes: [],
    };
  }
}

function copyPullRequestMetadata(pullRequest: PullRequest): Omit<PullRequestChangeSummary, "diff" | "understanding"> {
  return {
    title: pullRequest.title,
    ...(pullRequest.status ? { status: pullRequest.status } : {}),
    ...(pullRequest.url ? { url: pullRequest.url } : {}),
    ...(pullRequest.repository ? { repository: pullRequest.repository } : {}),
    ...(pullRequest.provider ? { provider: pullRequest.provider } : {}),
    ...(pullRequest.sourceBranch ? { sourceBranch: pullRequest.sourceBranch } : {}),
    ...(pullRequest.targetBranch ? { targetBranch: pullRequest.targetBranch } : {}),
    ...(pullRequest.author ? { author: pullRequest.author } : {}),
    ...(pullRequest.lastUpdatedAt ? { lastUpdatedAt: pullRequest.lastUpdatedAt } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
