import { describe, expect, it } from "vitest";
import { runAgenticRetrieval } from "../src/agents/researcher/agenticRetrieval.js";
import { buildKnowledgeIndex } from "../src/context/knowledgeIndex.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import type { ContextPack, Warning } from "../src/domain/contextPack/schema.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";

function context(): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: {
      key: "QATG-1",
      title: "Instalments",
      labels: [],
      components: [],
      links: [
        { direction: "outward", relationship: "epic", issueKey: "QATG-2", title: "Refunds epic", issueType: "Epic" },
        { direction: "outward", relationship: "tests", issueKey: "QATG-9", title: "A test", issueType: "Test" },
      ],
    },
    description: { format: "text", text: "Customers can pay in three instalments when eligible." },
    comments: [{ id: "42", body: "Refunds must reverse the instalment schedule.", author: { name: "Jane" } }],
    attachments: [],
    xrayTestCases: [],
    development: { branches: [], pullRequests: [] },
    confluencePages: [],
    acceptanceCriteria: [{ id: "AC-1", text: "Eligible orders can pay in instalments.", source: "description" }],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "QATG-1", source: "jira-rest", tools: [] },
    warnings: [],
  };
}

/** A stub provider that returns a body for the epic and tracks getIssue calls. */
function provider(calls: string[]): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => {
      calls.push(key);
      return {
        ticket: { key, title: "Refunds epic", labels: [], components: [], links: [] },
        description: { format: "text", text: "Refund processing for instalment orders." },
        comments: [],
        linkedIssues: [],
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

/** Replays a scripted sequence of tool-call JSON strings. */
function scriptedLlm(script: string[]): LlmTextClient {
  let i = 0;
  return {
    provider: "openai",
    model: "stub",
    toolName: "stub:agentic",
    async generateText(_req: LlmTextGenerationRequest) {
      return script[i++] ?? '{"tool":"finish","args":{}}';
    },
  };
}

describe("runAgenticRetrieval", () => {
  it("drives search_context, expand_ticket, and finish; collects citations + related tickets", async () => {
    const ctx = context();
    const calls: string[] = [];
    const warnings: Warning[] = [];
    const result = await runAgenticRetrieval({
      context: ctx,
      index: buildKnowledgeIndex(ctx),
      provider: provider(calls),
      llm: scriptedLlm([
        '{"tool":"search_context","args":{"query":"reverse instalment schedule","topK":3}}',
        '{"tool":"expand_ticket","args":{"key":"QATG-2"}}',
        '{"tool":"finish","args":{}}',
      ]),
      warnings,
    });

    expect(result.retrievalCitations.some((c) => c.source === "comment:42")).toBe(true);
    expect(result.addedRelatedTickets.map((r) => r.key)).toEqual(["QATG-2"]);
    expect(calls).toEqual(["QATG-2"]);
    expect(result.steps.at(-1)?.tool).toBe("finish");
    expect(warnings).toEqual([]);
  });

  it("refuses to expand a key that is not an available linked ticket (e.g. a Test)", async () => {
    const ctx = context();
    const calls: string[] = [];
    const result = await runAgenticRetrieval({
      context: ctx,
      index: buildKnowledgeIndex(ctx),
      provider: provider(calls),
      llm: scriptedLlm([
        '{"tool":"expand_ticket","args":{"key":"QATG-9"}}',
        '{"tool":"finish","args":{}}',
      ]),
      warnings: [],
    });
    expect(result.addedRelatedTickets).toEqual([]);
    expect(calls).toEqual([]);
    expect(result.steps[0]?.observation).toContain("not an available linked ticket");
  });

  it("stops at the step budget and records a warning when the model never finishes", async () => {
    const ctx = context();
    const warnings: Warning[] = [];
    const alwaysSearch: LlmTextClient = {
      provider: "openai",
      model: "stub",
      toolName: "stub:agentic",
      async generateText() {
        return '{"tool":"search_context","args":{"query":"instalments"}}';
      },
    };
    const result = await runAgenticRetrieval({
      context: ctx,
      index: buildKnowledgeIndex(ctx),
      provider: provider([]),
      llm: alwaysSearch,
      warnings,
      maxSteps: 2,
    });
    expect(result.steps).toHaveLength(2);
    expect(warnings.some((w) => w.section === "agenticResearch" && /budget/.test(w.message))).toBe(true);
  });

  it("tolerates unparseable model output without crashing", async () => {
    const ctx = context();
    const result = await runAgenticRetrieval({
      context: ctx,
      index: buildKnowledgeIndex(ctx),
      provider: provider([]),
      llm: scriptedLlm(["not json at all", '{"tool":"finish","args":{}}']),
      warnings: [],
    });
    expect(result.steps[0]?.tool).toBe("unknown");
    expect(result.steps[1]?.tool).toBe("finish");
  });
});
