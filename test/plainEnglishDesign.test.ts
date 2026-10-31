import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runResearcher } from "../src/agents/researcher/index.js";
import { runTestArchitect } from "../src/agents/testArchitect/index.js";
import { renderManualTests } from "../src/output/test-design/renderer.js";
import { writeTestDesignPack } from "../src/output/test-design/writer.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import { TestDesignPackSchema } from "../src/domain/testDesignPack/schema.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import type { Skill } from "../src/skillLoader/types.js";

function stubProvider(): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => ({
      ticket: { key, title: "Login", labels: [], components: [], links: [], status: "In Progress", issueType: "Story" },
      description: { format: "text", text: "Users sign in with email + password. Invalid credentials are rejected." },
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

const skills: Skill[] = [
  { name: "acceptance-criteria-extraction", description: "", appliesTo: { phase: "design" }, body: "Extract ACs.", source: "packaged", path: "/skills/acceptance-criteria-extraction/SKILL.md" },
  { name: "gherkin-authoring", description: "", appliesTo: { phase: "design" }, body: "Author Gherkin.", source: "packaged", path: "/skills/gherkin-authoring/SKILL.md" },
  { name: "plain-english-test-authoring", description: "", appliesTo: { phase: "design" }, body: "Author manual tests.", source: "packaged", path: "/skills/plain-english-test-authoring/SKILL.md" },
];

const AC_JSON = JSON.stringify([
  { id: "AC-1", text: "User signs in with valid credentials.", source: "description" },
  { id: "AC-2", text: "Invalid credentials are rejected.", source: "description" },
]);

const PLAIN_JSON = JSON.stringify({
  strategySummary: "Manual coverage of the login paths.",
  coverageGaps: [],
  openQuestions: [],
  acsCoveredByExisting: [],
  scenarios: [
    {
      title: "Sign in with valid credentials",
      feature: "Login",
      tags: ["@login", "@high"],
      acIds: ["AC-1"],
      risk: "high",
      readiness: "ready",
      objective: "Verify a registered user can sign in.",
      preconditions: ["A registered account exists"],
      steps: [
        { action: "Open the sign-in page", expectedResult: "The email and password fields are shown" },
        { action: "Enter valid credentials and submit", expectedResult: "The dashboard loads" },
      ],
      sourceEvidence: [{ source: "description", reference: "p1", summary: "Users sign in with email + password." }],
      openQuestions: [],
      rationale: "Happy-path login.",
    },
    {
      title: "Reject invalid credentials",
      feature: "Login",
      tags: ["@login"],
      acIds: ["AC-2"],
      risk: "medium",
      readiness: "ready",
      objective: "Verify invalid credentials are rejected.",
      preconditions: [],
      steps: [{ action: "Submit a wrong password", expectedResult: "An error message is shown and login is denied" }],
      sourceEvidence: [{ source: "description", reference: "p1", summary: "Invalid credentials are rejected." }],
      openQuestions: [],
      rationale: "Negative path.",
    },
  ],
});

function stubLlm(acResponse: string, designResponse: string): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(request: LlmTextGenerationRequest): Promise<string> {
      if (request.operation === "extract-acceptance-criteria") return acResponse;
      return designResponse; // plain-english design pass
    },
  };
}

describe("Test Architect — plain-english mode", () => {
  it("produces plain-English scenarios with action/expected steps", async () => {
    const context = await runResearcher({ issueKey: "QATG-1", provider: stubProvider() });
    const { testDesign } = await runTestArchitect({
      context,
      llm: stubLlm(AC_JSON, PLAIN_JSON),
      skills,
      outputMode: "plain-english",
    });

    expect(testDesign.outputMode).toBe("plain-english");
    expect(testDesign.scenarios).toHaveLength(2);
    expect(testDesign.scenarios.every((s) => s.kind === "plain-english")).toBe(true);
    const first = testDesign.scenarios[0];
    if (first?.kind === "plain-english") {
      expect(first.steps[0]?.action).toContain("sign-in");
      expect(first.steps[0]?.expectedResult).toContain("fields");
    }
    // Tag conventions still enforced (no @high; @smoke derived for high risk).
    expect(testDesign.scenarios[0]?.tags).toContain("@login");
    expect(testDesign.scenarios[0]?.tags).toContain("@smoke");
    expect(testDesign.scenarios[0]?.tags).not.toContain("@high");
    // Coverage matrix works uniformly across kinds.
    expect(testDesign.acCoverageMatrix).toEqual([
      { acId: "AC-1", scenarioIndexes: [0] },
      { acId: "AC-2", scenarioIndexes: [1] },
    ]);
    expect(() => TestDesignPackSchema.parse(testDesign)).not.toThrow();
  });
});

describe("plain-english writer + renderer", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-pe-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes manual-tests.md (and no empty .feature) for a plain-english pack", async () => {
    const context = await runResearcher({ issueKey: "QATG-3", provider: stubProvider() });
    const { testDesign } = await runTestArchitect({
      context,
      llm: stubLlm(AC_JSON, PLAIN_JSON),
      skills,
      outputMode: "plain-english",
    });

    const result = await writeTestDesignPack(testDesign, workDir);
    expect(result.manualTestsPath).toBeDefined();
    expect(result.featurePaths).toHaveLength(0); // no gherkin → no .feature files
    const manual = await readFile(result.manualTestsPath!, "utf8");
    expect(manual).toContain("# Manual test cases — QATG-3");
    expect(manual).toContain("| # | Action | Expected result |");
    expect(manual).toContain("Open the sign-in page");
  });

  it("renderManualTests ignores gherkin scenarios", () => {
    const md = renderManualTests({
      ticketKey: "X-1",
      scenarios: [
        {
          kind: "gherkin",
          title: "g",
          feature: "F",
          tags: [],
          acIds: [],
          risk: "low",
          readiness: "ready",
          objective: "o",
          preconditions: [],
          steps: [{ keyword: "Given", text: "x" }],
          sourceEvidence: [],
          openQuestions: [],
          rationale: "",
        },
      ],
    });
    expect(md).toContain("_No manual test cases._");
  });
});
