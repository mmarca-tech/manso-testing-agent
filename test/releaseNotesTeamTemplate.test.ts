import { describe, expect, it } from "vitest";
import {
  assessEligibility,
  browseUrl,
  buildTeamTemplate,
  sectionFromIssueType,
} from "../src/agents/releaseNotesAuthor/teamTemplate.js";
import type { Ticket } from "../src/domain/contextPack/schema.js";

function ticket(key: string, overrides: Partial<Ticket> = {}): Ticket {
  return { key, title: `Title of ${key}`, labels: [], components: [], links: [], ...overrides };
}

describe("assessEligibility", () => {
  it("keeps done tickets and tickets with no status information", () => {
    expect(assessEligibility(ticket("A-1", { statusCategory: "done", resolution: "Done" }))).toEqual({ eligible: true });
    expect(assessEligibility(ticket("A-2"))).toEqual({ eligible: true });
  });

  it("excludes tickets that are not done, naming the status", () => {
    const result = assessEligibility(ticket("A-3", { status: "In Review", statusCategory: "indeterminate" }));
    expect(result).toEqual({ eligible: false, reason: "Not done (status: In Review)." });
  });

  it.each(["Won't Do", "Duplicate", "Cancelled", "Rejected"])("excludes done tickets resolved as %j", (resolution) => {
    expect(assessEligibility(ticket("A-4", { statusCategory: "done", resolution })).eligible).toBe(false);
  });
});

describe("browseUrl", () => {
  it("turns a REST self link into the human browse page", () => {
    expect(browseUrl({ key: "RM-1", url: "https://your-domain.atlassian.net/rest/api/3/issue/2744419" })).toBe(
      "https://your-domain.atlassian.net/browse/RM-1",
    );
  });

  it("keeps the context path of a Jira Data Center url", () => {
    expect(browseUrl({ key: "RM-1", url: "https://host.example/jira/rest/api/2/issue/1" })).toBe(
      "https://host.example/jira/browse/RM-1",
    );
  });

  it("keeps browse links and missing urls as they are", () => {
    expect(browseUrl({ key: "RM-1", url: "https://jira.example/browse/RM-1" })).toBe("https://jira.example/browse/RM-1");
    expect(browseUrl({ key: "RM-1" })).toBeUndefined();
  });
});

describe("sectionFromIssueType", () => {
  it.each([
    ["Bug", "bugFix"],
    ["Story", "newFeature"],
    ["Task", "maintenance"],
    [undefined, "maintenance"],
  ] as const)("maps %j to %j", (issueType, section) => {
    expect(sectionFromIssueType(issueType)).toBe(section);
  });
});

describe("buildTeamTemplate", () => {
  const releaseTicket = ticket("REL-1", { fixVersions: [{ name: "2026.10", releaseDate: "2026-10-14" }] });

  it("joins LLM prose with Jira link, product affected and release date", () => {
    const { teamTemplate, releaseMetadata, warnings } = buildTeamTemplate({
      releaseTicket,
      tickets: [
        ticket("P-1", {
          url: "https://jira.example/browse/P-1",
          affectedServices: ["Checkout API"],
          components: ["Checkout", "Checkout API"],
          fixVersions: [{ name: "2026.10", releaseDate: "2026-10-14" }],
          assignee: { name: "Dev One" },
        }),
        ticket("P-2", { issueType: "Bug", fixVersions: [{ name: "2026.10.1", releaseDate: "2026-10-02" }], assignee: { name: "Dev Two" } }),
      ],
      entries: [
        { key: "P-1", section: "newFeature", description: "Pay in instalments.", why: "Customers asked for it.", insufficientContext: false },
        { key: "P-2", section: "bugFix", description: "Login works again.", insufficientContext: false },
      ],
    });

    expect(teamTemplate.newFeatures).toEqual([
      {
        ticketKey: "P-1",
        ticketUrl: "https://jira.example/browse/P-1",
        description: "Pay in instalments.",
        why: "Customers asked for it.",
        productAffected: ["Checkout API", "Checkout"],
        releaseDate: "2026-10-14",
        insufficientContext: false,
      },
    ]);
    // No "why" means the row is flagged even if the model did not flag it.
    expect(teamTemplate.bugFixes[0]).toMatchObject({ ticketKey: "P-2", insufficientContext: true, releaseDate: "2026-10-02" });
    expect(releaseMetadata).toEqual({
      version: "2026.10",
      dateFrom: "2026-10-02",
      dateTo: "2026-10-14",
      contributors: ["Dev One", "Dev Two"],
    });
    expect(warnings).toEqual([]);
  });

  it("gives every in-scope ticket a row and drops entries for out-of-scope keys", () => {
    const { teamTemplate, warnings } = buildTeamTemplate({
      releaseTicket: ticket("REL-2"),
      tickets: [ticket("P-3", { issueType: "Bug" })],
      entries: [{ key: "INVENTED-9", section: "newFeature", description: "Not real.", insufficientContext: false }],
    });

    expect(teamTemplate.newFeatures).toEqual([]);
    expect(teamTemplate.bugFixes).toEqual([
      { ticketKey: "P-3", description: "Title of P-3", productAffected: [], insufficientContext: true },
    ]);
    expect(warnings.map((w) => w.message).join("\n")).toMatch(/INVENTED-9[\s\S]*P-3/);
  });

  it("falls back to the linked tickets' fix versions when the release ticket has none", () => {
    const { releaseMetadata } = buildTeamTemplate({
      releaseTicket: ticket("REL-3"),
      tickets: [ticket("P-4", { fixVersions: [{ name: "v1" }] }), ticket("P-5", { fixVersions: [{ name: "v2" }] })],
      entries: [],
    });
    expect(releaseMetadata).toEqual({ version: "v1, v2", contributors: [] });
  });

  it("falls back to the release ticket's completion date and products when a ticket has none", () => {
    const change = ticket("ITSM-1", {
      completedAt: "2026-10-01T00:30:00.000+0200",
      affectedServices: ["Manso Pay"],
    });
    const { teamTemplate, releaseMetadata } = buildTeamTemplate({
      releaseTicket: change,
      tickets: [ticket("P-6", { issueType: "Story" }), ticket("P-7", { issueType: "Story", components: ["Checkout"] })],
      entries: [],
    });

    expect(teamTemplate.newFeatures.map((r) => [r.ticketKey, r.releaseDate, r.productAffected])).toEqual([
      ["P-6", "2026-10-01", ["Manso Pay"]],
      // Its own product wins over the release's.
      ["P-7", "2026-10-01", ["Checkout"]],
    ]);
    expect(releaseMetadata).toMatchObject({ dateFrom: "2026-10-01", dateTo: "2026-10-01" });
  });

  it("uses the release ticket itself as the only row when nothing is linked", () => {
    const change = ticket("ITSM-2", { issueType: "[System] Change", url: "https://jira.example/browse/ITSM-2" });
    const { teamTemplate, warnings } = buildTeamTemplate({
      releaseTicket: change,
      tickets: [],
      entries: [{ key: "ITSM-2", section: "maintenance", description: "Upgraded the gateway.", why: "Security patch.", insufficientContext: false }],
    });

    expect(teamTemplate.maintenance).toEqual([
      {
        ticketKey: "ITSM-2",
        ticketUrl: "https://jira.example/browse/ITSM-2",
        description: "Upgraded the gateway.",
        why: "Security patch.",
        productAffected: [],
        insufficientContext: false,
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it("does not list the release ticket when it had links but none were eligible", () => {
    const change = ticket("ITSM-3", { issueType: "[System] Change" });
    const { teamTemplate } = buildTeamTemplate({ releaseTicket: change, tickets: [], entries: [], hadLinkedTickets: true });

    expect(teamTemplate).toEqual({ newFeatures: [], maintenance: [], bugFixes: [] });
  });
});
