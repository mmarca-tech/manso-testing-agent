import { describe, expect, it } from "vitest";
import { runResearcher } from "../src/agents/researcher/index.js";
import { auditCoverage, auditRiskCoverage } from "../src/agents/coverageAuditor/index.js";
import { runTestArchitect } from "../src/agents/testArchitect/index.js";
import type { RiskCoverageEntry } from "../src/domain/testDesignPack/schema.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import { CliError } from "../src/shared/cli.js";

const TWO_ACS = JSON.stringify([
  { id: "AC-1", text: "Customer can choose a 3-instalment plan.", source: "description" },
  { id: "AC-2", text: "Ineligible orders never see the plan.", source: "description" },
]);

function scenario(acIds: string[], risk: "high" | "medium" | "low" = "medium"): unknown {
  return {
    title: `Scenario covering ${acIds.join(",")}`,
    feature: "F",
    tags: [...acIds.map((id) => `@${id}`), `@${risk}`],
    acIds,
    risk,
    readiness: "ready",
    objective: "Verify behaviour.",
    preconditions: [],
    steps: [
      { keyword: "Given", text: "a precondition" },
      { keyword: "When", text: "an action happens" },
      { keyword: "Then", text: "an outcome is observed" },
    ],
    sourceEvidence: [{ source: "description", reference: "x", summary: "y" }],
    openQuestions: [],
    rationale: "Direct coverage.",
  };
}

function design(strategySummary: string, acIdsLists: string[][]): string {
  return JSON.stringify({
    strategySummary,
    coverageGaps: [],
    openQuestions: [],
    scenarios: acIdsLists.map((acIds) => scenario(acIds)),
  });
}

function stubProvider(): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => ({
      ticket: { key, title: "T", labels: [], components: [], links: [], status: "In Progress", issueType: "Story" },
      description: { format: "text", text: "Description body." },
      comments: [],
      linkedIssues: [],
    }),
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

function llmFromQueue(queue: Array<(request: LlmTextGenerationRequest) => string>): LlmTextClient {
  let index = 0;
  return {
    provider: "anthropic",
    model: "stub-model",
    toolName: "stub:test",
    async generateText(request: LlmTextGenerationRequest): Promise<string> {
      const handler = queue[index++];
      if (!handler) {
        throw new Error(`Stub LLM ran out of responses at call ${index} (operation: ${request.operation ?? "?"})`);
      }
      return handler(request);
    },
  };
}

describe("auditCoverage (pure)", () => {
  it("passes when every AC is covered", () => {
    const result = auditCoverage({
      gate: "required",
      testDesign: {
        acCoverageMatrix: [
          { acId: "AC-1", scenarioIndexes: [0] },
          { acId: "AC-2", scenarioIndexes: [1] },
        ],
      },
    });
    expect(result).toEqual({ status: "pass", uncoveredAcIds: [] });
  });

  it("flags uncovered ACs as failed under the required gate", () => {
    const result = auditCoverage({
      gate: "required",
      testDesign: {
        acCoverageMatrix: [
          { acId: "AC-1", scenarioIndexes: [0] },
          { acId: "AC-2", scenarioIndexes: [] },
        ],
      },
    });
    expect(result).toEqual({ status: "failed", uncoveredAcIds: ["AC-2"] });
  });

  it("treats externally-covered ACs as covered (no failure, no retry)", () => {
    const result = auditCoverage({
      gate: "required",
      testDesign: {
        acCoverageMatrix: [
          { acId: "AC-1", scenarioIndexes: [0] },
          { acId: "AC-2", scenarioIndexes: [] },
        ],
      },
      coveredExternally: ["AC-2"],
    });
    expect(result).toEqual({ status: "pass", uncoveredAcIds: [] });
  });

  it("downgrades uncovered ACs to warned under the warn gate", () => {
    const result = auditCoverage({
      gate: "warn",
      testDesign: { acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [] }] },
    });
    expect(result).toEqual({ status: "warned", uncoveredAcIds: ["AC-1"] });
  });

  it("passes silently when the gate is off", () => {
    const result = auditCoverage({
      gate: "off",
      testDesign: { acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [] }] },
    });
    expect(result).toEqual({ status: "pass", uncoveredAcIds: ["AC-1"] });
  });
});

describe("runTestArchitect — coverage gate", () => {
  it("retries the Gherkin pass scoped to uncovered ACs and succeeds when the retry covers them", async () => {
    const context = await runResearcher({ issueKey: "GATE-1", provider: stubProvider() });
    const llm = llmFromQueue([
      () => TWO_ACS,                                          // AC extraction
      () => design("First pass — only AC-1.", [["AC-1"]]),    // first design pass misses AC-2
      () => design("Retry — cover AC-2.", [["AC-2"]]),         // retry covers AC-2
    ]);

    const { testDesign } = await runTestArchitect({ context, llm, acCoverageGate: "required" });

    expect(testDesign.scenarios).toHaveLength(2);
    expect(testDesign.acCoverageMatrix).toEqual([
      { acId: "AC-1", scenarioIndexes: [0] },
      { acId: "AC-2", scenarioIndexes: [1] },
    ]);
  });

  it("throws CliError when the required gate is breached even after the retry", async () => {
    const context = await runResearcher({ issueKey: "GATE-2", provider: stubProvider() });
    const llm = llmFromQueue([
      () => TWO_ACS,                                            // AC extraction
      () => design("First pass — only AC-1.", [["AC-1"]]),      // misses AC-2
      () => design("Retry — still only AC-1.", [["AC-1"]]),     // retry still misses
    ]);

    await expect(runTestArchitect({ context, llm, acCoverageGate: "required" })).rejects.toBeInstanceOf(CliError);
  });

  it("under the warn gate, returns successfully and records the uncovered ACs", async () => {
    const context = await runResearcher({ issueKey: "GATE-3", provider: stubProvider() });
    const llm = llmFromQueue([
      () => TWO_ACS,
      () => design("First pass — only AC-1.", [["AC-1"]]),
      () => design("Retry — still only AC-1.", [["AC-1"]]),
    ]);

    const { testDesign } = await runTestArchitect({ context, llm, acCoverageGate: "warn" });
    expect(testDesign.openQuestions.join(" ")).toContain("AC-2");
    expect(testDesign.warnings.some((w) => w.section === "acCoverage")).toBe(true);
  });

  it("under the off gate, skips the retry entirely", async () => {
    const context = await runResearcher({ issueKey: "GATE-4", provider: stubProvider() });
    const llm = llmFromQueue([
      () => TWO_ACS,
      () => design("First pass — only AC-1.", [["AC-1"]]),
      // intentionally only two queued; if a retry happens this would throw
    ]);

    const { testDesign } = await runTestArchitect({ context, llm, acCoverageGate: "off" });
    expect(testDesign.scenarios).toHaveLength(1);
  });
});

describe("auditRiskCoverage (M22)", () => {
  const entry = (over: Partial<RiskCoverageEntry> = {}): RiskCoverageEntry => ({
    targetId: "AC-1",
    targetKind: "ac",
    risk: "high",
    scenarioIndexes: [0],
    negativeOrBoundaryScenarioIndexes: [],
    satisfied: false,
    ...over,
  });

  it("passes when every target is satisfied", () => {
    const result = auditRiskCoverage({
      riskCoverageMatrix: [entry({ satisfied: true, negativeOrBoundaryScenarioIndexes: [1] })],
      gate: "required",
    });
    expect(result.status).toBe("pass");
    expect(result.unsatisfied).toHaveLength(0);
  });

  it("warns (not fails) on an unsatisfied target when gate is warn", () => {
    const result = auditRiskCoverage({ riskCoverageMatrix: [entry()], gate: "warn" });
    expect(result.status).toBe("warned");
    expect(result.unsatisfied[0]?.targetId).toBe("AC-1");
    expect(result.unsatisfied[0]?.reason).toContain("negative or boundary");
  });

  it("fails on an unsatisfied target when gate is required", () => {
    const result = auditRiskCoverage({ riskCoverageMatrix: [entry()], gate: "required" });
    expect(result.status).toBe("failed");
  });

  it("never flags anything when gate is off", () => {
    const result = auditRiskCoverage({ riskCoverageMatrix: [entry()], gate: "off" });
    expect(result.status).toBe("pass");
    expect(result.unsatisfied).toHaveLength(0);
  });

  it("reports an uncovered derived requirement distinctly", () => {
    const result = auditRiskCoverage({
      riskCoverageMatrix: [entry({ targetId: "DR-1", targetKind: "derived", risk: "low", scenarioIndexes: [] })],
      gate: "warn",
    });
    expect(result.unsatisfied[0]?.reason).toContain("no covering scenario");
  });
});
