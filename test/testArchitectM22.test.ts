import { describe, expect, it } from "vitest";
import { runResearcher } from "../src/agents/researcher/index.js";
import { runTestArchitect } from "../src/agents/testArchitect/index.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import { CliError } from "../src/shared/cli.js";

function stubProvider(): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => ({
      ticket: { key, title: "Transfer money", labels: [], components: [], links: [], status: "In Progress", issueType: "Story" },
      description: { format: "text", text: "Users transfer money between their accounts." },
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

const AC = JSON.stringify([{ id: "AC-1", text: "A user can transfer money.", source: "description" }]);
const DR_HIGH = JSON.stringify([
  { id: "DR-1", text: "Transfer above the available balance is rejected", category: "error", risk: "high", sourceEvidence: [{ source: "description", reference: "p1", summary: "transfer implies a balance check" }] },
]);

function gherkin(title: string, opts: { acIds?: string[]; drIds?: string[]; polarity?: string; risk?: string }): unknown {
  return {
    title, feature: "Transfers", tags: ["@transfers"],
    acIds: opts.acIds ?? ["AC-1"],
    ...(opts.drIds ? { drIds: opts.drIds } : {}),
    polarity: opts.polarity ?? "positive",
    risk: opts.risk ?? "high",
    readiness: "ready", objective: "verify", preconditions: [],
    steps: [{ keyword: "Given", text: "a user" }, { keyword: "When", text: "they transfer" }, { keyword: "Then", text: "it settles" }],
    sourceEvidence: [], openQuestions: [], rationale: "",
  };
}

function design(scenarios: unknown[]): string {
  return JSON.stringify({ strategySummary: "s", coverageGaps: [], openQuestions: [], acsCoveredByExisting: [], scenarios });
}

function critique(scenarios: unknown[], gaps: string[] = []): string {
  return JSON.stringify({ gaps, openQuestions: [], scenarios });
}

function queueLlm(map: Partial<Record<string, string>>): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(request: LlmTextGenerationRequest): Promise<string> {
      const op = request.operation ?? "";
      const response = map[op];
      if (response === undefined) throw new Error(`Unexpected operation: ${op}`);
      return response;
    },
  };
}

describe("runTestArchitect — M22 derive + critique + risk gate", () => {
  it("attaches derived requirements and a satisfied risk-coverage matrix (warn gate)", async () => {
    const context = await runResearcher({ issueKey: "REQ-1", provider: stubProvider() });
    const llm = queueLlm({
      "extract-acceptance-criteria": AC,
      "extract-derived-requirements": DR_HIGH,
      // AC-1 high risk gets a negative scenario; DR-1 covered by it too.
      "design-gherkin-scenarios": design([
        gherkin("Happy transfer", { polarity: "positive" }),
        gherkin("Reject overdraw", { drIds: ["DR-1"], polarity: "negative" }),
      ]),
      "critique-design": critique([]),
    });

    const { testDesign } = await runTestArchitect({
      context, llm, deriveRequirements: true, adversarialCritique: true, riskCoverageGate: "warn",
    });

    expect(testDesign.derivedRequirements?.map((d) => d.id)).toEqual(["DR-1"]);
    const matrix = testDesign.riskCoverageMatrix ?? [];
    expect(matrix.find((e) => e.targetId === "AC-1")?.satisfied).toBe(true);
    expect(matrix.find((e) => e.targetId === "DR-1")?.satisfied).toBe(true);
  });

  it("fails the required risk gate when a high-risk requirement has only positive coverage", async () => {
    const context = await runResearcher({ issueKey: "REQ-2", provider: stubProvider() });
    const llm = queueLlm({
      "extract-acceptance-criteria": AC,
      "extract-derived-requirements": DR_HIGH,
      "design-gherkin-scenarios": design([gherkin("Happy transfer", { drIds: ["DR-1"], polarity: "positive" })]),
      "critique-design": critique([]),
    });

    await expect(
      runTestArchitect({ context, llm, deriveRequirements: true, adversarialCritique: true, riskCoverageGate: "required" }),
    ).rejects.toThrow(CliError);
  });

  it("folds a missing scenario from the critique pass into the design", async () => {
    const context = await runResearcher({ issueKey: "REQ-3", provider: stubProvider() });
    const llm = queueLlm({
      "extract-acceptance-criteria": AC,
      "extract-derived-requirements": DR_HIGH,
      "design-gherkin-scenarios": design([
        gherkin("Happy transfer", { polarity: "positive" }),
        gherkin("Reject overdraw", { drIds: ["DR-1"], polarity: "negative" }),
      ]),
      "critique-design": critique([gherkin("Transfer to a closed account is rejected", { drIds: ["DR-1"], polarity: "negative" })]),
    });

    const { testDesign } = await runTestArchitect({
      context, llm, deriveRequirements: true, adversarialCritique: true, riskCoverageGate: "warn",
    });

    expect(testDesign.scenarios).toHaveLength(3);
    expect(testDesign.scenarios.some((s) => s.title === "Transfer to a closed account is rejected")).toBe(true);
  });

  it("behaves exactly as before when the passes are disabled (no derived/risk fields)", async () => {
    const context = await runResearcher({ issueKey: "REQ-4", provider: stubProvider() });
    const llm = queueLlm({
      "extract-acceptance-criteria": AC,
      "design-gherkin-scenarios": design([gherkin("Happy transfer", { polarity: "positive" })]),
    });

    const { testDesign } = await runTestArchitect({ context, llm });
    expect(testDesign.derivedRequirements).toBeUndefined();
    expect(testDesign.riskCoverageMatrix).toBeUndefined();
  });
});
