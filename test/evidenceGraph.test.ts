import { describe, expect, it } from "vitest";
import { buildEvidenceGraph } from "../src/context/evidenceGraph.js";
import { ContextPackSchema, type ContextPack } from "../src/domain/contextPack/schema.js";

function sampleContext(overrides: Partial<ContextPack> = {}): ContextPack {
  const base: ContextPack = {
    schemaVersion: "1.0.0",
    ticket: {
      key: "QATG-1",
      title: "Instalment plan selection",
      labels: [],
      components: [],
      links: [],
      issueType: "Story",
      status: "In Progress",
    },
    description: { format: "text", text: "Body" },
    comments: [{ id: "42", body: "A comment", author: { name: "Jane" } }],
    attachments: [{ filename: "mockup.png", mimeType: "image/png" }],
    xrayTestCases: [{ key: "QATG-900", title: "Existing test", labels: [] }],
    relatedTickets: [{ key: "QATG-2", title: "Parent epic", issueType: "Epic", relationship: "epic" }],
    development: {
      branches: [{ name: "feature/instalments", repository: "checkout-web" }],
      pullRequests: [{ title: "Add instalments", url: "https://dev.azure.com/pr/7" }],
    },
    confluencePages: [{ id: "p1", title: "Spec page" }],
    acceptanceCriteria: [
      { id: "AC-1", text: "Customer can select a plan", source: "description" },
      { id: "AC-2", text: "Ineligible orders hide it", source: "comment:42" },
    ],
    provenance: {
      generatedAt: "2024-01-01T00:00:00.000Z",
      issueKey: "QATG-1",
      source: "jira-rest",
      tools: [],
    },
    warnings: [],
  };
  return { ...base, ...overrides };
}

describe("buildEvidenceGraph", () => {
  it("creates a ticket node and links every evidence kind", () => {
    const graph = buildEvidenceGraph(sampleContext());

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    expect(nodeIds).toContain("ticket:QATG-1");
    expect(nodeIds).toContain("requirement:AC-1");
    expect(nodeIds).toContain("requirement:AC-2");
    expect(nodeIds).toContain("comment:42");
    expect(nodeIds).toContain("confluencePage:p1");
    expect(nodeIds).toContain("ticket:QATG-2");
    expect(nodeIds).toContain("xrayTest:QATG-900");
    expect(nodeIds).toContain("attachment:mockup.png");
    expect(nodeIds).toContain("branch:feature/instalments");
    expect(nodeIds).toContain("pullRequest:https://dev.azure.com/pr/7");

    const edgeKeys = new Set(graph.edges.map((e) => `${e.from}|${e.type}|${e.to}`));
    expect(edgeKeys).toContain("ticket:QATG-1|specifies|requirement:AC-1");
    expect(edgeKeys).toContain("ticket:QATG-1|discussedIn|comment:42");
    expect(edgeKeys).toContain("ticket:QATG-1|documentedBy|confluencePage:p1");
    expect(edgeKeys).toContain("ticket:QATG-1|epic|ticket:QATG-2");
    expect(edgeKeys).toContain("ticket:QATG-1|coveredBy|xrayTest:QATG-900");
    expect(edgeKeys).toContain("ticket:QATG-1|hasAttachment|attachment:mockup.png");
    expect(edgeKeys).toContain("ticket:QATG-1|implementedIn|branch:feature/instalments");
    expect(edgeKeys).toContain("ticket:QATG-1|implementedIn|pullRequest:https://dev.azure.com/pr/7");
  });

  it("draws requirement evidence edges to the source node", () => {
    const graph = buildEvidenceGraph(sampleContext());
    const edgeKeys = new Set(graph.edges.map((e) => `${e.from}|${e.type}|${e.to}`));
    // AC-1 came from the description → evidenced by the ticket itself.
    expect(edgeKeys).toContain("requirement:AC-1|evidencedBy|ticket:QATG-1");
    // AC-2 came from comment:42 → evidenced by that comment node.
    expect(edgeKeys).toContain("requirement:AC-2|evidencedBy|comment:42");
  });

  it("omits requirement nodes when no acceptance criteria are present", () => {
    const graph = buildEvidenceGraph(sampleContext({ acceptanceCriteria: undefined }));
    expect(graph.nodes.some((n) => n.type === "requirement")).toBe(false);
    expect(graph.nodes.some((n) => n.id === "ticket:QATG-1")).toBe(true);
  });

  it("is idempotent — rebuilding yields the same node and edge counts", () => {
    const context = sampleContext();
    const first = buildEvidenceGraph(context);
    const second = buildEvidenceGraph({ ...context, evidenceGraph: first });
    expect(second.nodes).toHaveLength(first.nodes.length);
    expect(second.edges).toHaveLength(first.edges.length);
  });

  it("produces a graph that validates against the ContextPack schema", () => {
    const context = sampleContext();
    const withGraph = { ...context, evidenceGraph: buildEvidenceGraph(context) };
    expect(() => ContextPackSchema.parse(withGraph)).not.toThrow();
  });
});
