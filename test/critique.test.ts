import { describe, expect, it } from "vitest";
import { critiqueDesign } from "../src/agents/testArchitect/critique.js";
import type { ContextPack, ToolProvenance, Warning } from "../src/domain/contextPack/schema.js";
import type { GherkinScenario, TestScenario } from "../src/domain/testDesignPack/schema.js";
import type { LlmTextClient } from "../src/integrations/llm/types.js";

function context(): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "CRIT-1", title: "Story", labels: [], components: [], links: [] },
    description: { format: "text", text: "Login flow." },
    comments: [],
    attachments: [],
    xrayTestCases: [],
    development: { branches: [], pullRequests: [] },
    confluencePages: [],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "CRIT-1", source: "jira-rest", tools: [] },
    warnings: [],
  };
}

function drafted(title: string): GherkinScenario {
  return {
    kind: "gherkin", title, feature: "Login", tags: ["@login"], acIds: ["AC-1"], risk: "high", readiness: "ready",
    objective: "verify", preconditions: [], polarity: "positive",
    steps: [{ keyword: "Given", text: "a user" }, { keyword: "When", text: "x" }, { keyword: "Then", text: "y" }],
    sourceEvidence: [], openQuestions: [], rationale: "",
  };
}

function llm(response: string): LlmTextClient {
  return { provider: "anthropic", model: "stub", toolName: "stub:test", async generateText() { return response; } };
}

describe("critiqueDesign (M22c)", () => {
  it("adds a missing negative scenario and drops a duplicate of an existing one", async () => {
    const response = JSON.stringify({
      gaps: ["needs rate-limit clarification"],
      openQuestions: ["what is the lockout threshold?"],
      scenarios: [
        // duplicate by title → dropped
        { title: "Sign in with valid credentials", feature: "Login", tags: ["@login"], acIds: ["AC-1"], polarity: "positive", risk: "high", readiness: "ready", objective: "o", preconditions: [], steps: [{ keyword: "Given", text: "a" }, { keyword: "When", text: "b" }, { keyword: "Then", text: "c" }], sourceEvidence: [], openQuestions: [], rationale: "" },
        // genuinely new negative scenario → kept
        { title: "Reject invalid password", feature: "Login", tags: ["@login"], acIds: ["AC-1"], polarity: "negative", risk: "high", readiness: "ready", objective: "o", preconditions: [], steps: [{ keyword: "Given", text: "a" }, { keyword: "When", text: "b" }, { keyword: "Then", text: "c" }], sourceEvidence: [], openQuestions: [], rationale: "" },
      ],
    });
    const warnings: Warning[] = [];
    const provenance: ToolProvenance[] = [];
    const result = await critiqueDesign({
      mode: "gherkin",
      context: context(),
      acceptanceCriteria: [{ id: "AC-1", text: "Login works" }],
      derivedRequirements: [],
      skillBody: "skill",
      draftedScenarios: [drafted("Sign in with valid credentials") as TestScenario],
      llm: llm(response),
      toolProvenance: provenance,
      warnings,
    });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.title).toBe("Reject invalid password");
    expect(result.scenarios[0]?.polarity).toBe("negative");
    expect(result.coverageGaps).toContain("needs rate-limit clarification");
    expect(result.openQuestions).toContain("what is the lockout threshold?");
  });

  it("is resilient: returns empty and warns on malformed JSON", async () => {
    const warnings: Warning[] = [];
    const result = await critiqueDesign({
      mode: "gherkin",
      context: context(),
      acceptanceCriteria: [],
      derivedRequirements: [],
      skillBody: "skill",
      draftedScenarios: [],
      llm: llm("nonsense"),
      toolProvenance: [],
      warnings,
    });
    expect(result.scenarios).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
