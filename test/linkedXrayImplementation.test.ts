import { describe, expect, it } from "vitest";
import type { ContextPack } from "../src/domain/contextPack/schema.js";
import { XrayTestGenerationPackSchema } from "../src/domain/xrayTestGeneration/schema.js";
import type { XrayTestDefinition } from "../src/workflows/xray-test-review/xrayTestDefinitionSource.js";
import { buildLinkedXrayImplementationPack } from "../src/workflows/xray-test-generation/linkedXrayImplementationPack.js";

describe("buildLinkedXrayImplementationPack", () => {
  it("turns existing linked Xray tests into implementation-only update cases", () => {
    const pack = buildLinkedXrayImplementationPack({
      context: contextPack(),
      definitions: xrayDefinitions(),
      sourceContextPath: "out/PROJ-1/context.json",
      definitionProvenance: [
        {
          method: "getXrayTestDefinitions",
          toolName: "xray:getExpandedTests",
          calledAt: "2026-05-02T12:00:01.000Z",
          success: true,
        },
      ],
      generatedAt: "2026-05-02T12:00:02.000Z",
    });

    expect(XrayTestGenerationPackSchema.parse(pack)).toEqual(pack);
    expect(pack.plan.strategySummary).toContain("existing Xray tests already linked");
    expect(pack.plan.testCases).toHaveLength(3);
    expect(pack.plan.testCases.every((testCase) => testCase.action === "update")).toBe(true);
    expect(pack.application.testSet).toEqual(
      expect.objectContaining({
        status: "skipped",
        includedTestKeys: ["TEST-1", "TEST-2", "TEST-3"],
        includedTestIssueIds: ["10001", "10002"],
      }),
    );

    expect(pack.plan.testCases[0]).toEqual(
      expect.objectContaining({
        existingTestKey: "TEST-1",
        title: "Manual test from Xray",
        readiness: "ready",
        steps: [{ action: "Submit request", data: "customer id 123", expectedResult: "The request succeeds." }],
      }),
    );
    expect(pack.plan.testCases[1]?.steps[0]).toEqual(
      expect.objectContaining({
        action: "Automate the Xray Gherkin scenario.",
        data: expect.stringContaining("Given checkout is open"),
      }),
    );
    expect(pack.plan.testCases[2]).toEqual(
      expect.objectContaining({
        existingTestKey: "TEST-3",
        readiness: "needs-clarification",
        openQuestions: ["Xray Cloud did not return an expanded definition for this linked test.", "No manual steps or Gherkin scenario were available from Xray."],
      }),
    );
    expect(pack.warnings.map((warning) => warning.section)).toContain("linked-xray-tests");
  });
});

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
      { key: "TEST-1", title: "Fallback title", labels: ["checkout"] },
      { key: "TEST-2", title: "Gherkin fallback", labels: [] },
      { key: "TEST-3", title: "Missing expanded definition", labels: [] },
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

function xrayDefinitions(): XrayTestDefinition[] {
  return [
    {
      key: "TEST-1",
      title: "Manual test from Xray",
      issueId: "10001",
      status: "Approved",
      testType: "Manual",
      description: "Existing Xray manual test.",
      labels: ["checkout", "manual"],
      steps: [{ action: "Submit request", data: "customer id 123", expectedResult: "The request succeeds." }],
    },
    {
      key: "TEST-2",
      title: "Gherkin test from Xray",
      issueId: "10002",
      testType: "Cucumber",
      labels: [],
      gherkin: "Given checkout is open\nWhen a payment is submitted\nThen the payment is accepted",
      steps: [],
    },
  ];
}
