import { describe, expect, it } from "vitest";
import { extractDerivedRequirements } from "../src/agents/testArchitect/derivedRequirements.js";
import type { ContextPack, ToolProvenance, Warning } from "../src/domain/contextPack/schema.js";
import type { LlmTextClient } from "../src/integrations/llm/types.js";

function context(): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "REQ-1", title: "Story", labels: [], components: [], links: [] },
    description: { format: "text", text: "Users can transfer money between accounts." },
    comments: [],
    attachments: [],
    xrayTestCases: [],
    development: { branches: [], pullRequests: [] },
    confluencePages: [],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "REQ-1", source: "jira-rest", tools: [] },
    warnings: [],
  };
}

function stubLlm(response: string | (() => never)): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(): Promise<string> {
      if (typeof response === "function") return response();
      return response;
    },
  };
}

describe("extractDerivedRequirements (M22a)", () => {
  it("parses derived requirements and renumbers ids DR-1..", async () => {
    const llm = stubLlm(
      JSON.stringify([
        { id: "DR-9", text: "Transfer of more than the balance is rejected", category: "error", risk: "high", sourceEvidence: [{ source: "description", reference: "p1", summary: "transfer implies balance check" }] },
        { id: "DR-7", text: "Zero-amount transfer is rejected", category: "boundary", risk: "medium", sourceEvidence: [] },
      ]),
    );
    const provenance: ToolProvenance[] = [];
    const warnings: Warning[] = [];
    const drs = await extractDerivedRequirements({ context: context(), acceptanceCriteria: [{ id: "AC-1", text: "Money moves" }], llm, toolProvenance: provenance, warnings });

    expect(drs.map((d) => d.id)).toEqual(["DR-1", "DR-2"]);
    expect(drs[0]?.category).toBe("error");
    expect(drs[0]?.risk).toBe("high");
    expect(provenance.at(-1)?.success).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("is resilient: returns [] and warns on a thrown LLM error", async () => {
    const warnings: Warning[] = [];
    const drs = await extractDerivedRequirements({
      context: context(),
      acceptanceCriteria: [],
      llm: stubLlm(() => { throw new Error("boom"); }),
      toolProvenance: [],
      warnings,
    });
    expect(drs).toEqual([]);
    expect(warnings.some((w) => w.message.includes("skipped"))).toBe(true);
  });

  it("is resilient: returns [] and warns on malformed JSON", async () => {
    const warnings: Warning[] = [];
    const drs = await extractDerivedRequirements({
      context: context(),
      acceptanceCriteria: [],
      llm: stubLlm("not json at all"),
      toolProvenance: [],
      warnings,
    });
    expect(drs).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
