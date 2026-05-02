import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import { XrayTestGenerationPlanSchema } from "../../domain/xrayTestGeneration/schema.js";
import type { XrayTestGenerationPlan } from "../../domain/xrayTestGeneration/schema.js";
import type { XrayTestPlanner, XrayTestPlanningInput } from "../../workflows/xray-test-generation/testPlanner.js";
import { juanaSystemPrompt } from "./juanaPersona.js";
import { extractOutputText, parseJsonObject, postOpenAiResponses } from "./responsesClient.js";

export interface OpenAiXrayTestPlannerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class OpenAiXrayTestPlanner implements XrayTestPlanner {
  readonly provider = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: OpenAiXrayTestPlannerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "https://api.openai.com/v1";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async plan(input: XrayTestPlanningInput): Promise<XrayTestGenerationPlan> {
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
                "Generate a bounded Xray manual test-case plan from the provided workflow context. Use only the provided JSON. Return strict JSON with strategySummary, coverageGaps, and testCases. Use existing-test review input as the source of current coverage. Create only genuine coverage gaps. Every proposed create/update test must be traceable to a Jira requirement, PR diff clue, explicit Confluence reference, existing-test gap, or clearly stated risk in the input.",
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
      this.provenance.push({ method: "planXrayTests", toolName: "openai:responses", calledAt, success: true });
      return XrayTestGenerationPlanSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "planXrayTests", toolName: "openai:responses", calledAt, success: false, message });
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

function buildPrompt(input: XrayTestPlanningInput): string {
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
      attachments: input.context.attachments.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
      })),
    },
    existingXrayTests: input.context.xrayTestCases.map((test) => ({
      key: test.key,
      title: test.title,
      status: test.status,
      labels: test.labels,
      relationship: test.relationship,
    })),
    existingTestReview: input.xrayTestReview
      ? {
          overallSummary: input.xrayTestReview.review.overallSummary,
          coveredAcceptanceCriteria: input.xrayTestReview.review.coveredAcceptanceCriteria,
          gapsOrAmbiguities: input.xrayTestReview.review.gapsOrAmbiguities,
          testCases: input.xrayTestReview.review.testCases.map((test) => ({
            key: test.key,
            title: test.title,
            summary: test.summary,
            coveredAcceptanceCriteria: test.coveredAcceptanceCriteria,
            coveredBehaviors: test.coveredBehaviors,
            gapsOrAmbiguities: test.gapsOrAmbiguities,
            updateRecommendation: test.updateRecommendation,
            rationale: test.rationale,
          })),
        }
      : undefined,
    pullRequestChanges: input.prChanges?.pullRequests.map((pullRequest) => ({
      title: pullRequest.title,
      status: pullRequest.status,
      repository: pullRequest.repository,
      sourceBranch: pullRequest.sourceBranch,
      summary: pullRequest.understanding.summary,
      changeAreas: pullRequest.understanding.changeAreas,
      risks: pullRequest.understanding.risks,
      testingNotes: pullRequest.understanding.testingNotes,
      files: pullRequest.diff.files.slice(0, 100).map((file) => ({
        path: file.path,
        changeType: file.changeType,
      })),
      sourceFiles: pullRequest.diff.sourceFiles.slice(0, 20).map((file) => ({
        path: file.path,
        role: file.role,
        changeType: file.changeType,
        language: file.language,
        reason: file.reason,
        truncated: file.truncated,
        content: file.content.slice(0, 8000),
      })),
    })),
    confluenceImpact: input.confluenceImpact?.pages.map((page) => ({
      title: page.page.title,
      url: page.page.url,
      summary: page.impact.summary,
      relevance: page.impact.ticketRelevance,
      impactedAreas: page.impact.impactedAreas,
      decisionsOrConstraints: page.impact.decisionsOrConstraints,
      risks: page.impact.risks,
      testingNotes: page.impact.testingNotes,
    })),
  };

  return `Generate an Xray manual test-case plan for this Jira ticket.

Rules:
- Include every existing Xray test case in testCases with action "keep" or "update".
- Use existingTestReview as the source for what existing tests already cover when it is present.
- Do not re-review raw existing Xray test descriptions in this generation step.
- Use action "update" only when the existing test should materially change; include existingTestKey.
- Use action "create" for missing coverage only.
- Every create/update test must include concrete manual steps.
- Keep tests atomic and readable for manual QA.
- Titles should be valid Jira summaries and mention the behavior under test.
- Do not invent external requirements that are not supported by the input.
- Make each test traceable through objective, coverageAreas, and rationale.
- Make each test traceable through sourceEvidence. Use concrete references such as Jira issue fields, comments, PR URLs/file paths, Confluence page URLs, or Xray review/test keys.
- Use rationale to state source evidence, risk covered, and any assumption or open question.
- Set readiness to "needs-clarification" when the scenario is useful but some precondition, data, permission, or expected behavior is not directly confirmed.
- Prefer high priority for changed logic, data mutation, permissions, external integrations, and no-obvious-fallback paths.

Required JSON shape:
{
  "strategySummary": "concise summary of the generated test strategy",
  "coverageGaps": ["gap covered by created or updated tests"],
  "testCases": [
    {
      "action": "create | update | keep",
      "existingTestKey": "TEST-123 only for update/keep",
      "title": "Jira summary",
      "objective": "what this test proves",
      "priority": "low | medium | high",
      "coverageAreas": ["workflow, API, integration, edge case, regression area"],
      "preconditions": ["setup condition"],
      "steps": [
        {
          "action": "manual action",
          "data": "test data if needed",
          "expectedResult": "observable expected result"
        }
      ],
      "sourceEvidence": [
        {
          "source": "jira | comment | pull-request | code-diff | confluence | xray-review | existing-xray-test | assumption",
          "reference": "issue key, comment timestamp, PR URL, file path, Confluence URL, or Xray key",
          "summary": "short statement of what this source supports"
        }
      ],
      "riskCovered": "regression, validation, authorization, data integrity, error handling, integration, or other concrete risk",
      "readiness": "ready | needs-clarification",
      "openQuestions": ["specific missing information, or empty when ready"],
      "rationale": "why this test is needed or why an existing test is kept"
    }
  ]
}

Input:
${JSON.stringify(payload, null, 2)}`;
}
