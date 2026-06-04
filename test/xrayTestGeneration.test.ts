import { describe, expect, it } from "vitest";
import type { ContextPack, ToolProvenance, Warning } from "../src/domain/contextPack/schema.js";
import type { XrayTestReviewPack } from "../src/domain/xrayTestReview/schema.js";
import type { XrayTestApplication, XrayTestGenerationPlan } from "../src/domain/xrayTestGeneration/schema.js";
import { XrayTestGenerationPackSchema } from "../src/domain/xrayTestGeneration/schema.js";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { XrayCloudClient } from "../src/integrations/xray/client.js";
import { XrayCloudTestSink } from "../src/integrations/xray/testSink.js";
import { renderXrayTestGenerationMarkdown } from "../src/output/xray-test-generation/renderer.js";
import { extractXrayTestGeneration } from "../src/workflows/xray-test-generation/extractor.js";
import type { XrayTestPlanner, XrayTestPlanningInput } from "../src/workflows/xray-test-generation/testPlanner.js";
import type { ApplyXrayTestsInput, XrayTestSink } from "../src/workflows/xray-test-generation/xrayTestSink.js";

describe("extractXrayTestGeneration", () => {
  it("creates a validated dry-run Xray test generation pack", async () => {
    const pack = await extractXrayTestGeneration(contextPack(), xrayTestReviewPack(), undefined, undefined, new FakePlanner(), undefined, {
      sourceContextPath: "out/PROJ-1/context.json",
      sourceXrayTestReviewPath: "out/PROJ-1/xray-test-review.json",
      dryRun: true,
    });

    expect(XrayTestGenerationPackSchema.parse(pack)).toEqual(pack);
    expect(pack.application.status).toBe("dry-run");
    expect(pack.application.tests).toEqual([
      expect.objectContaining({
        action: "keep",
        status: "skipped",
        existingTestKey: "TEST-1",
      }),
      expect.objectContaining({
        action: "create",
        status: "skipped",
      }),
    ]);
    expect(renderXrayTestGenerationMarkdown(pack)).toContain("## Planned Test Cases");
  });

  it("applies the generated plan through the Xray sink", async () => {
    const pack = await extractXrayTestGeneration(contextPack(), xrayTestReviewPack(), undefined, undefined, new FakePlanner(), new FakeSink(), {
      sourceContextPath: "out/PROJ-1/context.json",
      sourceXrayTestReviewPath: "out/PROJ-1/xray-test-review.json",
      dryRun: false,
    });

    expect(pack.application).toEqual(
      expect.objectContaining({
        status: "applied",
        testSet: expect.objectContaining({
          key: "TS-1",
          includedTestKeys: ["TEST-1", "TEST-2"],
        }),
      }),
    );
  });

  it("rejects weak generated plans before Jira/Xray mutations", async () => {
    await expect(
      extractXrayTestGeneration(contextPack(), xrayTestReviewPack(), undefined, undefined, new InvalidPlanner(), new FailingSink(), {
        sourceContextPath: "out/PROJ-1/context.json",
        sourceXrayTestReviewPath: "out/PROJ-1/xray-test-review.json",
        dryRun: false,
      }),
    ).rejects.toThrow("Xray test generation plan failed quality gate");
  });
});

describe("XrayCloudTestSink", () => {
  it("creates, updates, keeps, deprecates, and groups active tests in a generated Test Set", async () => {
    const jiraCalls: Array<{ method: string; url: string }> = [];
    const jiraUpdates: unknown[] = [];
    const jiraTransitions: unknown[] = [];
    const issueLinks: unknown[] = [];
    const xrayOperations: string[] = [];
    const sink = new XrayCloudTestSink({
      jira: new AtlassianRestClient({
        jira: { baseUrl: "https://example.atlassian.net", username: "user@example.com", apiToken: "token" },
        fetchFn: async (input, init) => {
          const url = String(input);
          const path = new URL(url).pathname;
          const method = init?.method ?? "GET";
          jiraCalls.push({ method: init?.method ?? "GET", url });

          if (url.includes("/issueLinkType")) {
            return jsonResponse({
              issueLinkTypes: [
                { id: "10000", name: "Relates", inward: "relates to", outward: "relates to" },
                { id: "10010", name: "tests", inward: "is tested by", outward: "tests" },
              ],
            });
          }

          if (new URL(url).pathname.endsWith("/issueLink")) {
            issueLinks.push(JSON.parse(String(init?.body ?? "{}")));
            return jsonResponse(undefined, 201, "Created");
          }

          if (path.endsWith("/issue/TEST-4/transitions") && method === "GET") {
            return jsonResponse({
              transitions: [{ id: "31", name: "Deprecated", to: { name: "Deprecated" } }],
            });
          }

          if (path.endsWith("/issue/TEST-4/transitions") && method === "POST") {
            jiraTransitions.push(JSON.parse(String(init?.body ?? "{}")));
            return jsonResponse(undefined, 204);
          }

          if (path.endsWith("/issue/TEST-4") && method === "PUT") {
            jiraUpdates.push(JSON.parse(String(init?.body ?? "{}")));
            return jsonResponse(undefined, 204);
          }

          if (path.endsWith("/issue/TEST-4")) {
            return jsonResponse({
              id: "10004",
              key: "TEST-4",
              fields: {
                summary: "Legacy approval path",
                labels: ["checkout"],
                status: { name: "Approved" },
              },
            });
          }

          if (url.includes("/issue/TEST-1")) {
            return jsonResponse({ id: "10001", key: "TEST-1" });
          }

          if (url.includes("/issue/TEST-2")) {
            return jsonResponse({ id: "10002", key: "TEST-2" });
          }

          return jsonResponse(undefined, 204);
        },
      }),
      issueLinkTypeNameHint: "tests",
      issueLinkDirection: "test-to-ticket",
      xray: new XrayCloudClient({
        baseUrl: "https://xray.cloud.getxray.app",
        clientId: "client",
        clientSecret: "secret",
        fetchFn: async (input, init) => {
          const url = String(input);
          if (url.includes("/authenticate")) {
            return jsonResponse("xray-token");
          }

          const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
          const query = body.query ?? "";

          if (query.includes("CreateManualTest")) {
            expect(getPath(body.variables, "jira.fields.description")).toEqual(expect.any(String));
            xrayOperations.push("createTest");
            return jsonResponse({ data: { createTest: { test: { issueId: "10003", jira: "{\"key\":\"TEST-3\"}" }, warnings: [] } } });
          }

          if (query.includes("UpdateTestType")) {
            xrayOperations.push("updateTestType");
            return jsonResponse({ data: { updateTestType: { issueId: "10002" } } });
          }

          if (query.includes("RemoveAllTestSteps")) {
            xrayOperations.push("removeAllTestSteps");
            return jsonResponse({ data: { removeAllTestSteps: "ok" } });
          }

          if (query.includes("AddTestStep")) {
            xrayOperations.push("addTestStep");
            return jsonResponse({ data: { addTestStep: { id: "step-1", action: "Act", result: "Result" } } });
          }

          if (query.includes("CreateGeneratedTestSet")) {
            expect(getPath(body.variables, "jira.fields.description")).toEqual(expect.any(String));
            xrayOperations.push("createTestSet");
            return jsonResponse({ data: { createTestSet: { testSet: { issueId: "20001", jira: "{\"key\":\"TS-1\"}" }, warnings: [] } } });
          }

          return jsonResponse({ errors: [{ message: "Unexpected query" }] });
        },
      }),
    });

    const application = await sink.apply({
      ticketKey: "PROJ-1",
      ticketTitle: "Checkout validation",
      projectKey: "PROJ",
      plan: {
        strategySummary: "Cover existing behavior and new validation.",
        coverageGaps: ["Missing invalid card branch."],
        testCases: [
          {
            action: "keep",
            existingTestKey: "TEST-1",
            title: "Existing happy path",
            objective: "Existing coverage remains valid.",
            priority: "medium",
            coverageAreas: ["checkout"],
            preconditions: [],
            steps: [],
            sourceEvidence: [{ source: "xray-review", reference: "TEST-1", summary: "Existing test covers the happy path." }],
            riskCovered: "regression",
            readiness: "ready",
            openQuestions: [],
            rationale: "Already covers the happy path.",
          },
          {
            action: "update",
            existingTestKey: "TEST-2",
            title: "Invalid card is rejected",
            objective: "Verify rejected card handling.",
            priority: "high",
            coverageAreas: ["checkout validation"],
            preconditions: ["Checkout is available."],
            steps: [{ action: "Submit an invalid card", expectedResult: "The payment is rejected." }],
            sourceEvidence: [{ source: "jira", reference: "PROJ-1", summary: "Ticket requires invalid card rejection." }],
            riskCovered: "validation",
            readiness: "ready",
            openQuestions: [],
            rationale: "Existing test needs the new validation expectation.",
          },
          {
            action: "create",
            title: "Provider timeout is handled",
            objective: "Verify timeout handling.",
            priority: "high",
            coverageAreas: ["provider integration"],
            preconditions: ["Provider timeout can be simulated."],
            steps: [{ action: "Trigger provider timeout", expectedResult: "A retryable error is shown." }],
            sourceEvidence: [{ source: "pull-request", reference: "provider mapping", summary: "Provider integration risk is visible in the change plan." }],
            riskCovered: "integration error handling",
            readiness: "needs-clarification",
            openQuestions: ["Confirm how to simulate the provider timeout in the target environment."],
            rationale: "No existing test covers provider timeout behavior.",
          },
          {
            action: "deprecate",
            existingTestKey: "TEST-4",
            title: "Legacy approval path",
            objective: "Mark the legacy approval path test as obsolete because it conflicts with current acceptance criteria.",
            priority: "medium",
            coverageAreas: ["checkout"],
            preconditions: [],
            steps: [],
            sourceEvidence: [{ source: "xray-review", reference: "TEST-4", summary: "Existing test validates behavior that is no longer accepted." }],
            riskCovered: "obsolete test coverage",
            readiness: "ready",
            openQuestions: [],
            rationale: "The current ticket acceptance criteria reject the legacy approval path.",
          },
        ],
      },
    });

    expect(application.testSet).toEqual(
      expect.objectContaining({
        key: "TS-1",
        issueId: "20001",
        includedTestIssueIds: ["10001", "10002", "10003"],
      }),
    );
    expect(application.tests).toContainEqual(expect.objectContaining({
      action: "deprecate",
      status: "deprecated",
      key: "TEST-4",
      issueId: "10004",
    }));
    expect(application.tests.filter((test) => test.status !== "deprecated").every((test) => test.linkedToTicket)).toBe(true);
    expect(issueLinks).toEqual([
      expect.objectContaining({
        type: { id: "10010" },
        outwardIssue: { key: "TEST-1" },
        inwardIssue: { key: "PROJ-1" },
      }),
      expect.objectContaining({
        type: { id: "10010" },
        outwardIssue: { key: "TEST-2" },
        inwardIssue: { key: "PROJ-1" },
      }),
      expect.objectContaining({
        type: { id: "10010" },
        outwardIssue: { key: "TEST-3" },
        inwardIssue: { key: "PROJ-1" },
      }),
    ]);
    expect(xrayOperations).toEqual(["updateTestType", "removeAllTestSteps", "addTestStep", "createTest", "createTestSet"]);
    expect(jiraCalls.some((call) => call.method === "PUT" && call.url.includes("/issue/TEST-2"))).toBe(true);
    expect(jiraUpdates[0]).toEqual(expect.objectContaining({
      fields: expect.objectContaining({
        summary: "[DEPRECATED] Legacy approval path",
        labels: expect.arrayContaining(["checkout", "deprecated", "deprecated-by-context-workflow"]),
      }),
    }));
    expect(jiraTransitions).toEqual([{ transition: { id: "31" } }]);
    expect(jiraCalls.filter((call) => call.method === "GET" && call.url.includes("/issueLinkType"))).toHaveLength(1);
    expect(jiraCalls.filter((call) => call.method === "POST" && new URL(call.url).pathname.endsWith("/issueLink"))).toHaveLength(3);
    expect(sink.getProvenance().some((item) => item.toolName === "xray:createTestSet" && item.success)).toBe(true);
  });
});

class FakePlanner implements XrayTestPlanner {
  readonly provider = "test-llm";
  readonly model = "test-model";

  async plan(input: XrayTestPlanningInput): Promise<XrayTestGenerationPlan> {
    expect(input.context.ticket.key).toBe("PROJ-1");
    expect(input.xrayTestReview?.review.testCases[0]?.coveredAcceptanceCriteria).toEqual(["Checkout succeeds with valid data."]);
    return {
      strategySummary: "Keep existing happy path and add invalid-card coverage.",
      coverageGaps: ["Invalid card rejection is not covered."],
      testCases: [
        {
          action: "keep",
          existingTestKey: "TEST-1",
          title: "Existing happy path",
          objective: "Existing coverage remains valid.",
          priority: "medium",
          coverageAreas: ["checkout"],
          preconditions: [],
          steps: [],
          sourceEvidence: [{ source: "xray-review", reference: "TEST-1", summary: "Existing test covers valid checkout." }],
          riskCovered: "regression",
          readiness: "ready",
          openQuestions: [],
          rationale: "Already covers the happy path.",
        },
        {
          action: "create",
          title: "Invalid card is rejected",
          objective: "Verify invalid card handling.",
          priority: "high",
          coverageAreas: ["checkout validation"],
          preconditions: ["Checkout is available."],
          steps: [{ action: "Submit an invalid card", expectedResult: "The payment is rejected." }],
          sourceEvidence: [{ source: "jira", reference: "PROJ-1", summary: "Ticket states invalid cards should be rejected." }],
          riskCovered: "validation",
          readiness: "ready",
          openQuestions: [],
          rationale: "No existing test covers invalid card rejection.",
        },
      ],
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "planXrayTests", toolName: "llm:test", calledAt: "2026-05-02T12:00:00.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

class FakeSink implements XrayTestSink {
  async apply(input: ApplyXrayTestsInput): Promise<XrayTestApplication> {
    expect(input.projectKey).toBe("PROJ");
    return {
      status: "applied",
      tests: [
        {
          action: "keep",
          status: "kept",
          requestedTitle: "Existing happy path",
          existingTestKey: "TEST-1",
          key: "TEST-1",
          issueId: "10001",
          warnings: [],
        },
        {
          action: "create",
          status: "created",
          requestedTitle: "Invalid card is rejected",
          key: "TEST-2",
          issueId: "10002",
          warnings: [],
        },
      ],
      testSet: {
        status: "created",
        title: "PROJ-1 Generated Test Set - Checkout validation",
        key: "TS-1",
        issueId: "20001",
        includedTestKeys: ["TEST-1", "TEST-2"],
        includedTestIssueIds: ["10001", "10002"],
        warnings: [],
      },
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "createTestSet", toolName: "xray:test", calledAt: "2026-05-02T12:00:01.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

class InvalidPlanner implements XrayTestPlanner {
  readonly provider = "test-llm";
  readonly model = "test-model";

  async plan(): Promise<XrayTestGenerationPlan> {
    return {
      strategySummary: "Invalid plan.",
      coverageGaps: ["Missing coverage."],
      testCases: [
        {
          action: "create",
          title: "Invalid card is rejected",
          objective: "Verify invalid card handling.",
          priority: "high",
          coverageAreas: ["checkout validation"],
          preconditions: ["Checkout is available."],
          steps: [],
          sourceEvidence: [{ source: "jira", reference: "PROJ-1", summary: "Ticket states invalid cards should be rejected." }],
          riskCovered: "validation",
          readiness: "ready",
          openQuestions: [],
          rationale: "No existing test covers invalid card rejection.",
        },
      ],
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "planXrayTests", toolName: "llm:test", calledAt: "2026-05-02T12:00:00.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

class FailingSink implements XrayTestSink {
  async apply(): Promise<XrayTestApplication> {
    throw new Error("Sink should not be called for plans that fail the quality gate.");
  }

  getProvenance(): ToolProvenance[] {
    return [];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

function xrayTestReviewPack(): XrayTestReviewPack {
  return {
    schemaVersion: "1.0.0",
    ticket: {
      key: "PROJ-1",
      title: "Checkout validation",
    },
    review: {
      overallSummary: "The existing happy path test covers valid checkout.",
      coveredAcceptanceCriteria: ["Checkout succeeds with valid data."],
      gapsOrAmbiguities: ["Invalid-card rejection is not covered."],
      testCases: [
        {
          key: "TEST-1",
          title: "Existing happy path",
          summary: "Verifies a successful checkout.",
          coveredAcceptanceCriteria: ["Checkout succeeds with valid data."],
          coveredBehaviors: ["Happy path checkout"],
          testDataOrPreconditions: [],
          gapsOrAmbiguities: [],
          updateRecommendation: "keep",
          rationale: "The linked test already matches the happy path.",
        },
      ],
    },
    provenance: {
      generatedAt: "2026-05-02T12:00:00.000Z",
      sourceContextPath: "out/PROJ-1/context.json",
      llm: {
        provider: "test-llm",
        model: "test-model",
      },
      tools: [],
    },
    warnings: [],
  };
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
    xrayTestCases: [{ key: "TEST-1", title: "Existing happy path", labels: [] }],
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
  return new Response(status === 204 ? undefined : JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);
}
