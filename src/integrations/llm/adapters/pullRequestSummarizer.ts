import type { ToolProvenance, Warning } from "../../../domain/contextPack/schema.js";
import { PullRequestUnderstandingSchema } from "../../../domain/prChanges/schema.js";
import type { PullRequestUnderstanding } from "../../../domain/prChanges/schema.js";
import type { PullRequestSummarizer, PullRequestSummaryInput } from "../../../workflows/pr-changes/summarizer.js";
import { juanaSystemPrompt } from "./juanaPersona.js";
import { parseJsonObject } from "../json.js";
import type { LlmTextClient } from "../types.js";

export interface LlmPullRequestSummarizerOptions {
  client: LlmTextClient;
}

export class LlmPullRequestSummarizer implements PullRequestSummarizer {
  private readonly client: LlmTextClient;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: LlmPullRequestSummarizerOptions) {
    this.client = options.client;
  }

  get provider(): string {
    return this.client.provider;
  }

  get model(): string {
    return this.client.model;
  }

  async summarize(input: PullRequestSummaryInput): Promise<PullRequestUnderstanding> {
    const calledAt = new Date().toISOString();

    try {
      const text = await this.client.generateText({
        operation: "summarizePullRequest",
        systemPrompt: juanaSystemPrompt(
          "Summarize pull request diffs for a downstream test-gap agent. Use only the provided JSON. Return strict JSON with summary, changeAreas, risks, and testingNotes. Focus on changed behavior, code-path clues, regression risk, and test-relevant evidence. Do not infer requirements that are not supported by the diff or Jira context.",
        ),
        userPrompt: buildPrompt(input),
      });
      const parsed = parseJsonObject(text);
      this.provenance.push({ method: "summarizePullRequest", toolName: this.client.toolName, calledAt, success: true });
      return PullRequestUnderstandingSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "summarizePullRequest", toolName: this.client.toolName, calledAt, success: false, message });
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

function buildPrompt(input: PullRequestSummaryInput): string {
  const payload = {
    ticket: {
      key: input.context.ticket.key,
      title: input.context.ticket.title,
      description: input.context.description.text.slice(0, 4000),
    },
    existingTests: input.context.xrayTestCases.map((test) => ({
      key: test.key,
      title: test.title,
      status: test.status,
    })),
    pullRequest: input.pullRequest,
    diff: {
      provider: input.diff.provider,
      changeCounts: input.diff.changeCounts,
      files: input.diff.files.slice(0, 200),
      sourceFiles: input.diff.sourceFiles.slice(0, 20).map((file) => ({
        path: file.path,
        role: file.role,
        changeType: file.changeType,
        language: file.language,
        truncated: file.truncated,
        reason: file.reason,
        content: file.content.slice(0, 12000),
      })),
      commits: input.diff.commits.slice(0, 50).map((commit) => ({
        id: commit.id,
        comment: commit.comment,
        author: commit.author?.name,
        authoredAt: commit.authoredAt,
      })),
    },
  };

  return `Summarize this pull request in JSON.

Required JSON shape:
{
  "summary": "one or two concise sentences",
  "changeAreas": ["changed behavior or code area"],
  "risks": ["risk or regression concern"],
  "testingNotes": ["what a test-gap agent should pay attention to"]
}

Rules:
- Keep the summary evidence-led and operational.
- Put uncertainty or missing context in risks or testingNotes.
- Prefer concrete changed files, source snippets, behaviors, integrations, or data flows over generic QA language.
- Use sourceFiles as evidence when present; they are capped snippets from changed source files.

Input:
${JSON.stringify(payload, null, 2)}`;
}
