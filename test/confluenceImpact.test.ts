import { describe, expect, it } from "vitest";
import type { ContextPack, ConfluencePage, ToolProvenance, Warning } from "../src/domain/contextPack/schema.js";
import type { ConfluenceImpact } from "../src/domain/confluenceImpact/schema.js";
import { ConfluenceImpactPackSchema } from "../src/domain/confluenceImpact/schema.js";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { ConfluenceRestPageSource } from "../src/integrations/confluence/pageSource.js";
import { renderConfluenceImpactMarkdown } from "../src/output/confluence-impact/renderer.js";
import { extractConfluenceImpact } from "../src/workflows/confluence-impact/extractor.js";
import type { ConfluencePageSource } from "../src/workflows/confluence-impact/confluencePageSource.js";
import type { ConfluenceImpactInput, ConfluenceImpactSummarizer } from "../src/workflows/confluence-impact/summarizer.js";

describe("extractConfluenceImpact", () => {
  it("creates a validated Confluence impact pack from linked pages", async () => {
    const pack = await extractConfluenceImpact(contextPack(), new FakePageSource(), new FakeSummarizer(), {
      sourceContextPath: "out/PROJ-1/context.json",
    });

    expect(ConfluenceImpactPackSchema.parse(pack)).toEqual(pack);
    expect(pack.pages).toEqual([
      expect.objectContaining({
        page: expect.objectContaining({
          title: "Checkout Design",
          body: "Design page body",
        }),
        extraction: expect.objectContaining({
          contentSource: "confluence-rest",
          bodyAvailable: true,
        }),
        impact: expect.objectContaining({
          ticketRelevance: "Defines checkout validation constraints.",
        }),
      }),
    ]);
    expect(renderConfluenceImpactMarkdown(pack)).toContain("## Pages");
  });
});

describe("ConfluenceRestPageSource", () => {
  it("hydrates a linked page through Confluence REST and preserves the link", async () => {
    const calls: string[] = [];
    const source = new ConfluenceRestPageSource(
      new AtlassianRestClient({
        jira: { baseUrl: "https://example.atlassian.net", username: "user@example.com", apiToken: "token" },
        confluence: { baseUrl: "https://example.atlassian.net/wiki", username: "user@example.com", apiToken: "token" },
        fetchFn: async (input) => {
          const url = String(input);
          calls.push(url);

          if (url.includes("/rest/api/content/123?")) {
            return jsonResponse({
              id: "123",
              title: "Checkout Design",
              space: { key: "PAY" },
              _links: { base: "https://example.atlassian.net/wiki", webui: "/spaces/PAY/pages/123/Checkout+Design" },
              version: { when: "2026-05-01T10:00:00.000Z" },
              body: { storage: { value: "<p>Validate card failures.</p>" } },
            });
          }

          return jsonResponse({}, 404, "Not Found");
        },
      }),
    );

    const page = await source.getPage({
      title: "Old title",
      url: "https://example.atlassian.net/wiki/spaces/PAY/pages/123/Checkout+Design",
    });

    expect(page).toEqual(
      expect.objectContaining({
        id: "123",
        title: "Checkout Design",
        space: "PAY",
        body: "Validate card failures.",
        url: "https://example.atlassian.net/wiki/spaces/PAY/pages/123/Checkout+Design",
      }),
    );
    expect(calls.some((url) => url.includes("/rest/api/content/123?"))).toBe(true);
    expect(source.getProvenance().some((item) => item.success)).toBe(true);
  });
});

class FakePageSource implements ConfluencePageSource {
  async getPage(page: ConfluencePage): Promise<ConfluencePage> {
    return {
      ...page,
      body: "Design page body",
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "getPage", toolName: "confluence:test", calledAt: "2026-05-02T12:00:00.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

class FakeSummarizer implements ConfluenceImpactSummarizer {
  readonly provider = "test-llm";
  readonly model = "test-model";

  async summarize(input: ConfluenceImpactInput): Promise<ConfluenceImpact> {
    expect(input.context.ticket.key).toBe("PROJ-1");
    expect(input.page.body).toBe("Design page body");
    return {
      summary: "The design page explains checkout validation behavior.",
      ticketRelevance: "Defines checkout validation constraints.",
      impactedAreas: ["checkout validation"],
      decisionsOrConstraints: ["Invalid cards must be rejected."],
      risks: ["Mismatch between design and workflow validation."],
      testingNotes: ["Verify rejected card responses."],
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "summarizeConfluenceImpact", toolName: "llm:test", calledAt: "2026-05-02T12:00:01.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

function contextPack(): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: {
      key: "PROJ-1",
      title: "Checkout validation",
      labels: [],
      components: [],
      links: [],
    },
    description: {
      format: "text",
      text: "Checkout should reject invalid cards.",
    },
    comments: [],
    attachments: [],
    xrayTestCases: [{ key: "TEST-1", title: "Invalid card is rejected", labels: [] }],
    development: {
      branches: [],
      pullRequests: [],
    },
    confluencePages: [
      {
        id: "123",
        title: "Checkout Design",
        url: "https://example.atlassian.net/wiki/spaces/PAY/pages/123/Checkout+Design",
      },
    ],
    provenance: {
      generatedAt: "2026-05-02T12:00:00.000Z",
      issueKey: "PROJ-1",
      source: "jira-rest",
      tools: [],
    },
    warnings: [],
  };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}
