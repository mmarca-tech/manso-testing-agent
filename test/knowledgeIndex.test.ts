import { describe, expect, it } from "vitest";
import {
  KnowledgeIndex,
  buildKnowledgeIndex,
  chunkContext,
  freshnessKey,
  tokenize,
} from "../src/context/knowledgeIndex.js";
import type { ContextPack } from "../src/domain/contextPack/schema.js";

function context(overrides: Partial<ContextPack> = {}): ContextPack {
  const base: ContextPack = {
    schemaVersion: "1.0.0",
    ticket: { key: "QATG-1", title: "Instalments", labels: [], components: [], links: [] },
    description: {
      format: "text",
      text: "Customers can pay in three instalments when the order is eligible.\n\nIneligible orders never show the instalment option.",
    },
    comments: [{ id: "42", body: "Refunds must reverse the instalment schedule.", author: { name: "Jane" } }],
    attachments: [{ filename: "rules.txt", analysis: "Eligibility threshold is 100 EUR.", analysisSource: "text-extraction" }],
    xrayTestCases: [],
    relatedTickets: [{ key: "QATG-2", title: "Refunds epic", relationship: "epic", description: "Refund processing for instalment orders." }],
    development: { branches: [], pullRequests: [] },
    confluencePages: [{ id: "p1", title: "Spec", body: "The dashboard shows the payment schedule." }],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "QATG-1", source: "jira-rest", tools: [] },
    warnings: [],
  };
  return { ...base, ...overrides };
}

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and drops stopwords", () => {
    expect(tokenize("The customer CAN pay 3 instalments!")).toEqual(["customer", "pay", "instalments"]);
  });
});

describe("chunkContext", () => {
  it("chunks every evidence source with node-style ids and references", () => {
    const chunks = chunkContext(context());
    const sources = new Set(chunks.map((c) => c.source));
    expect(sources).toContain("description");
    expect(sources).toContain("comment:42");
    expect(sources).toContain("confluencePage:p1");
    expect(sources).toContain("relatedTicket:QATG-2");
    expect(sources).toContain("attachment:rules.txt");
    // The two-paragraph description splits into two chunks.
    expect(chunks.filter((c) => c.source === "description")).toHaveLength(2);
  });
});

describe("KnowledgeIndex.search", () => {
  it("ranks the chunk that matches the query terms highest", () => {
    const index = new KnowledgeIndex(chunkContext(context()));
    const results = index.search("reverse instalment schedule");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.chunk.source).toBe("comment:42");
  });

  it("returns citations with source, reference, and excerpt", () => {
    const index = buildKnowledgeIndex(context());
    const citations = index.searchCitations("eligibility threshold", 3);
    expect(citations[0]?.source).toBe("attachment:rules.txt");
    expect(citations[0]?.reference).toContain("rules.txt");
    expect(citations[0]?.excerpt).toContain("100 EUR");
  });

  it("returns nothing for an empty query or no term matches", () => {
    const index = new KnowledgeIndex(chunkContext(context()));
    expect(index.search("")).toEqual([]);
    expect(index.search("kubernetes helm chart")).toEqual([]);
  });
});

describe("buildKnowledgeIndex caching", () => {
  it("returns the same instance for the same context (freshness key hit)", () => {
    const ctx = context({ ticket: { key: "QATG-CACHE", title: "T", labels: [], components: [], links: [] } });
    const first = buildKnowledgeIndex(ctx);
    const second = buildKnowledgeIndex(ctx);
    expect(second).toBe(first);
  });

  it("rebuilds when the context changes", () => {
    const a = context({ ticket: { key: "QATG-A", title: "T", labels: [], components: [], links: [] } });
    const b = context({
      ticket: { key: "QATG-A", title: "T", labels: [], components: [], links: [] },
      comments: [
        { id: "42", body: "Refunds must reverse the instalment schedule.", author: { name: "Jane" } },
        { id: "43", body: "Another comment.", author: { name: "Joe" } },
      ],
    });
    expect(freshnessKey(a)).not.toBe(freshnessKey(b));
    expect(buildKnowledgeIndex(b)).not.toBe(buildKnowledgeIndex(a));
  });
});
