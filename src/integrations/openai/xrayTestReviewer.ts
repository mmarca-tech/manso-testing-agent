import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import { XrayTestReviewAnalysisSchema } from "../../domain/xrayTestReview/schema.js";
import type { XrayTestReviewAnalysis } from "../../domain/xrayTestReview/schema.js";
import type { XrayTestReviewer, XrayTestReviewInput } from "../../workflows/xray-test-review/reviewer.js";
import { juanaSystemPrompt } from "./juanaPersona.js";
import { extractOutputText, parseJsonObject, postOpenAiResponses } from "./responsesClient.js";

export interface OpenAiXrayTestReviewerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class OpenAiXrayTestReviewer implements XrayTestReviewer {
  readonly provider = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: OpenAiXrayTestReviewerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "https://api.openai.com/v1";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async review(input: XrayTestReviewInput): Promise<XrayTestReviewAnalysis> {
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
                "Review linked Xray test cases for a downstream test-generation workflow. Use only the provided JSON. Return strict JSON with overallSummary, coveredAcceptanceCriteria, gapsOrAmbiguities, and testCases. Identify what each test does, what acceptance criteria it covers, what risk it covers, and what cannot be confirmed from the available evidence.",
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
      this.provenance.push({ method: "reviewLinkedXrayTests", toolName: "openai:responses", calledAt, success: true });
      return XrayTestReviewAnalysisSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "reviewLinkedXrayTests", toolName: "openai:responses", calledAt, success: false, message });
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

function buildPrompt(input: XrayTestReviewInput): string {
  const payload = {
    ticket: {
      key: input.context.ticket.key,
      title: input.context.ticket.title,
      status: input.context.ticket.status,
      labels: input.context.ticket.labels,
      components: input.context.ticket.components,
      description: input.context.description.text.slice(0, 8000),
      comments: input.context.comments.slice(0, 30).map((comment) => ({
        author: comment.author?.name,
        createdAt: comment.createdAt,
        body: comment.body.slice(0, 1200),
      })),
    },
    linkedXrayTests: input.context.xrayTestCases.map((test) => ({
      key: test.key,
      title: test.title,
      status: test.status,
      description: test.description,
      labels: test.labels,
      relationship: test.relationship,
      url: test.url,
      xrayDefinition: testDefinitionForKey(input, test.key),
    })),
  };

  return `Review the linked Xray test cases against this Jira ticket.

Rules:
- Include every linkedXrayTests entry exactly once in testCases, preserving its key and title.
- Identify what each test appears to do from its title, description, labels, and relationship.
- Map each test to acceptance criteria or requirement statements from the ticket when there is direct support.
- If an acceptance criterion is inferred rather than explicit, say so in the wording.
- Record gaps or ambiguities instead of inventing missing details.
- updateRecommendation should be "keep" when the existing test appears adequate, "update" when it likely needs material changes for this ticket, and "unclear" when the available details are insufficient.
- Do not create new test cases in this step.
- Keep facts, inferences, and assumptions distinguishable in summary, gapsOrAmbiguities, and rationale.
- Use rationale to state the source evidence and any uncertainty.

Required JSON shape:
{
  "overallSummary": "concise summary of what the linked tests already cover",
  "coveredAcceptanceCriteria": ["acceptance criterion covered by at least one linked test"],
  "gapsOrAmbiguities": ["gap or ambiguity in existing linked test coverage"],
  "testCases": [
    {
      "key": "TEST-123",
      "title": "existing Xray test title",
      "status": "optional status",
      "relationship": "optional relationship",
      "url": "optional URL",
      "summary": "what this test appears to verify",
      "coveredAcceptanceCriteria": ["ticket acceptance criterion this test covers"],
      "coveredBehaviors": ["behavior checked by this test"],
      "testDataOrPreconditions": ["visible setup, data, or precondition"],
      "gapsOrAmbiguities": ["missing detail or doubtful coverage"],
      "updateRecommendation": "keep | update | unclear",
      "rationale": "why this recommendation follows from the provided input"
    }
  ]
}

Input:
${JSON.stringify(payload, null, 2)}`;
}

function testDefinitionForKey(input: XrayTestReviewInput, key: string): unknown {
  const definition = input.testDefinitions.find((item) => item.key.toLowerCase() === key.toLowerCase());
  if (!definition) {
    return undefined;
  }

  return {
    issueId: definition.issueId,
    testType: definition.testType,
    status: definition.status,
    description: definition.description,
    labels: definition.labels,
    gherkin: definition.gherkin,
    steps: definition.steps.map((step) => ({
      action: step.action,
      data: step.data,
      expectedResult: step.expectedResult,
    })),
  };
}
