import { describe, expect, it } from "vitest";
import type { ContextPack, ToolProvenance, Warning } from "../src/domain/contextPack/schema.js";
import type { XrayTestReviewAnalysis } from "../src/domain/xrayTestReview/schema.js";
import { XrayTestReviewPackSchema } from "../src/domain/xrayTestReview/schema.js";
import { XrayCloudClient } from "../src/integrations/xray/client.js";
import { XrayCloudTestDefinitionSource } from "../src/integrations/xray/testDefinitionSource.js";
import { renderXrayTestReviewMarkdown } from "../src/output/xray-test-review/renderer.js";
import { extractXrayTestReview } from "../src/workflows/xray-test-review/extractor.js";
import type { XrayTestReviewer, XrayTestReviewInput } from "../src/workflows/xray-test-review/reviewer.js";
import type { XrayTestDefinition, XrayTestDefinitionSource } from "../src/workflows/xray-test-review/xrayTestDefinitionSource.js";

describe("extractXrayTestReview", () => {
  it("creates a validated linked Xray test review pack", async () => {
    const pack = await extractXrayTestReview(contextPack(), new FakeReviewer(), {
      sourceContextPath: "out/PROJ-1/context.json",
      definitionSource: new FakeDefinitionSource(),
    });

    expect(XrayTestReviewPackSchema.parse(pack)).toEqual(pack);
    expect(pack.review.testCases).toEqual([
      expect.objectContaining({
        key: "TEST-1",
        coveredAcceptanceCriteria: ["Checkout rejects invalid cards."],
        updateRecommendation: "keep",
      }),
    ]);
    expect(renderXrayTestReviewMarkdown(pack)).toContain("## Linked Xray Tests");
  });

  it("writes an empty review without an LLM when there are no linked tests", async () => {
    const context = contextPack();
    context.xrayTestCases = [];

    const pack = await extractXrayTestReview(context, undefined, {
      sourceContextPath: "out/PROJ-1/context.json",
    });

    expect(XrayTestReviewPackSchema.parse(pack)).toEqual(pack);
    expect(pack.review.testCases).toEqual([]);
    expect(pack.provenance.llm).toBeUndefined();
  });
});

describe("XrayCloudTestDefinitionSource", () => {
  it("fetches expanded Xray test definitions", async () => {
    const source = new XrayCloudTestDefinitionSource(
      new XrayCloudClient({
        baseUrl: "https://xray.cloud.getxray.app",
        clientId: "client",
        clientSecret: "secret",
        fetchFn: async (input, init) => {
          const url = String(input);
          if (url.includes("/authenticate")) {
            return jsonResponse("xray-token");
          }

          const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { jql?: string } };
          expect(body.variables?.jql).toBe('issuekey in ("TEST-1")');
          return jsonResponse({
            data: {
              getExpandedTests: {
                results: [
                  {
                    issueId: "10001",
                    testType: { name: "Manual" },
                    steps: [{ action: "Submit an invalid card", data: "4111", result: "Payment is rejected" }],
                    jira: JSON.stringify({
                      key: "TEST-1",
                      summary: "Invalid card is rejected",
                      labels: ["checkout"],
                      status: { name: "Done" },
                    }),
                  },
                ],
              },
            },
          });
        },
      }),
    );

    await expect(
      source.getTestDefinitions([{ key: "TEST-1", title: "Invalid card is rejected", labels: [] }]),
    ).resolves.toEqual([
      expect.objectContaining({
        key: "TEST-1",
        issueId: "10001",
        testType: "Manual",
        status: "Done",
        steps: [{ action: "Submit an invalid card", data: "4111", expectedResult: "Payment is rejected" }],
      }),
    ]);
  });
});

class FakeReviewer implements XrayTestReviewer {
  readonly provider = "test-llm";
  readonly model = "test-model";

  async review(input: XrayTestReviewInput): Promise<XrayTestReviewAnalysis> {
    expect(input.context.xrayTestCases).toHaveLength(1);
    expect(input.testDefinitions[0]?.steps[0]?.action).toBe("Submit an invalid card");
    return {
      overallSummary: "The linked test covers invalid-card checkout rejection.",
      coveredAcceptanceCriteria: ["Checkout rejects invalid cards."],
      gapsOrAmbiguities: [],
      testCases: [
        {
          key: "TEST-1",
          title: "Invalid card is rejected",
          status: "Done",
          relationship: "tests",
          summary: "Verifies checkout rejects an invalid card.",
          coveredAcceptanceCriteria: ["Checkout rejects invalid cards."],
          coveredBehaviors: ["Payment validation failure"],
          testDataOrPreconditions: ["Checkout is available."],
          gapsOrAmbiguities: [],
          updateRecommendation: "keep",
          rationale: "The title and description match the ticket behavior.",
        },
      ],
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "reviewLinkedXrayTests", toolName: "llm:test", calledAt: "2026-05-02T12:00:00.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

class FakeDefinitionSource implements XrayTestDefinitionSource {
  async getTestDefinitions(): Promise<XrayTestDefinition[]> {
    return [
      {
        key: "TEST-1",
        title: "Invalid card is rejected",
        issueId: "10001",
        status: "Done",
        testType: "Manual",
        labels: [],
        steps: [{ action: "Submit an invalid card", expectedResult: "The payment is rejected." }],
      },
    ];
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "getXrayTestDefinitions", toolName: "xray:getExpandedTests", calledAt: "2026-05-02T12:00:00.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

function contextPack(): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: {
      key: "PROJ-1",
      title: "Checkout validation",
      labels: [],
      components: [],
      links: [],
    },
    description: {
      format: "text",
      text: "Checkout should reject invalid cards.",
    },
    comments: [],
    attachments: [],
    xrayTestCases: [
      {
        key: "TEST-1",
        title: "Invalid card is rejected",
        status: "Done",
        description: "Submit an invalid card and expect rejection.",
        labels: [],
        relationship: "tests",
      },
    ],
    development: {
      branches: [],
      pullRequests: [],
    },
    confluencePages: [],
    provenance: {
      generatedAt: "2026-05-02T12:00:00.000Z",
      issueKey: "PROJ-1",
      source: "jira-rest",
      tools: [],
    },
    warnings: [],
  };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}
