import { describe, expect, it } from "vitest";
import type {
  Attachment,
  Comment,
  ConfluencePage,
  Development,
  TicketLink,
  ToolProvenance,
  Warning,
} from "../src/domain/contextPack/schema.js";
import type { ReleaseNotes } from "../src/domain/releaseNotes/schema.js";
import { ReleaseNotesPackSchema } from "../src/domain/releaseNotes/schema.js";
import type { NormalizedIssue } from "../src/domain/tickets/normalizedIssue.js";
import { renderReleaseNotesMarkdown } from "../src/output/release-notes/renderer.js";
import { extractReleaseNotes } from "../src/workflows/release-notes/extractor.js";
import type { ReleaseNotesInput, ReleaseNotesSummarizer } from "../src/workflows/release-notes/summarizer.js";
import type { TicketSource } from "../src/workflows/ticket-context/ticketSource.js";

describe("extractReleaseNotes", () => {
  it("extracts linked ticket context and creates a validated release notes pack", async () => {
    const pack = await extractReleaseNotes("ITSM-1234", new FakeTicketSource(), new FakeReleaseNotesSummarizer());

    expect(ReleaseNotesPackSchema.parse(pack)).toEqual(pack);
    expect(pack.releaseTicket.key).toBe("ITSM-1234");
    expect(pack.linkedTickets).toHaveLength(2);
    expect(pack.linkedTickets[0]?.context.description.text).toContain("Checkout should reject expired cards");
    expect(pack.linkedTickets[0]?.context.confluencePages[0]?.title).toBe("Checkout Release Design");
    expect(pack.linkedTickets[0]?.context.development.pullRequests[0]?.title).toBe("Validate expired cards");
    expect(pack.notes.ticketSummaries.map((item) => item.key)).toEqual(["PAY-1", "PAY-2"]);
    expect(renderReleaseNotesMarkdown(pack)).not.toContain("## Included Tickets");
    expect(renderReleaseNotesMarkdown(pack)).not.toContain("Development Notes");
    expect(renderReleaseNotesMarkdown(pack)).not.toContain("PAY-1: Expired card validation");
    expect(renderReleaseNotesMarkdown(pack)).not.toContain("Tickets:");
  });

  it("can cap linked ticket extraction", async () => {
    const pack = await extractReleaseNotes("ITSM-1234", new FakeTicketSource(), new FakeReleaseNotesSummarizer(), {
      maxLinkedTickets: 1,
    });

    expect(pack.linkedTickets.map((item) => item.context.ticket.key)).toEqual(["PAY-1"]);
    expect(pack.warnings.some((warning) => warning.message.includes("Limited linked ticket extraction to 1 of 2"))).toBe(true);
  });
});

class FakeTicketSource implements TicketSource {
  async getIssue(issueKey: string): Promise<NormalizedIssue> {
    const issue = issues[issueKey];
    if (!issue) {
      throw new Error(`Unexpected issue ${issueKey}`);
    }

    return issue;
  }

  async getComments(issueKey: string): Promise<Comment[]> {
    return issueKey === "PAY-1" ? [{ body: "Support asked for a visible decline reason.", createdAt: "2026-05-01T10:00:00.000Z" }] : [];
  }

  async getAttachments(): Promise<Attachment[]> {
    return [];
  }

  async getLinkedIssues(issueKey: string): Promise<TicketLink[]> {
    return issues[issueKey]?.linkedIssues ?? [];
  }

  async getDevelopmentLinks(issueKey: string): Promise<Development> {
    if (issueKey === "PAY-1") {
      return {
        branches: [{ name: "feature/PAY-1-expired-cards", repository: "payments-api", provider: "azure-devops" }],
        pullRequests: [{ title: "Validate expired cards", status: "COMPLETED", repository: "payments-api" }],
      };
    }

    if (issueKey === "PAY-2") {
      return {
        branches: [],
        pullRequests: [{ title: "Update retry copy", status: "ACTIVE", repository: "checkout-ui" }],
      };
    }

    return { branches: [], pullRequests: [] };
  }

  async getConfluencePages(issueKey: string): Promise<ConfluencePage[]> {
    return issueKey === "PAY-1"
      ? [
          {
            id: "123",
            title: "Checkout Release Design",
            url: "https://example.atlassian.net/wiki/spaces/PAY/pages/123",
            body: "Expired cards must show a specific decline message.",
          },
        ]
      : [];
  }

  getSourceName(): "jira-rest" {
    return "jira-rest";
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "getIssue", toolName: "jira:test", calledAt: "2026-05-02T12:00:00.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }

  async close(): Promise<void> {
    return undefined;
  }
}

class FakeReleaseNotesSummarizer implements ReleaseNotesSummarizer {
  readonly provider = "test-llm";
  readonly model = "test-model";

  async summarize(input: ReleaseNotesInput): Promise<ReleaseNotes> {
    expect(input.releaseContext.ticket.key).toBe("ITSM-1234");
    expect(input.linkedTickets[0]?.context.confluencePages).toHaveLength(1);
    expect(input.linkedTickets[0]?.context.development.pullRequests).toHaveLength(1);

    return {
      title: "Release Notes for ITSM-1234",
      audience: "Release stakeholders",
      summary: "Checkout validation and retry messaging are included in this release.",
      highlights: ["Expired card validation is now explicit.", "Retry copy is clearer."],
      changeItems: [
        {
          area: "Checkout",
          description: "Expired card validation and retry messaging were updated.",
          impact: "Customers receive clearer checkout feedback.",
          tickets: input.linkedTickets.map((item) => item.context.ticket.key),
        },
      ],
      deploymentNotes: ["No migration noted in the source tickets."],
      testingNotes: ["Verify expired card decline messaging."],
      knownRisks: ["PAY-2 is still active."],
      ticketSummaries: input.linkedTickets.map(({ relationship, context }) => ({
        key: context.ticket.key,
        title: context.ticket.title,
        ...(context.ticket.issueType ? { issueType: context.ticket.issueType } : {}),
        ...(context.ticket.status ? { status: context.ticket.status } : {}),
        ...(relationship ? { relationship } : {}),
        summary: context.description.text,
        risks: [],
        testingNotes: [],
      })),
    };
  }

  getProvenance(): ToolProvenance[] {
    return [{ method: "generateReleaseNotes", toolName: "llm:test", calledAt: "2026-05-02T12:00:01.000Z", success: true }];
  }

  getWarnings(): Warning[] {
    return [];
  }
}

const issues: Record<string, NormalizedIssue> = {
  "ITSM-1234": {
    ticket: {
      key: "ITSM-1234",
      title: "May checkout release",
      issueType: "Release",
      status: "Ready for Release",
      labels: [],
      components: ["Checkout"],
      links: [
        { direction: "outward", relationship: "includes", issueKey: "PAY-1", title: "Expired card validation", issueType: "Story" },
        { direction: "outward", relationship: "includes", issueKey: "PAY-2", title: "Retry message copy", issueType: "Bug" },
      ],
    },
    description: {
      format: "text",
      text: "Release for checkout improvements.",
    },
    comments: [],
    linkedIssues: [
      { direction: "outward", relationship: "includes", issueKey: "PAY-1", title: "Expired card validation", issueType: "Story" },
      { direction: "outward", relationship: "includes", issueKey: "PAY-2", title: "Retry message copy", issueType: "Bug" },
    ],
  },
  "PAY-1": {
    ticket: {
      key: "PAY-1",
      title: "Expired card validation",
      issueType: "Story",
      status: "Done",
      labels: ["checkout"],
      components: ["Payments"],
      links: [],
    },
    description: {
      format: "text",
      text: "Checkout should reject expired cards with a clear decline reason.",
    },
    comments: [],
    linkedIssues: [],
  },
  "PAY-2": {
    ticket: {
      key: "PAY-2",
      title: "Retry message copy",
      issueType: "Bug",
      status: "Active",
      labels: ["checkout"],
      components: ["Checkout UI"],
      links: [],
    },
    description: {
      format: "text",
      text: "Checkout retry messages should explain when the user can try again.",
    },
    comments: [],
    linkedIssues: [],
  },
};
