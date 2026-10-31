import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalyseCoverage } from "../src/cli/analyseCoverage.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { XrayCloudClient } from "../src/integrations/xray/client.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";

function stubProvider(): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => ({
      ticket: { key, title: `Story ${key}`, labels: [], components: [], links: [], status: "Open", issueType: "Story" },
      description: { format: "text", text: "As a user I want to reset my password." },
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

/** LLM router: returns a payload per operation so AC extraction, analysis, and scenario-gen all resolve. */
function routerLlm(): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(req: LlmTextGenerationRequest): Promise<string> {
      switch (req.operation) {
        case "extract-acceptance-criteria":
          return JSON.stringify([{ id: "AC-1", text: "User can reset password" }]);
        case "coverage-gap-analysis":
          return JSON.stringify({
            summary: "Partial coverage.",
            rating: "partial",
            uncoveredCriteria: [{ criterion: "Link expiry", impact: "Security" }],
            gaps: [{ area: "Expiry", description: "No expiry test", priority: "high" }],
          });
        case "coverage-gap-scenario-gen":
          return JSON.stringify({
            scenarios: [
              {
                kind: "gherkin",
                title: "Reset link expires after 24 hours",
                feature: "Password Reset",
                tags: ["@security"],
                acIds: ["AC-1"],
                risk: "high",
                readiness: "ready",
                objective: "Verify link expiry",
                preconditions: [],
                steps: [
                  { keyword: "Given", text: "a link older than 24h" },
                  { keyword: "When", text: "the user clicks it" },
                  { keyword: "Then", text: "they see an expired error" },
                ],
                sourceEvidence: [{ source: "coverage-gap-analysis", reference: "Expiry", summary: "AC-1" }],
                openQuestions: [],
                rationale: "Fills the expiry gap",
              },
            ],
          });
        default:
          throw new Error(`Unexpected LLM operation: ${req.operation}`);
      }
    },
  };
}

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Captured {
  commentBodies: unknown[];
  issueLinkBodies: any[];
}

function buildFetchFn(captured: Captured): typeof fetch {
  return vi.fn<typeof fetch>(async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (u.includes("/api/v2/authenticate")) return mockResponse("xray-token");
    if (u.includes("/api/v2/graphql")) {
      const query = String(body?.query ?? "");
      if (query.includes("getTests")) {
        return mockResponse({
          data: { getTests: { results: [
            { issueId: "1", jira: { key: "TEST-10", summary: "Existing reset test" }, testType: { name: "Cucumber" }, gherkin: "Scenario: Existing reset test\n  Given x\n  When y\n  Then z" },
          ] } },
        });
      }
      // createTest
      return mockResponse({ data: { createTest: { test: { issueId: "10001", jira: { key: "NEW-1" } }, warnings: [] } } });
    }
    if (u.includes("/rest/api/3/issueLinkType")) {
      return mockResponse({ issueLinkTypes: [{ id: "1", name: "Test", inward: "is tested by", outward: "tests" }] });
    }
    if (u.includes("/rest/api/3/issueLink")) {
      captured.issueLinkBodies.push(body);
      return mockResponse({}, 201);
    }
    if (u.includes("/comment")) {
      captured.commentBodies.push(body);
      return mockResponse({ id: "10100" }, 201);
    }
    if (u.includes("/rest/api/3/issue/")) {
      // issuelinks (one linked Test Case)
      return mockResponse({ fields: { issuelinks: [
        { type: { name: "Test" }, outwardIssue: { key: "TEST-10", fields: { issuetype: { name: "Test Case" }, summary: "Existing reset test" } } },
      ] } });
    }
    return mockResponse({ error: `unhandled ${u}` }, 500);
  });
}

describe("runAnalyseCoverage (integration)", () => {
  let outDir: string;
  beforeEach(async () => { outDir = await mkdtemp(join(tmpdir(), "manso-cov-")); });
  afterEach(async () => { await rm(outDir, { recursive: true, force: true }); });

  it("posts an ADF comment and creates a correctly-linked Xray test", async () => {
    const captured: Captured = { commentBodies: [], issueLinkBodies: [] };
    const fetchFn = buildFetchFn(captured);
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });

    const result = await runAnalyseCoverage({
      issueKey: "TEST-1",
      outDir,
      provider: stubProvider(),
      llm: routerLlm(),
      jira,
      xray,
      postComment: true,
      createTests: true,
      dryRun: false,
      linkTypeName: "is tested by",
      linkDirection: "test-to-ticket",
    });

    expect(result.analysisRating).toBe("partial");
    expect(result.commentPosted).toBe(true);
    expect(result.newScenariosCreated).toBe(1);

    // Comment posted as a proper ADF document (not wiki markup in a text node).
    expect(captured.commentBodies).toHaveLength(1);
    const commentPayload = captured.commentBodies[0] as { body: { type: string; version: number } };
    expect(commentPayload.body.type).toBe("doc");
    expect(commentPayload.body.version).toBe(1);

    // The created test is linked so the STORY shows "is tested by": the test is
    // the inwardIssue, the story the outwardIssue.
    expect(captured.issueLinkBodies).toHaveLength(1);
    const link = captured.issueLinkBodies[0];
    expect(link.type.name).toBe("Test");
    expect(link.inwardIssue.key).toBe("NEW-1");
    expect(link.outwardIssue.key).toBe("TEST-1");
  });
});
