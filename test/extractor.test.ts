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
import type { NormalizedIssue } from "../src/domain/tickets/normalizedIssue.js";
import type { TicketSource } from "../src/workflows/ticket-context/ticketSource.js";
import { extractTicketContext } from "../src/workflows/ticket-context/extractor.js";
import { ContextPackSchema } from "../src/domain/contextPack/schema.js";

describe("extractTicketContext", () => {
  it("extracts a complete ticket context pack from a ticket source", async () => {
    const source = new FakeTicketSource({
      issue: mainIssue(),
      comments: [
        {
          id: "c-2",
          author: { name: "Reviewer" },
          createdAt: "2026-04-03T12:00:00.000Z",
          body: "Please cover the regression scenario.",
        },
      ],
      attachments: [
        {
          id: "att-1",
          filename: "checkout-error.png",
          mimeType: "image/png",
          sizeBytes: 1200,
          url: "https://jira/attachment/att-1",
        },
      ],
      linkedIssues: [
        {
          direction: "outward",
          relationship: "tests",
          issueKey: "TEST-1",
          title: "Regression test",
          status: "Ready",
          issueType: "Test",
        },
      ],
      linkedIssueDetails: {
        "TEST-1": testIssue(),
      },
      development: {
        branches: [{ name: "feature/PROJ-1", repository: "checkout-api", url: "https://git/branch/1" }],
        pullRequests: [
          {
            title: "Implement checkout validation",
            status: "OPEN",
            url: "https://git/pr/7",
            repository: "checkout-api",
            sourceBranch: "feature/PROJ-1",
            targetBranch: "main",
            author: { name: "Dev" },
            lastUpdatedAt: "2026-04-04T10:00:00.000Z",
          },
        ],
      },
      confluencePages: [
        {
          id: "123",
          title: "Checkout Rules",
          space: "PAY",
          url: "https://wiki/pages/123",
          body: "Use the new validation path.",
        },
      ],
    });

    const context = await extractTicketContext("PROJ-1", source);

    expect(ContextPackSchema.parse(context)).toEqual(context);
    expect(context.provenance.source).toBe("jira-rest");
    expect(context.ticket.key).toBe("PROJ-1");
    expect(context.comments).toHaveLength(2);
    expect(context.attachments).toEqual([
      expect.objectContaining({
        filename: "checkout-error.png",
        mimeType: "image/png",
      }),
    ]);
    expect(context.xrayTestCases).toEqual([
      expect.objectContaining({
        key: "TEST-1",
        title: "Regression test",
        description: "Verify the validation path.",
      }),
    ]);
    expect(context.development.branches).toHaveLength(1);
    expect(context.development.pullRequests).toHaveLength(1);
    expect(context.confluencePages).toEqual([
      expect.objectContaining({
        id: "123",
        title: "Checkout Rules",
        body: "Use the new validation path.",
      }),
    ]);
    expect(context.warnings).toEqual([]);
  });

  it("keeps arrays empty when optional linked data is absent", async () => {
    const source = new FakeTicketSource({ issue: emptyIssue() });

    const context = await extractTicketContext("PROJ-2", source);

    expect(context.comments).toEqual([]);
    expect(context.attachments).toEqual([]);
    expect(context.xrayTestCases).toEqual([]);
    expect(context.development).toEqual({ branches: [], pullRequests: [] });
    expect(context.confluencePages).toEqual([]);
  });

  it("recognizes linked Xray tests with Jira issue type Test Case", async () => {
    const source = new FakeTicketSource({
      issue: emptyIssue(),
      linkedIssues: [
        {
          direction: "outward",
          relationship: "tests",
          issueKey: "RM-15993",
          title: "Customer lookup succeeds",
          status: "Resolved",
          issueType: "Test Case",
          url: "https://jira/rest/api/3/issue/2553918",
        },
      ],
      linkedIssueDetails: {
        "RM-15993": testCaseIssue(),
      },
    });

    const context = await extractTicketContext("PROJ-2", source);

    expect(context.xrayTestCases).toEqual([
      expect.objectContaining({
        key: "RM-15993",
        title: "Customer lookup succeeds",
        status: "Resolved",
        description: "Verify customer lookup success.",
        relationship: "tests",
      }),
    ]);
  });

  it("records warnings for unrecovered optional section failures", async () => {
    const source = new FakeTicketSource({
      issue: mainIssue(),
      comments: [],
      linkedIssues: [],
      developmentError: new Error("development links unavailable"),
    });

    const context = await extractTicketContext("PROJ-1", source);

    expect(context.comments).toHaveLength(1);
    expect(context.warnings).toEqual([
      expect.objectContaining({
        section: "development",
        message: expect.stringContaining("development links unavailable"),
      }),
    ]);
  });
});

interface FakeTicketSourceOptions {
  issue: NormalizedIssue;
  comments?: Comment[];
  attachments?: Attachment[];
  linkedIssues?: TicketLink[];
  linkedIssueDetails?: Record<string, NormalizedIssue>;
  development?: Development;
  confluencePages?: ConfluencePage[];
  developmentError?: Error;
}

class FakeTicketSource implements TicketSource {
  private readonly options: FakeTicketSourceOptions;

  constructor(options: FakeTicketSourceOptions) {
    this.options = options;
  }

  getSourceName(): "jira-rest" {
    return "jira-rest";
  }

  async getIssue(issueKey: string): Promise<NormalizedIssue> {
    return this.options.linkedIssueDetails?.[issueKey] ?? this.options.issue;
  }

  async getComments(): Promise<Comment[]> {
    return this.options.comments ?? [];
  }

  async getAttachments(): Promise<Attachment[]> {
    return this.options.attachments ?? [];
  }

  async getLinkedIssues(): Promise<TicketLink[]> {
    return this.options.linkedIssues ?? [];
  }

  async getDevelopmentLinks(): Promise<Development> {
    if (this.options.developmentError) {
      throw this.options.developmentError;
    }

    return this.options.development ?? { branches: [], pullRequests: [] };
  }

  async getConfluencePages(): Promise<ConfluencePage[]> {
    return this.options.confluencePages ?? [];
  }

  getProvenance(): ToolProvenance[] {
    return [];
  }

  getWarnings(): Warning[] {
    return [];
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function mainIssue(): NormalizedIssue {
  return {
    ticket: {
      key: "PROJ-1",
      title: "Checkout rejects valid card",
      issueType: "Bug",
      status: "In Progress",
      assignee: { name: "Owner", email: "owner@example.com" },
      reporter: { name: "Reporter" },
      labels: ["checkout"],
      components: ["Payments"],
      url: "https://jira/browse/PROJ-1",
      links: [
        {
          direction: "outward",
          relationship: "tests",
          issueKey: "TEST-1",
          title: "Regression test",
          status: "Ready",
          issueType: "Test",
        },
      ],
    },
    description: {
      format: "adf",
      text: "Card validation fails.",
    },
    comments: [
      {
        id: "c-1",
        author: { name: "Reporter" },
        createdAt: "2026-04-02T09:00:00.000Z",
        body: "Initial triage notes.",
      },
    ],
    linkedIssues: [
      {
        direction: "outward",
        relationship: "tests",
        issueKey: "TEST-1",
        title: "Regression test",
        status: "Ready",
        issueType: "Test",
      },
    ],
  };
}

function emptyIssue(): NormalizedIssue {
  return {
    ticket: {
      key: "PROJ-2",
      title: "Small cleanup",
      labels: [],
      components: [],
      links: [],
    },
    description: {
      format: "text",
      text: "No related artifacts.",
    },
    comments: [],
    linkedIssues: [],
  };
}

function testIssue(): NormalizedIssue {
  return {
    ticket: {
      key: "TEST-1",
      title: "Regression test",
      issueType: "Test",
      status: "Ready",
      labels: ["xray"],
      components: [],
      links: [],
    },
    description: {
      format: "text",
      text: "Verify the validation path.",
    },
    comments: [],
    linkedIssues: [],
  };
}

function testCaseIssue(): NormalizedIssue {
  return {
    ticket: {
      key: "RM-15993",
      title: "Customer lookup succeeds",
      issueType: "Test Case",
      status: "Resolved",
      labels: ["xray"],
      components: [],
      links: [],
    },
    description: {
      format: "text",
      text: "Verify customer lookup success.",
    },
    comments: [],
    linkedIssues: [],
  };
}
