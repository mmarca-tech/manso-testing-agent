import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../src/context/providerRegistry.js";
import { createJiraRestProvider } from "../src/context/providers/jiraRestProvider.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const JIRA = {
  baseUrl: "https://example.atlassian.net",
  username: "service@example.com",
  apiToken: "secret",
};

describe("createJiraRestProvider — getIssue", () => {
  it("fetches and normalizes a Jira issue", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/rest/api/3/issue/ABC-123") && !u.includes("/comment") && !u.includes("/remotelink")) {
        return mockResponse({
          key: "ABC-123",
          id: "10001",
          fields: {
            summary: "Sample story",
            description: "A description body",
            status: { name: "In Progress" },
            issuetype: { name: "Story" },
            labels: ["billing"],
            components: [{ name: "Checkout" }],
            assignee: { displayName: "Alice", emailAddress: "alice@example.com" },
            issuelinks: [],
          },
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const provider = createJiraRestProvider({ jira: JIRA, fetchFn });

    const issue = await provider.getIssue("ABC-123");
    expect(issue.ticket.key).toBe("ABC-123");
    expect(issue.ticket.title).toBe("Sample story");
    expect(issue.ticket.status).toBe("In Progress");
    expect(issue.ticket.issueType).toBe("Story");
    expect(issue.ticket.labels).toContain("billing");
    expect(issue.ticket.components).toContain("Checkout");
    expect(issue.ticket.assignee?.name).toBe("Alice");
    expect(issue.description.text).toContain("A description body");

    const provenance = provider.getProvenance();
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.success).toBe(true);
    expect(provenance[0]?.toolName).toBe("jira-rest:issue");
    expect(provider.getWarnings()).toEqual([]);
  });

  it("sends Basic auth with the right credentials", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      mockResponse({ key: "ABC-1", id: "1", fields: { summary: "x", issuelinks: [] } }),
    );

    const provider = createJiraRestProvider({ jira: JIRA, fetchFn });
    await provider.getIssue("ABC-1");

    const expected = `Basic ${Buffer.from(`${JIRA.username}:${JIRA.apiToken}`, "utf8").toString("base64")}`;
    const init = fetchFn.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe(expected);
  });
});

describe("createJiraRestProvider — getComments", () => {
  it("fetches paginated comments", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/comment")) {
        calls += 1;
        if (calls === 1) {
          return mockResponse({
            comments: [
              { id: "1", body: "First", author: { displayName: "Alice" }, created: "2024-01-02T00:00:00.000Z" },
              { id: "2", body: "Second", author: { displayName: "Bob" }, created: "2024-01-03T00:00:00.000Z" },
            ],
            total: 2,
          });
        }
        return mockResponse({ comments: [], total: 2 });
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const provider = createJiraRestProvider({ jira: JIRA, fetchFn });
    const comments = await provider.getComments("ABC-123");
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toBe("First");
    expect(comments[1]?.author?.name).toBe("Bob");
  });
});

describe("createJiraRestProvider — graceful degradation", () => {
  it("records a warning instead of throwing on tenant-info failure", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/rest/api/3/issue/ABC-9") && !u.includes("/comment") && !u.includes("/remotelink")) {
        return mockResponse({ key: "ABC-9", id: "10009", fields: { summary: "x", issuelinks: [] } });
      }
      if (u.includes("/_edge/tenant_info")) {
        return mockResponse({ error: "boom" }, 500);
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const provider = createJiraRestProvider({ jira: JIRA, fetchFn });
    const development = await provider.getDevelopmentLinks("ABC-9");
    expect(development).toEqual({ branches: [], pullRequests: [] });
    expect(provider.getWarnings().length).toBeGreaterThan(0);
    expect(provider.getWarnings()[0]?.section).toBe("development");
  });
});

describe("ProviderRegistry", () => {
  it("registers a provider and finds it by source name", () => {
    const fetchFn = vi.fn();
    const provider = createJiraRestProvider({ jira: JIRA, fetchFn });
    const registry = new ProviderRegistry();
    registry.register(provider);
    expect(registry.has("jira-rest")).toBe(true);
    expect(registry.get("jira-rest")).toBe(provider);
    expect(registry.list()).toEqual([provider]);
  });
});
