import type { ToolProvenance, Warning } from "../../../domain/contextPack/schema.js";
import { ConfluenceImpactSchema } from "../../../domain/confluenceImpact/schema.js";
import type { ConfluenceImpact } from "../../../domain/confluenceImpact/schema.js";
import type { ConfluenceImpactInput, ConfluenceImpactSummarizer } from "../../../workflows/confluence-impact/summarizer.js";
import { juanaSystemPrompt } from "./juanaPersona.js";
import { parseJsonObject } from "../json.js";
import type { LlmTextClient } from "../types.js";

export interface LlmConfluenceImpactSummarizerOptions {
  client: LlmTextClient;
}

export class LlmConfluenceImpactSummarizer implements ConfluenceImpactSummarizer {
  private readonly client: LlmTextClient;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: LlmConfluenceImpactSummarizerOptions) {
    this.client = options.client;
  }

  get provider(): string {
    return this.client.provider;
  }

  get model(): string {
    return this.client.model;
  }

  async summarize(input: ConfluenceImpactInput): Promise<ConfluenceImpact> {
    const calledAt = new Date().toISOString();

    try {
      const text = await this.client.generateText({
        operation: "summarizeConfluenceImpact",
        systemPrompt: juanaSystemPrompt(
          "Map explicitly linked Confluence page content to its impact on a Jira ticket. Use only the provided JSON. Return strict JSON with summary, ticketRelevance, impactedAreas, decisionsOrConstraints, risks, and testingNotes. Use Confluence only when the supplied page is clearly relevant to the ticket; otherwise state the relevance is weak or unclear.",
        ),
        userPrompt: buildPrompt(input),
      });
      const parsed = parseJsonObject(text);
      this.provenance.push({ method: "summarizeConfluenceImpact", toolName: this.client.toolName, calledAt, success: true });
      return ConfluenceImpactSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "summarizeConfluenceImpact", toolName: this.client.toolName, calledAt, success: false, message });
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

function buildPrompt(input: ConfluenceImpactInput): string {
  const payload = {
    ticket: {
      key: input.context.ticket.key,
      title: input.context.ticket.title,
      description: input.context.description.text.slice(0, 5000),
      existingTests: input.context.xrayTestCases.map((test) => ({
        key: test.key,
        title: test.title,
        status: test.status,
      })),
      pullRequests: input.context.development.pullRequests.map((pullRequest) => ({
        title: pullRequest.title,
        status: pullRequest.status,
        repository: pullRequest.repository,
        sourceBranch: pullRequest.sourceBranch,
        url: pullRequest.url,
      })),
    },
    confluencePage: {
      id: input.page.id,
      title: input.page.title,
      space: input.page.space,
      url: input.page.url,
      updatedAt: input.page.updatedAt,
      body: input.page.body?.slice(0, 12000) ?? "",
    },
  };

  return `Map this Confluence page to the Jira ticket impact in JSON.

Required JSON shape:
{
  "summary": "one or two concise sentences about the page",
  "ticketRelevance": "how this page relates to the Jira ticket",
  "impactedAreas": ["business, workflow, integration, data, or testing area affected"],
  "decisionsOrConstraints": ["decision, dependency, constraint, assumption, or scope rule from the page"],
  "risks": ["risk or ambiguity the ticket/implementation should consider"],
  "testingNotes": ["what downstream test-gap analysis should verify"]
}

Rules:
- Separate explicit page facts from inferences about ticket impact.
- Do not expand scope beyond this linked page and the supplied Jira context.
- Put missing or ambiguous information in risks or testingNotes.

Input:
${JSON.stringify(payload, null, 2)}`;
}
