import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import { ConfluenceImpactSchema } from "../../domain/confluenceImpact/schema.js";
import type { ConfluenceImpact } from "../../domain/confluenceImpact/schema.js";
import type { ConfluenceImpactInput, ConfluenceImpactSummarizer } from "../../workflows/confluence-impact/summarizer.js";
import { juanaSystemPrompt } from "./juanaPersona.js";
import { extractOutputText, parseJsonObject, postOpenAiResponses } from "./responsesClient.js";

export interface OpenAiConfluenceImpactSummarizerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class OpenAiConfluenceImpactSummarizer implements ConfluenceImpactSummarizer {
  readonly provider = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: OpenAiConfluenceImpactSummarizerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "https://api.openai.com/v1";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async summarize(input: ConfluenceImpactInput): Promise<ConfluenceImpact> {
    const calledAt = new Date().toISOString();

    try {
      const payload = await postOpenAiResponses({
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        fetchFn: this.fetchFn,
        body: {
          model: this.model,
          input: [
            {
              role: "system",
              content: juanaSystemPrompt(
                "Map explicitly linked Confluence page content to its impact on a Jira ticket. Use only the provided JSON. Return strict JSON with summary, ticketRelevance, impactedAreas, decisionsOrConstraints, risks, and testingNotes. Use Confluence only when the supplied page is clearly relevant to the ticket; otherwise state the relevance is weak or unclear.",
              ),
            },
            {
              role: "user",
              content: buildPrompt(input),
            },
          ],
        },
      });
      const text = extractOutputText(payload);
      const parsed = parseJsonObject(text);
      this.provenance.push({ method: "summarizeConfluenceImpact", toolName: "openai:responses", calledAt, success: true });
      return ConfluenceImpactSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "summarizeConfluenceImpact", toolName: "openai:responses", calledAt, success: false, message });
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
