import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runResearcher } from "../src/agents/researcher/index.js";
import { runDesignTests } from "../src/cli/designTests.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import { ContextPackSchema } from "../src/domain/contextPack/schema.js";
import { renderMarkdown } from "../src/output/context-pack/renderer.js";
import { writeContextPack } from "../src/output/context-pack/writer.js";

interface StubOverrides extends Partial<ContextProvider> {}

function stubProvider(overrides: StubOverrides = {}): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key) => ({
      ticket: {
        key,
        title: `Title ${key}`,
        labels: ["billing"],
        components: ["Checkout"],
        links: [],
        status: "In Progress",
        issueType: "Story",
      },
      description: { format: "text", text: "Description body" },
      comments: [],
      linkedIssues: [],
    }),
    getComments: async () => [
      { id: "c1", body: "first comment", createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    getAttachments: async () => [],
    getLinkedIssues: async () => [],
    getDevelopmentLinks: async () => ({ branches: [], pullRequests: [] }),
    getConfluencePages: async () => [],
    getProvenance: () => [
      {
        method: "getIssue",
        toolName: "jira-rest:issue",
        calledAt: "2024-01-01T00:00:00.000Z",
        success: true,
      },
    ],
    getWarnings: () => [],
    close: async () => undefined,
    ...overrides,
  };
}

describe("runResearcher", () => {
  it("assembles a valid ContextPack for a minimal ticket", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-1", provider });

    expect(context.ticket.key).toBe("ABC-1");
    expect(context.ticket.title).toBe("Title ABC-1");
    expect(context.comments.length).toBeGreaterThan(0);
    expect(context.provenance.source).toBe("jira-rest");
    expect(context.warnings).toEqual([]);
    expect(() => ContextPackSchema.parse(context)).not.toThrow();
  });

  it("captures a warning when an optional section fails", async () => {
    const provider = stubProvider({
      getDevelopmentLinks: async () => {
        throw new Error("dev info unavailable");
      },
    });

    const context = await runResearcher({ issueKey: "ABC-2", provider });
    expect(context.development).toEqual({ branches: [], pullRequests: [] });
    expect(context.warnings.some((warning) => warning.section === "development")).toBe(true);
  });

  it("propagates a hard failure from getIssue", async () => {
    const provider = stubProvider({
      getIssue: async () => {
        throw new Error("ticket not found");
      },
    });

    await expect(runResearcher({ issueKey: "ABC-9", provider })).rejects.toThrow(/ticket not found/);
  });

  it("includes Xray-type linked issues in xrayTestCases", async () => {
    const provider = stubProvider({
      getLinkedIssues: async () => [
        {
          direction: "outward",
          relationship: "tests",
          issueKey: "TEST-1",
          title: "Linked test case",
          issueType: "Test",
        },
      ],
      getIssue: async (key) => {
        if (key === "TEST-1") {
          return {
            ticket: { key: "TEST-1", title: "Linked test case", labels: [], components: [], links: [] },
            description: { format: "text", text: "" },
            comments: [],
            linkedIssues: [],
          };
        }
        return {
          ticket: { key, title: `Title ${key}`, labels: [], components: [], links: [] },
          description: { format: "text", text: "" },
          comments: [],
          linkedIssues: [],
        };
      },
    });

    const context = await runResearcher({ issueKey: "ABC-3", provider });
    expect(context.xrayTestCases).toHaveLength(1);
    expect(context.xrayTestCases[0]?.key).toBe("TEST-1");
  });

  it("expands non-test linked tickets into relatedTickets and excludes Tests", async () => {
    const provider = stubProvider({
      getLinkedIssues: async () => [
        { direction: "outward", relationship: "epic", issueKey: "EPIC-1", title: "Parent epic", issueType: "Epic" },
        { direction: "inward", relationship: "subtask", issueKey: "SUB-1", title: "Subtask", issueType: "Sub-task" },
        { direction: "outward", relationship: "relates to", issueKey: "STORY-2", title: "Sibling story", issueType: "Story" },
        { direction: "outward", relationship: "tests", issueKey: "TEST-9", title: "Linked test", issueType: "Test" },
      ],
      getIssue: async (key) => ({
        ticket: { key, title: `Title ${key}`, labels: [], components: [], links: [] },
        description: { format: "text", text: `Body of ${key}` },
        comments: [],
        linkedIssues: [],
      }),
    });

    const context = await runResearcher({ issueKey: "ABC-REL", provider });

    const relatedKeys = (context.relatedTickets ?? []).map((t) => t.key);
    expect(relatedKeys).toEqual(["EPIC-1", "SUB-1", "STORY-2"]);
    expect(relatedKeys).not.toContain("TEST-9");
    expect(context.relatedTickets?.find((t) => t.key === "EPIC-1")?.description).toBe("Body of EPIC-1");
    expect(context.relatedTickets?.find((t) => t.key === "EPIC-1")?.relationship).toBe("epic");
    // Tests still route to xrayTestCases.
    expect(context.xrayTestCases.map((t) => t.key)).toEqual(["TEST-9"]);
  });

  it("caps related-ticket expansion and records a warning instead of dropping silently", async () => {
    const provider = stubProvider({
      getLinkedIssues: async () => [
        { direction: "outward", relationship: "relates to", issueKey: "STORY-A", title: "A", issueType: "Story" },
        { direction: "outward", relationship: "relates to", issueKey: "STORY-B", title: "B", issueType: "Story" },
        { direction: "outward", relationship: "relates to", issueKey: "STORY-C", title: "C", issueType: "Story" },
      ],
      getIssue: async (key) => ({
        ticket: { key, title: `Title ${key}`, labels: [], components: [], links: [] },
        description: { format: "text", text: "" },
        comments: [],
        linkedIssues: [],
      }),
    });

    const context = await runResearcher({ issueKey: "ABC-CAP", provider, maxRelatedTickets: 1 });
    expect(context.relatedTickets).toHaveLength(1);
    expect(context.warnings.some((w) => w.section === "relatedTickets" && /capped/i.test(w.message))).toBe(true);
  });

  it("falls back to link metadata when a related ticket fetch fails", async () => {
    const provider = stubProvider({
      getLinkedIssues: async () => [
        { direction: "outward", relationship: "relates to", issueKey: "STORY-X", title: "Fallback story", issueType: "Story" },
      ],
      getIssue: async (key) => {
        if (key === "STORY-X") {
          throw new Error("story unavailable");
        }
        return {
          ticket: { key, title: `Title ${key}`, labels: [], components: [], links: [] },
          description: { format: "text", text: "" },
          comments: [],
          linkedIssues: [],
        };
      },
    });

    const context = await runResearcher({ issueKey: "ABC-FALLBACK", provider });
    expect(context.relatedTickets?.[0]?.key).toBe("STORY-X");
    expect(context.relatedTickets?.[0]?.title).toBe("Fallback story");
    expect(context.warnings.some((w) => w.section === "relatedTickets" && /STORY-X/.test(w.message))).toBe(true);
  });

  it("analyzes text attachments via the provider download seam", async () => {
    const provider = stubProvider({
      getAttachments: async () => [
        { id: "att1", filename: "instalment-rules.txt", mimeType: "text/plain", url: "https://jira.example/att1" },
        { id: "att2", filename: "mockup.png", mimeType: "image/png", url: "https://jira.example/att2" },
      ],
      fetchAttachmentContent: async (attachment) =>
        attachment.id === "att1"
          ? { data: new TextEncoder().encode("Orders over 100 EUR are eligible for 3 instalments."), mimeType: "text/plain" }
          : { data: new TextEncoder().encode("binary"), mimeType: "image/png" },
    });

    const context = await runResearcher({ issueKey: "ABC-ATT", provider });
    const text = context.attachments.find((a) => a.filename === "instalment-rules.txt");
    expect(text?.analysis).toContain("3 instalments");
    expect(text?.analysisSource).toBe("text-extraction");
    // Images are not analyzed in M10e-1.
    const image = context.attachments.find((a) => a.filename === "mockup.png");
    expect(image?.analysis).toBeUndefined();
  });

  it("skips related-ticket expansion when linkedTicketDepth is 0", async () => {
    const provider = stubProvider({
      getLinkedIssues: async () => [
        { direction: "outward", relationship: "epic", issueKey: "EPIC-1", title: "Parent epic", issueType: "Epic" },
      ],
      getIssue: async (key) => ({
        ticket: { key, title: `Title ${key}`, labels: [], components: [], links: [] },
        description: { format: "text", text: "body" },
        comments: [],
        linkedIssues: [],
      }),
    });

    const expanded = await runResearcher({ issueKey: "ABC-DEPTH1", provider });
    expect(expanded.relatedTickets ?? []).toHaveLength(1);

    const disabled = await runResearcher({ issueKey: "ABC-DEPTH0", provider, linkedTicketDepth: 0 });
    expect(disabled.relatedTickets ?? []).toEqual([]);
  });

  it("skips attachment content analysis when attachmentUnderstanding is false", async () => {
    let fetched = 0;
    const provider = stubProvider({
      getAttachments: async () => [
        { id: "a1", filename: "rules.txt", mimeType: "text/plain", url: "https://jira.example/a1" },
      ],
      fetchAttachmentContent: async () => {
        fetched += 1;
        return { data: new TextEncoder().encode("eligible over 100 EUR"), mimeType: "text/plain" };
      },
    });

    const off = await runResearcher({ issueKey: "ABC-ATT-OFF", provider, attachmentUnderstanding: false });
    expect(off.attachments[0]?.analysis).toBeUndefined();
    expect(fetched).toBe(0); // never downloaded

    const on = await runResearcher({ issueKey: "ABC-ATT-ON", provider });
    expect(on.attachments[0]?.analysis).toContain("100 EUR");
    expect(fetched).toBe(1);
  });

  it("attaches an evidence graph linking the ticket to related and xray nodes", async () => {
    const provider = stubProvider({
      getLinkedIssues: async () => [
        { direction: "outward", relationship: "epic", issueKey: "EPIC-1", title: "Parent epic", issueType: "Epic" },
        { direction: "outward", relationship: "tests", issueKey: "TEST-1", title: "Linked test", issueType: "Test" },
      ],
      getIssue: async (key) => ({
        ticket: { key, title: `Title ${key}`, labels: [], components: [], links: [] },
        description: { format: "text", text: "" },
        comments: [],
        linkedIssues: [],
      }),
    });

    const context = await runResearcher({ issueKey: "ABC-GRAPH", provider });
    expect(context.evidenceGraph).toBeDefined();
    const nodeIds = new Set((context.evidenceGraph?.nodes ?? []).map((n) => n.id));
    expect(nodeIds).toContain("ticket:ABC-GRAPH");
    expect(nodeIds).toContain("ticket:EPIC-1");
    expect(nodeIds).toContain("xrayTest:TEST-1");
    // Researcher runs before AC extraction, so there are no requirement nodes yet.
    expect((context.evidenceGraph?.nodes ?? []).some((n) => n.type === "requirement")).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("renders acceptance criteria when present", async () => {
    const provider = stubProvider();
    const base = await runResearcher({ issueKey: "ABC-4", provider });
    const context = {
      ...base,
      acceptanceCriteria: [
        { id: "AC-1", text: "Customer can select a plan", source: "description" },
        { id: "AC-2", text: "Plan amount is correct" },
      ],
    };

    const markdown = renderMarkdown(context);
    expect(markdown).toContain("## Acceptance Criteria");
    expect(markdown).toContain("**AC-1**: Customer can select a plan");
    expect(markdown).toContain("**AC-2**: Plan amount is correct");
  });

  it("omits the Acceptance Criteria section when none are present", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-5", provider });
    const markdown = renderMarkdown(context);
    expect(markdown).not.toContain("## Acceptance Criteria");
  });

  it("renders analyzed attachment content under the Attachments section", async () => {
    const provider = stubProvider();
    const base = await runResearcher({ issueKey: "ABC-ATT-MD", provider });
    const context = {
      ...base,
      attachments: [
        {
          filename: "rules.txt",
          mimeType: "text/plain",
          analysis: "Orders over 100 EUR are eligible.",
          analysisSource: "text-extraction" as const,
        },
      ],
    };
    const markdown = renderMarkdown(context);
    expect(markdown).toContain("### rules.txt (text-extraction)");
    expect(markdown).toContain("Orders over 100 EUR are eligible.");
  });

  it("renders a Related Tickets section when related tickets are present", async () => {
    const provider = stubProvider();
    const base = await runResearcher({ issueKey: "ABC-REL-MD", provider });
    const context = {
      ...base,
      relatedTickets: [
        { key: "EPIC-1", title: "Parent epic", issueType: "Epic", relationship: "epic", description: "Epic body" },
      ],
    };
    const markdown = renderMarkdown(context);
    expect(markdown).toContain("## Related Tickets");
    expect(markdown).toContain("### EPIC-1: Parent epic");
    expect(markdown).toContain("Epic body");
  });
});

describe("writeContextPack + runDesignTests", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-ctx-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes JSON and Markdown for a ContextPack", async () => {
    const provider = stubProvider();
    const context = await runResearcher({ issueKey: "ABC-7", provider });
    const result = await writeContextPack(context, workDir);

    expect(result.jsonPath).toContain("ABC-7");
    expect(result.markdownPath).toContain("ABC-7");

    const jsonRaw = await readFile(result.jsonPath, "utf8");
    const parsed = ContextPackSchema.parse(JSON.parse(jsonRaw));
    expect(parsed.ticket.key).toBe("ABC-7");

    const md = await readFile(result.markdownPath, "utf8");
    expect(md).toContain("# ABC-7: Title ABC-7");
    expect(md).toContain("## Description");
    expect(md).toContain("## Provenance");
  });

  it("sanitizes the issue key when used as a path segment", async () => {
    const provider = stubProvider({
      getIssue: async (key) => ({
        ticket: { key, title: "X", labels: [], components: [], links: [] },
        description: { format: "text", text: "" },
        comments: [],
        linkedIssues: [],
      }),
    });
    const context = await runResearcher({ issueKey: "ABC/1", provider });
    const result = await writeContextPack(context, workDir);
    expect(result.directory).not.toContain("/ABC/1/");
  });

  it("runDesignTests runs Researcher + writer end-to-end", async () => {
    const provider = stubProvider();
    const result = await runDesignTests({ issueKey: "ABC-8", outDir: workDir, provider });

    expect(result.context.ticket.key).toBe("ABC-8");
    const md = await readFile(result.markdownPath, "utf8");
    expect(md).toContain("ABC-8");
  });
});
