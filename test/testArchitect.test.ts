import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runResearcher } from "../src/agents/researcher/index.js";
import { normalizeScenarioTags } from "../src/agents/testArchitect/gherkinAuthoring.js";
import { runTestArchitect } from "../src/agents/testArchitect/index.js";
import { buildGherkinDesignPrompt } from "../src/agents/testArchitect/prompts.js";
import { runDesignTests } from "../src/cli/designTests.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import { TestDesignPackSchema } from "../src/domain/testDesignPack/schema.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import {
  featureFileSlug,
  renderFeatureFile,
  renderTestDesignMarkdown,
} from "../src/output/test-design/renderer.js";
import { writeTestDesignPack } from "../src/output/test-design/writer.js";
import { CliError } from "../src/shared/cli.js";

interface StubLlmInput {
  acResponse?: string;
  gherkinResponse?: string;
  errorFor?: "extract-acceptance-criteria" | "design-gherkin-scenarios";
}

function stubLlm(input: StubLlmInput): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub-model",
    toolName: "stub:test",
    async generateText(request: LlmTextGenerationRequest): Promise<string> {
      if (input.errorFor && request.operation === input.errorFor) {
        throw new Error(`LLM intentional failure for ${request.operation}`);
      }
      if (request.operation === "extract-acceptance-criteria") {
        if (!input.acResponse) {
          throw new Error("acResponse not provided to stubLlm");
        }
        return input.acResponse;
      }
      if (request.operation === "design-gherkin-scenarios") {
        if (!input.gherkinResponse) {
          throw new Error("gherkinResponse not provided to stubLlm");
        }
        return input.gherkinResponse;
      }
      throw new Error(`Unexpected operation: ${request.operation ?? "(none)"}`);
    },
  };
}

function stubProvider(): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => ({
      ticket: {
        key,
        title: "Instalment plan selection at checkout",
        labels: ["billing"],
        components: ["Checkout"],
        links: [],
        status: "In Progress",
        issueType: "Story",
      },
      description: {
        format: "text",
        text: "Customers should be able to choose a 3-instalment plan when their order is eligible. Ineligible orders should not show the plan.",
      },
      comments: [],
      linkedIssues: [],
    }),
    getComments: async () => [],
    getAttachments: async () => [],
    getLinkedIssues: async () => [],
    getDevelopmentLinks: async () => ({ branches: [], pullRequests: [] }),
    getConfluencePages: async () => [],
    getProvenance: () => [
      {
        method: "getIssue",
        toolName: "jira-rest:issue",
        calledAt: "2024-01-01T00:00:00.000Z",
        success: true,
      },
    ],
    getWarnings: () => [],
    close: async () => undefined,
  };
}

const AC_JSON = JSON.stringify([
  { id: "AC-1", text: "Customer can select a 3-instalment plan for an eligible order.", source: "description" },
  { id: "AC-2", text: "Ineligible orders do not show the 3-instalment plan option.", source: "description" },
]);

const GHERKIN_JSON = JSON.stringify({
  strategySummary: "Cover the positive and negative selection paths for instalment plans.",
  coverageGaps: [],
  openQuestions: [],
  scenarios: [
    {
      title: "Customer selects an eligible 3-instalment plan",
      feature: "Instalment plan selection",
      tags: ["@instalments"],
      acIds: ["AC-1"],
      risk: "high",
      readiness: "ready",
      objective: "Verify a customer can choose the 3-instalment plan on an eligible order.",
      preconditions: ["The customer's order is eligible for instalments"],
      steps: [
        { keyword: "Given", text: "a customer with an approved checkout of 300.00 EUR" },
        { keyword: "When", text: "the customer selects the \"3 instalments\" plan" },
        { keyword: "Then", text: "the plan schedule shows 3 payments of 100.00 EUR" },
      ],
      sourceEvidence: [
        { source: "description", reference: "paragraph 1", summary: "Customers should be able to choose a 3-instalment plan." },
      ],
      openQuestions: [],
      rationale: "Direct positive path covering AC-1.",
    },
    {
      title: "Ineligible orders do not surface the 3-instalment plan",
      feature: "Instalment plan selection",
      tags: ["@instalments"],
      acIds: ["AC-2"],
      risk: "medium",
      readiness: "ready",
      objective: "Verify ineligible orders never expose the instalment option.",
      preconditions: ["The order amount is below the eligibility threshold"],
      steps: [
        { keyword: "Given", text: "a customer with an approved checkout of 20.00 EUR" },
        { keyword: "When", text: "the customer opens the instalment options" },
        { keyword: "Then", text: "the \"3 instalments\" plan is not shown" },
      ],
      sourceEvidence: [
        { source: "description", reference: "paragraph 2", summary: "Ineligible orders should not show the plan." },
      ],
      openQuestions: [],
      rationale: "Negative path for AC-2.",
    },
  ],
});

describe("normalizeScenarioTags", () => {
  it("strips AC-id, risk-level, story, smoke, and polarity tags", () => {
    expect(
      normalizeScenarioTags(["@AC-1", "@high", "@story-X", "@smoke", "@negative", "@positive", "@login"], "medium"),
    ).toEqual(["@login"]);
  });

  it("adds @smoke for high-risk scenarios only", () => {
    expect(normalizeScenarioTags(["@login"], "high")).toEqual(["@login", "@smoke"]);
    expect(normalizeScenarioTags(["@login"], "medium")).toEqual(["@login"]);
    expect(normalizeScenarioTags(["@login"], "low")).toEqual(["@login"]);
  });

  it("adds a leading @ and de-duplicates", () => {
    expect(normalizeScenarioTags(["login", "@login", "@Login"], "low")).toEqual(["@login"]);
  });

  it("keeps feature-area tags but drops polarity tags", () => {
    expect(normalizeScenarioTags(["@checkout", "@negative", "@positive"], "low")).toEqual(["@checkout"]);
  });
});

describe("runTestArchitect", () => {
  it("produces a valid TestDesignPack from stubbed LLM responses", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-1", provider });
    const llm = stubLlm({ acResponse: AC_JSON, gherkinResponse: GHERKIN_JSON });

    const { contextWithCriteria, testDesign } = await runTestArchitect({ context, llm });

    expect(contextWithCriteria.acceptanceCriteria).toHaveLength(2);
    expect(testDesign.scenarios).toHaveLength(2);
    expect(testDesign.acCoverageMatrix).toEqual([
      { acId: "AC-1", scenarioIndexes: [0] },
      { acId: "AC-2", scenarioIndexes: [1] },
    ]);
    expect(testDesign.riskRanking.find((entry) => entry.level === "high")?.scenarioIndexes).toEqual([0]);
    expect(testDesign.riskRanking.find((entry) => entry.level === "medium")?.scenarioIndexes).toEqual([1]);

    // The whole pack must round-trip through the schema.
    expect(() => TestDesignPackSchema.parse(testDesign)).not.toThrow();

    // The Test Architect rebuilds the evidence graph once ACs exist, so the
    // enriched context carries requirement nodes + "specifies" edges.
    const graph = contextWithCriteria.evidenceGraph;
    expect(graph).toBeDefined();
    const nodeIds = new Set((graph?.nodes ?? []).map((n) => n.id));
    expect(nodeIds).toContain("requirement:AC-1");
    expect(nodeIds).toContain("requirement:AC-2");
    expect((graph?.edges ?? []).some((e) => e.type === "specifies" && e.to === "requirement:AC-1")).toBe(true);
  });

  it("accepts an AC marked covered-by-existing without failing the gate or retrying", async () => {
    // Only AC-1 gets a new scenario; AC-2 is declared already covered by an
    // existing repo scenario. The required gate must still pass.
    const onlyAc1 = JSON.parse(GHERKIN_JSON);
    onlyAc1.scenarios = [onlyAc1.scenarios[0]]; // keep the AC-1 scenario only
    onlyAc1.acsCoveredByExisting = ["AC-2"];

    let gherkinCalls = 0;
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-EXIST", provider });
    const llm = {
      provider: "anthropic" as const,
      model: "stub-model",
      toolName: "stub:test",
      async generateText(request: LlmTextGenerationRequest): Promise<string> {
        if (request.operation === "extract-acceptance-criteria") return AC_JSON;
        if (request.operation === "design-gherkin-scenarios") {
          gherkinCalls += 1;
          return JSON.stringify(onlyAc1);
        }
        throw new Error(`unexpected op ${request.operation ?? "?"}`);
      },
    };

    const { testDesign } = await runTestArchitect({ context, llm, acCoverageGate: "required" });

    expect(gherkinCalls).toBe(1); // no retry triggered
    expect(testDesign.scenarios).toHaveLength(1);
    expect(testDesign.acsCoveredByExisting).toEqual(["AC-2"]);
  });

  it("strips scenario references to unknown AC ids and records a warning", async () => {
    const tampered = JSON.parse(GHERKIN_JSON);
    tampered.scenarios[0].acIds = ["AC-1", "AC-99"];
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-2", provider });
    const llm = stubLlm({ acResponse: AC_JSON, gherkinResponse: JSON.stringify(tampered) });

    const { testDesign } = await runTestArchitect({ context, llm });

    expect(testDesign.scenarios[0]?.acIds).toEqual(["AC-1"]);
    expect(testDesign.warnings.some((w) => w.message.includes("AC-99"))).toBe(true);
  });

  it("throws a CliError when the AC extraction LLM output is not JSON", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-3", provider });
    const llm = stubLlm({ acResponse: "not json at all", gherkinResponse: GHERKIN_JSON });

    await expect(runTestArchitect({ context, llm })).rejects.toBeInstanceOf(CliError);
  });

  it("throws a CliError when the Gherkin LLM output fails schema validation", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-4", provider });
    const badGherkin = JSON.stringify({
      strategySummary: "",
      coverageGaps: [],
      openQuestions: [],
      scenarios: [
        {
          title: "incomplete",
          feature: "f",
          tags: [],
          acIds: [],
          // Missing required fields (risk, readiness, steps, ...)
        },
      ],
    });
    const llm = stubLlm({ acResponse: AC_JSON, gherkinResponse: badGherkin });

    await expect(runTestArchitect({ context, llm })).rejects.toBeInstanceOf(CliError);
  });
});

describe("test-design renderer + writer", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-design-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("renders a parseable .feature file with tags and steps", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-5", provider });
    const llm = stubLlm({ acResponse: AC_JSON, gherkinResponse: GHERKIN_JSON });
    const { testDesign } = await runTestArchitect({ context, llm });

    const feature = renderFeatureFile({
      ticketKey: testDesign.ticket.key,
      feature: testDesign.scenarios[0]?.feature ?? "Unknown",
      scenarios: testDesign.scenarios,
    });

    expect(feature).toContain("@ABC-5");
    expect(feature).not.toContain("@story-");
    expect(feature).toContain("Feature: Instalment plan selection");
    // High-risk scenario keeps its functional tag and gains @smoke automatically.
    expect(feature).toContain("@instalments @smoke");
    expect(feature).not.toContain("@AC-1");
    expect(feature).not.toContain("@high");
    expect(feature).toContain('Scenario: Customer selects an eligible 3-instalment plan');
    expect(feature).toContain("Given a customer with an approved checkout of 300.00 EUR");
  });

  it("renders a step's dataTable as an indented Gherkin pipe table (not And-steps)", () => {
    const feature = renderFeatureFile({
      ticketKey: "ABC-9",
      feature: "Service Invoices",
      scenarios: [
        {
          kind: "gherkin",
          title: "Table shows the expected columns",
          feature: "Service Invoices",
          tags: ["@invoices"],
          acIds: ["AC-1"],
          risk: "medium",
          readiness: "ready",
          objective: "Verify the columns.",
          preconditions: [],
          steps: [
            { keyword: "Given", text: "I open the page" },
            { keyword: "Then", text: "the table shows the columns:", dataTable: [["column name"], ["Actions"], ["Invoice ID"]] },
          ],
          sourceEvidence: [],
          openQuestions: [],
          rationale: "",
        },
      ],
    });

    expect(feature).toContain("Then the table shows the columns:");
    expect(feature).toContain("      | column name |");
    expect(feature).toContain("      | Actions |");
    expect(feature).toContain("      | Invoice ID |");
    // The columns must NOT be rendered as separate And-steps.
    expect(feature).not.toContain("And Actions");
  });

  it("writes test-design.json, test-design.md, and one .feature file per Feature", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-6", provider });
    const llm = stubLlm({ acResponse: AC_JSON, gherkinResponse: GHERKIN_JSON });
    const { testDesign } = await runTestArchitect({ context, llm });

    const result = await writeTestDesignPack(testDesign, workDir);

    expect(result.jsonPath).toContain("test-design.json");
    expect(result.markdownPath).toContain("test-design.md");
    expect(result.featurePaths).toHaveLength(1);

    const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
    expect(() => TestDesignPackSchema.parse(json)).not.toThrow();

    const md = await readFile(result.markdownPath, "utf8");
    expect(md).toContain("# Test Design — ABC-6");
    expect(md).toContain("## Acceptance Criteria");

    expect(featureFileSlug("Instalment plan selection")).toBe("instalment-plan-selection");
  });

  it("renders the markdown summary cleanly", () => {
    const summary = renderTestDesignMarkdown({
      schemaVersion: "1.0.0",
      ticket: { key: "X-1", title: "T" },
      outputMode: "gherkin",
      acceptanceCriteria: [],
      strategySummary: "",
      coverageGaps: [],
      scenarios: [],
      acCoverageMatrix: [],
      riskRanking: [],
      openQuestions: [],
      provenance: {
        generatedAt: "2024-01-01T00:00:00.000Z",
        issueKey: "X-1",
        llm: { provider: "anthropic", model: "stub" },
        tools: [],
      },
      warnings: [],
    });
    expect(summary).toContain("# Test Design — X-1: T");
    expect(summary).toContain("Output mode: `gherkin`");
  });
});

describe("runDesignTests (library form) end-to-end with mock LLM", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-design-cli-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("runs Researcher + Test Architect and writes both packs + .feature files", async () => {
    const provider = stubProvider();
    const llm = stubLlm({ acResponse: AC_JSON, gherkinResponse: GHERKIN_JSON });

    const result = await runDesignTests({ issueKey: "DESIGN-1", outDir: workDir, provider, llm });

    expect(result.context.acceptanceCriteria).toHaveLength(2);
    expect(result.testDesign?.scenarios).toHaveLength(2);
    expect(result.testDesignFiles?.featurePaths).toHaveLength(1);
  });

  it("falls back to ContextPack-only when no LLM is provided", async () => {
    const provider = stubProvider();

    const result = await runDesignTests({ issueKey: "DESIGN-2", outDir: workDir, provider });

    expect(result.context.acceptanceCriteria).toBeUndefined();
    expect(result.testDesign).toBeUndefined();
    expect(result.testDesignFiles).toBeUndefined();
  });
});

describe("buildGherkinDesignPrompt — existing test-case dedup", () => {
  // A story that links one Xray Test issue, so the Researcher fills
  // context.xrayTestCases with it.
  function providerWithLinkedTest(): ContextProvider {
    const linkedTestKey = "QATG-9001";
    return {
      getSourceName: () => "jira-rest",
      getIssue: async (key) => {
        if (key === linkedTestKey) {
          return {
            ticket: {
              key: linkedTestKey,
              title: "Customer logs in with valid credentials",
              labels: [],
              components: [],
              links: [],
              status: "Active",
              issueType: "Test",
            },
            description: { format: "text", text: "Existing Xray test." },
            comments: [],
            linkedIssues: [],
          };
        }
        return {
          ticket: {
            key,
            title: "Instalment plan selection at checkout",
            labels: ["billing"],
            components: ["Checkout"],
            links: [],
            status: "In Progress",
            issueType: "Story",
          },
          description: { format: "text", text: "Customers should be able to choose a 3-instalment plan." },
          comments: [],
          linkedIssues: [
            {
              issueKey: linkedTestKey,
              title: "Customer logs in with valid credentials",
              issueType: "Test",
              relationship: "is tested by",
              direction: "inward",
            },
          ],
        };
      },
      getComments: async () => [],
      getAttachments: async () => [],
      getLinkedIssues: async () => [],
      getDevelopmentLinks: async () => ({ branches: [], pullRequests: [] }),
      getConfluencePages: async () => [],
      getProvenance: () => [],
      getWarnings: () => [],
      close: async () => undefined,
    };
  }

  it("lists linked Xray tests in the dedup section with the acsCoveredByExisting instruction", async () => {
    const context = await runResearcher({ issueKey: "QATG-2940", provider: providerWithLinkedTest() });
    expect(context.xrayTestCases.map((t) => t.key)).toContain("QATG-9001");

    const { userPrompt } = buildGherkinDesignPrompt({
      context,
      acceptanceCriteria: [{ id: "AC-1", text: "Customer can log in with valid credentials.", source: "description" }],
      skillBody: "Author Gherkin scenarios.",
    });

    expect(userPrompt).toContain("Existing test cases");
    expect(userPrompt).toContain("[xray QATG-9001]");
    expect(userPrompt).toContain("Customer logs in with valid credentials");
    expect(userPrompt).toContain("acsCoveredByExisting");
  });

  it("combines repo scenarios and linked Xray tests in the same dedup section", async () => {
    const context = await runResearcher({ issueKey: "QATG-2940", provider: providerWithLinkedTest() });

    const { userPrompt } = buildGherkinDesignPrompt({
      context,
      acceptanceCriteria: [{ id: "AC-1", text: "Customer can log in.", source: "description" }],
      skillBody: "Author Gherkin scenarios.",
      stepLibrary: {
        steps: [],
        scenarios: [{ title: "Returning customer reaches the dashboard", feature: "Login", outline: false }],
        featureFileCount: 1,
        totalSteps: 0,
      },
    });

    expect(userPrompt).toContain("[repo] Scenario: Returning customer reaches the dashboard");
    expect(userPrompt).toContain("[xray QATG-9001]");
  });

  it("omits the dedup section entirely when there are no existing tests", async () => {
    const context = await runResearcher({ issueKey: "ABC-NONE", provider: stubProvider() });

    const { userPrompt } = buildGherkinDesignPrompt({
      context,
      acceptanceCriteria: [{ id: "AC-1", text: "Something.", source: "description" }],
      skillBody: "Author Gherkin scenarios.",
    });

    expect(userPrompt).not.toContain("Existing test cases");
  });
});
