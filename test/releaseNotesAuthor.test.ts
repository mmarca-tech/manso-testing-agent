import { describe, expect, it } from "vitest";
import { authorReleaseNotes, formatReleaseNotesAsComment } from "../src/agents/releaseNotesAuthor/index.js";
import { ReleaseNotesSchema } from "../src/domain/releaseNotes/schema.js";
import type { ContextPack } from "../src/domain/contextPack/schema.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";

function stubContext(key: string, title: string, description = "Some description."): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key, title, labels: [], components: [], links: [] },
    description: { format: "text", text: description },
    comments: [],
    attachments: [],
    xrayTestCases: [],
    development: { branches: [], pullRequests: [] },
    confluencePages: [],
    provenance: { generatedAt: new Date().toISOString(), issueKey: key, source: "jira-rest", tools: [] },
    warnings: [],
  } as ContextPack;
}

function stubLlm(response: string | (() => string)): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(_req: LlmTextGenerationRequest): Promise<string> {
      return typeof response === "function" ? response() : response;
    },
  };
}

const GOOD_RESPONSE = JSON.stringify({
  title: "October Release",
  audience: "customers",
  summary: "This release improves login reliability and speeds up checkout.",
  highlights: ["Faster checkout", "More reliable login"],
  changeItems: [{ area: "Checkout", description: "Reduced checkout latency." }],
  deploymentNotes: ["No action required."],
  testingNotes: ["Smoke-tested in staging."],
  knownRisks: [],
  ticketSummaries: [{ key: "PROJ-1", title: "Speed up checkout", summary: "Checkout latency reduced." }],
});

describe("authorReleaseNotes", () => {
  it("parses per-ticket release entries and action items when the LLM returns them", async () => {
    const releaseContext = stubContext("REL-5", "Release Ticket");
    const linkedTickets = [{ contextPack: stubContext("PROJ-1", "Speed up checkout"), prUnderstandings: [] }];
    const response = JSON.stringify({
      ...JSON.parse(GOOD_RESPONSE),
      releaseEntries: [{ key: "PROJ-1", section: "maintenance", description: "Faster checkout.", why: null }],
      actionNeeded: ["Clear cached checkout settings."],
    });

    const { notes, fallbackReason } = await authorReleaseNotes({ releaseContext, linkedTickets, llm: stubLlm(response) });

    expect(fallbackReason).toBeUndefined();
    expect(notes.releaseEntries).toEqual([
      { key: "PROJ-1", section: "maintenance", description: "Faster checkout.", why: null, insufficientContext: false },
    ]);
    expect(notes.actionNeeded).toEqual(["Clear cached checkout settings."]);
  });

  it("produces a schema-valid ReleaseNotes on a well-formed LLM response", async () => {
    const releaseContext = stubContext("REL-1", "October Release Ticket");
    const linkedTickets = [{ contextPack: stubContext("PROJ-1", "Speed up checkout"), prUnderstandings: [] }];

    const { notes, fallbackReason } = await authorReleaseNotes({ releaseContext, linkedTickets, llm: stubLlm(GOOD_RESPONSE) });

    expect(fallbackReason).toBeUndefined();
    expect(() => ReleaseNotesSchema.parse(notes)).not.toThrow();
    expect(notes.title).toBe("October Release");
    expect(notes.ticketSummaries[0]?.key).toBe("PROJ-1");
  });

  it("falls back to buildFallbackReleaseNotes when the LLM throws", async () => {
    const releaseContext = stubContext("REL-2", "Release Ticket");
    const linkedTickets = [
      { contextPack: stubContext("PROJ-2", "Fix bug"), prUnderstandings: [] },
    ];
    const llm: LlmTextClient = {
      provider: "anthropic",
      model: "stub",
      toolName: "stub:test",
      async generateText(): Promise<string> {
        throw new Error("LLM unavailable");
      },
    };

    const { notes, fallbackReason } = await authorReleaseNotes({ releaseContext, linkedTickets, llm });

    expect(() => ReleaseNotesSchema.parse(notes)).not.toThrow();
    expect(notes.title).toBe("Release Ticket");
    expect(fallbackReason).toContain("LLM unavailable");
    expect(notes.audience).toBe("internal");
    expect(notes.changeItems).toEqual([{ area: "Fix bug", description: "Fix bug" }]);
  });

  it("falls back when the LLM response is not valid JSON matching the schema", async () => {
    const releaseContext = stubContext("REL-3", "Release Ticket");
    const linkedTickets = [{ contextPack: stubContext("PROJ-3", "Some ticket"), prUnderstandings: [] }];

    const { notes, fallbackReason } = await authorReleaseNotes({
      releaseContext,
      linkedTickets,
      llm: stubLlm("not valid json"),
    });

    expect(() => ReleaseNotesSchema.parse(notes)).not.toThrow();
    expect(fallbackReason).toBeDefined();
    expect(notes.title).toBe("Release Ticket");
  });
});

describe("formatReleaseNotesAsComment", () => {
  it("produces an ADF document with the expected structural shape", async () => {
    const releaseContext = stubContext("REL-4", "Release Ticket");
    const linkedTickets = [{ contextPack: stubContext("PROJ-4", "Ticket title"), prUnderstandings: [] }];
    const { notes } = await authorReleaseNotes({ releaseContext, linkedTickets, llm: stubLlm(GOOD_RESPONSE) });

    const doc = formatReleaseNotesAsComment({
      notes,
      releaseMetadata: { version: "2026.10", dateFrom: "2026-10-01", dateTo: "2026-10-14", contributors: ["Dev One"] },
      teamTemplate: {
        newFeatures: [
          {
            ticketKey: "PROJ-4",
            ticketUrl: "https://jira.example/browse/PROJ-4",
            description: "Faster checkout.",
            productAffected: ["Checkout"],
            insufficientContext: true,
          },
        ],
        maintenance: [],
        bugFixes: [],
      },
      excludedTickets: [{ key: "PROJ-5", title: "Half done", reason: "Not done (status: In Progress)." }],
    });

    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(doc.content[0]?.type).toBe("heading");
    expect(doc.content[doc.content.length - 1]?.type).toBe("paragraph");
    expect(doc.content.some((node) => node.type === "rule")).toBe(true);
    // Metadata table + New Features table; empty sections are omitted.
    expect(doc.content.filter((node) => node.type === "table")).toHaveLength(2);
    const json = JSON.stringify(doc);
    expect(json).toContain('"href":"https://jira.example/browse/PROJ-4"');
    expect(json).toContain("from 2026-10-01 till 2026-10-14");
    expect(json).toContain("Needs context");
    expect(json).toContain("PROJ-5");
    expect(json).not.toContain("Bug fixes");
  });
});
