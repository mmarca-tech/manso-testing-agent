import { describe, expect, it } from "vitest";
import {
  runCoverageGapAnalyser,
  formatAnalysisAsComment,
  type CoverageGapAnalysis,
} from "../src/agents/coverageGapAnalyser/index.js";
import type { ContextPack } from "../src/domain/contextPack/schema.js";
import type { LinkedCucumberTest } from "../src/integrations/xray/testFetch.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import type { TestScenario } from "../src/domain/testDesignPack/schema.js";

function stubContext(overrides?: Partial<ContextPack>): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "TEST-1", title: "User can reset password", labels: [], components: [], links: [] },
    description: { format: "text", text: "As a user I want to reset my password via email." },
    comments: [],
    attachments: [],
    xrayTestCases: [],
    development: { branches: [], pullRequests: [] },
    confluencePages: [],
    acceptanceCriteria: [
      { id: "AC-1", text: "User receives a reset email within 60 seconds" },
      { id: "AC-2", text: "Reset link expires after 24 hours" },
      { id: "AC-3", text: "Invalid email shows a helpful error" },
    ],
    provenance: { generatedAt: new Date().toISOString(), issueKey: "TEST-1", source: "jira-rest", tools: [] },
    warnings: [],
    ...overrides,
  } as ContextPack;
}

function stubLinkedTests(): LinkedCucumberTest[] {
  return [
    {
      key: "TEST-10",
      summary: "User receives reset email",
      gherkin: `Scenario: User receives reset email
  Given the user has a registered account
  When they request a password reset
  Then they receive a reset email within 60 seconds`,
    },
  ];
}

const ANALYSIS_RESPONSE_PARTIAL = JSON.stringify({
  summary: "Only 1 of 3 acceptance criteria is covered. Missing edge cases for link expiry and invalid email.",
  rating: "partial",
  uncoveredCriteria: [
    { criterion: "Reset link expires after 24 hours", impact: "Security vulnerability if link never expires" },
    { criterion: "Invalid email shows a helpful error", impact: "Poor UX for mistyped emails" },
  ],
  gaps: [
    { area: "Link Expiry", description: "No test verifies that the link becomes invalid after 24h", priority: "high" },
    { area: "Error Handling", description: "No negative test for invalid/unknown email addresses", priority: "medium" },
  ],
});

const ANALYSIS_RESPONSE_GOOD = JSON.stringify({
  summary: "All acceptance criteria are well covered with both positive and negative scenarios.",
  rating: "good",
  uncoveredCriteria: [],
  gaps: [],
});

const SCENARIO_GEN_RESPONSE = JSON.stringify({
  scenarios: [
    {
      kind: "gherkin",
      title: "Reset link expires after 24 hours",
      feature: "Password Reset",
      tags: ["@security"],
      acIds: ["AC-2"],
      risk: "high",
      readiness: "ready",
      objective: "Verify that the password reset link cannot be used after 24 hours",
      preconditions: ["User has requested a password reset"],
      steps: [
        { keyword: "Given", text: "a user requested a password reset 25 hours ago" },
        { keyword: "When", text: "they click the reset link" },
        { keyword: "Then", text: "they see an error that the link has expired" },
      ],
      sourceEvidence: [{ source: "coverage-gap-analysis", reference: "Link Expiry", summary: "AC-2 not covered" }],
      openQuestions: [],
      rationale: "Covers the 24h expiry acceptance criterion which has no existing test.",
    },
    {
      kind: "gherkin",
      title: "Invalid email shows helpful error message",
      feature: "Password Reset",
      tags: ["@negative"],
      acIds: ["AC-3"],
      risk: "medium",
      readiness: "ready",
      objective: "Verify error handling for non-registered email addresses",
      preconditions: [],
      steps: [
        { keyword: "Given", text: "a user is on the password reset page" },
        { keyword: "When", text: "they enter an unregistered email address" },
        { keyword: "Then", text: "they see a message saying no account exists for that email" },
      ],
      sourceEvidence: [{ source: "coverage-gap-analysis", reference: "Error Handling", summary: "AC-3 not covered" }],
      openQuestions: [],
      rationale: "Covers the invalid email error handling acceptance criterion.",
    },
  ],
});

function llmFromQueue(queue: Array<(req: LlmTextGenerationRequest) => string>): LlmTextClient {
  let index = 0;
  return {
    provider: "anthropic",
    model: "stub-model",
    toolName: "stub:test",
    async generateText(request: LlmTextGenerationRequest): Promise<string> {
      const handler = queue[index++];
      if (!handler) {
        throw new Error(`Stub LLM ran out of responses at call ${index}`);
      }
      return handler(request);
    },
  };
}

describe("runCoverageGapAnalyser", () => {
  it("identifies coverage gaps and generates new scenarios", async () => {
    const llm = llmFromQueue([
      () => ANALYSIS_RESPONSE_PARTIAL,
      () => SCENARIO_GEN_RESPONSE,
    ]);

    const result = await runCoverageGapAnalyser({
      context: stubContext(),
      linkedTests: stubLinkedTests(),
      llm,
    });

    expect(result.analysis.rating).toBe("partial");
    expect(result.analysis.uncoveredCriteria).toHaveLength(2);
    expect(result.analysis.gaps).toHaveLength(2);
    expect(result.newScenarios).toHaveLength(2);
    expect(result.newScenarios[0]!.title).toBe("Reset link expires after 24 hours");
    expect(result.warnings).toHaveLength(0);
  });

  it("feeds the linked tests' existing step phrasings into scenario generation (avoids duplicate steps)", async () => {
    let scenarioPrompt = "";
    const llm = llmFromQueue([
      () => ANALYSIS_RESPONSE_PARTIAL,
      (req) => {
        scenarioPrompt = req.userPrompt;
        return SCENARIO_GEN_RESPONSE;
      },
    ]);

    await runCoverageGapAnalyser({
      context: stubContext(),
      linkedTests: stubLinkedTests(),
      llm,
    });

    expect(scenarioPrompt).toContain("Existing step phrasings");
    expect(scenarioPrompt).toContain("Given the user has a registered account");
    expect(scenarioPrompt).toContain("When they request a password reset");
    expect(scenarioPrompt).toContain("Then they receive a reset email within 60 seconds");
  });

  it("returns no new scenarios when coverage is good", async () => {
    const llm = llmFromQueue([
      () => ANALYSIS_RESPONSE_GOOD,
    ]);

    const result = await runCoverageGapAnalyser({
      context: stubContext(),
      linkedTests: stubLinkedTests(),
      llm,
    });

    expect(result.analysis.rating).toBe("good");
    expect(result.analysis.gaps).toHaveLength(0);
    expect(result.newScenarios).toHaveLength(0);
  });

  it("handles unparseable LLM response gracefully", async () => {
    const llm = llmFromQueue([
      () => "This is not valid JSON at all {{{",
    ]);

    const result = await runCoverageGapAnalyser({
      context: stubContext(),
      linkedTests: stubLinkedTests(),
      llm,
    });

    expect(result.analysis.rating).toBe("partial");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]!.section).toBe("coverageGapAnalysis");
  });

  it("works with no linked tests (empty coverage)", async () => {
    const llm = llmFromQueue([
      () => JSON.stringify({
        summary: "No tests exist for this story.",
        rating: "poor",
        uncoveredCriteria: [
          { criterion: "All acceptance criteria", impact: "No automated testing at all" },
        ],
        gaps: [
          { area: "Full Story", description: "No tests linked", priority: "high" },
        ],
      }),
      () => SCENARIO_GEN_RESPONSE,
    ]);

    const result = await runCoverageGapAnalyser({
      context: stubContext(),
      linkedTests: [],
      llm,
    });

    expect(result.analysis.rating).toBe("poor");
    expect(result.newScenarios.length).toBeGreaterThan(0);
  });
});

describe("formatAnalysisAsComment", () => {
  it("formats a partial coverage analysis as Jira wiki markup", () => {
    const analysis: CoverageGapAnalysis = {
      summary: "Coverage is partial — missing edge cases.",
      rating: "partial",
      uncoveredCriteria: [
        { criterion: "Link expires after 24h", impact: "Security risk" },
      ],
      gaps: [
        { area: "Expiry", description: "No expiry test", priority: "high" },
      ],
    };
    const scenarios: TestScenario[] = [{
      kind: "gherkin",
      title: "Test link expiry",
      feature: "Password Reset",
      tags: [],
      acIds: ["AC-2"],
      risk: "high",
      readiness: "ready",
      objective: "Verify link expires",
      preconditions: [],
      steps: [
        { keyword: "Given", text: "a link older than 24h" },
        { keyword: "When", text: "user clicks it" },
        { keyword: "Then", text: "it shows expired" },
      ],
      sourceEvidence: [{ source: "gap", reference: "x", summary: "y" }],
      openQuestions: [],
      rationale: "fills gap",
    }];

    const comment = formatAnalysisAsComment(analysis, scenarios);
    const json = JSON.stringify(comment);

    // It's a valid ADF document, not wiki markup stuffed in a text node.
    expect(comment.type).toBe("doc");
    expect(comment.version).toBe(1);
    expect(json).not.toContain("h2.");
    expect(json).not.toContain("||");
    expect(json).toContain("Coverage Gap Analysis");
    expect(json).toContain("PARTIAL");
    expect(json).toContain("Link expires after 24h");
    expect(json).toContain("Expiry");
    expect(json).toContain("Test link expiry");
    expect(json).toContain("Manso coverage gap analysis");
  });

  it("formats a good coverage result with an ADF success panel", () => {
    const analysis: CoverageGapAnalysis = {
      summary: "All good.",
      rating: "good",
      uncoveredCriteria: [],
      gaps: [],
    };

    const comment = formatAnalysisAsComment(analysis, []);
    const json = JSON.stringify(comment);

    expect(comment.type).toBe("doc");
    expect(json).toContain("GOOD");
    expect(json).toContain("panel");
    expect(json).toContain("success");
    expect(json).toContain("No gaps identified");
  });
});
