import { describe, expect, it } from "vitest";
import { normalizeIssue, normalizeLinkedIssues } from "../src/integrations/atlassian/normalizers.js";

describe("normalizeLinkedIssues — parent and subtasks", () => {
  it("surfaces fields.parent as an epic/parent link", () => {
    const raw = {
      key: "QATG-2940",
      fields: {
        summary: "Story",
        parent: { key: "QATG-2000", fields: { summary: "Parent epic", issuetype: { name: "Epic" } } },
      },
    };
    const links = normalizeLinkedIssues(raw, "QATG-2940");
    const parent = links.find((link) => link.issueKey === "QATG-2000");
    expect(parent).toBeDefined();
    expect(parent?.relationship).toBe("epic");
    expect(parent?.title).toBe("Parent epic");
  });

  it("labels a non-epic parent as 'parent'", () => {
    const raw = {
      key: "QATG-3",
      fields: {
        summary: "Sub",
        parent: { key: "QATG-1", fields: { summary: "Parent story", issuetype: { name: "Story" } } },
      },
    };
    const links = normalizeLinkedIssues(raw, "QATG-3");
    expect(links.find((link) => link.issueKey === "QATG-1")?.relationship).toBe("parent");
  });

  it("surfaces fields.subtasks as subtask links", () => {
    const raw = {
      key: "QATG-100",
      fields: {
        summary: "Story",
        subtasks: [
          { key: "QATG-101", fields: { summary: "First subtask", issuetype: { name: "Sub-task" } } },
          { key: "QATG-102", fields: { summary: "Second subtask", issuetype: { name: "Sub-task" } } },
        ],
      },
    };
    const links = normalizeLinkedIssues(raw, "QATG-100");
    const subtaskKeys = links.filter((link) => link.relationship === "subtask").map((link) => link.issueKey);
    expect(subtaskKeys).toEqual(["QATG-101", "QATG-102"]);
  });

  it("includes parent and subtasks through the full normalizeIssue path", () => {
    const raw = {
      key: "QATG-100",
      fields: {
        summary: "Story",
        description: "A description body",
        parent: { key: "QATG-1", fields: { summary: "Epic", issuetype: { name: "Epic" } } },
        subtasks: [{ key: "QATG-101", fields: { summary: "Subtask", issuetype: { name: "Sub-task" } } }],
      },
    };
    const issue = normalizeIssue(raw, "QATG-100");
    const keys = issue.ticket.links.map((link) => link.issueKey);
    expect(keys).toContain("QATG-1");
    expect(keys).toContain("QATG-101");
  });
});

describe("normalizeIssue — release fields", () => {
  it("captures status category, resolution and fix versions", () => {
    const raw = {
      key: "PROJ-1",
      fields: {
        summary: "Story",
        status: { name: "Closed", statusCategory: { key: "done" } },
        resolution: { name: "Won't Do" },
        fixVersions: [
          { name: "2026.10", released: true, releaseDate: "2026-10-14" },
          { name: "2026.11", released: false },
          { id: "no-name" },
        ],
      },
    };
    const { ticket } = normalizeIssue(raw, "PROJ-1");
    expect(ticket.statusCategory).toBe("done");
    expect(ticket.resolution).toBe("Won't Do");
    expect(ticket.fixVersions).toEqual([
      { name: "2026.10", released: true, releaseDate: "2026-10-14" },
      { name: "2026.11", released: false },
    ]);
  });

  it("finds Affected services by field name via the expand=names map", () => {
    const raw = {
      key: "PROJ-2",
      names: { customfield_10042: "Affected services", customfield_10050: "Story points" },
      fields: {
        summary: "Story",
        customfield_10042: [{ id: "svc-1", name: "Checkout API" }, { id: "svc-2" }, { name: "Checkout API" }],
        customfield_10050: 5,
      },
    };
    expect(normalizeIssue(raw, "PROJ-2").ticket.affectedServices).toEqual(["Checkout API"]);
  });

  it("takes Affected services names from renderedFields when the field value is id-only (Jira Cloud JSM)", () => {
    const raw = {
      key: "ITSM-1",
      names: { customfield_15716: "Affected services" },
      fields: { summary: "Change", customfield_15716: [{ id: "ari:cloud:graph::service/a/1" }, { id: "ari:cloud:graph::service/a/2" }] },
      renderedFields: {
        customfield_15716: [
          { id: "ari:cloud:graph::service/a/1", name: "Risk Processing Service" },
          { id: "ari:cloud:graph::service/a/2", name: "Manso Pay" },
        ],
      },
    };
    expect(normalizeIssue(raw, "ITSM-1").ticket.affectedServices).toEqual(["Risk Processing Service", "Manso Pay"]);
  });

  it("reads completedAt from Change completion date, keeping the site-local offset", () => {
    const raw = {
      key: "ITSM-2",
      names: { customfield_13307: "Change completion date", resolutiondate: "Resolved" },
      fields: {
        summary: "Change",
        customfield_13307: "2026-10-01T00:30:00.000+0200",
        resolutiondate: "2026-10-02T09:00:00.000+0200",
      },
    };
    // Not converted to UTC: that would turn 1 Oct 00:30 local into 30 Sep.
    expect(normalizeIssue(raw, "ITSM-2").ticket.completedAt).toBe("2026-10-01T00:30:00.000+0200");
  });

  it("falls back to the resolution date when Change completion date is empty", () => {
    const raw = {
      key: "ITSM-3",
      names: { customfield_13307: "Change completion date" },
      fields: { summary: "Change", customfield_13307: null, resolutiondate: "2026-10-02T09:00:00.000+0200" },
    };
    expect(normalizeIssue(raw, "ITSM-3").ticket.completedAt).toBe("2026-10-02T09:00:00.000+0200");
  });

  it("omits release fields when Jira does not return them", () => {
    const { ticket } = normalizeIssue({ key: "PROJ-3", fields: { summary: "Story" } }, "PROJ-3");
    expect(ticket).not.toHaveProperty("fixVersions");
    expect(ticket).not.toHaveProperty("affectedServices");
    expect(ticket).not.toHaveProperty("statusCategory");
    expect(ticket).not.toHaveProperty("resolution");
    expect(ticket).not.toHaveProperty("completedAt");
  });
});
