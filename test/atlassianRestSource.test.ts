import { describe, expect, it } from "vitest";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { AtlassianRestSource } from "../src/integrations/atlassianRest/source.js";

describe("AtlassianRestSource", () => {
  it("extracts issue, comments, links, development, and Confluence pages through REST", async () => {
    const calls: string[] = [];
    const client = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "user@example.com", apiToken: "token" },
      confluence: { baseUrl: "https://example.atlassian.net/wiki", username: "user@example.com", apiToken: "token" },
      fetchFn: async (input) => {
        const url = String(input);
        calls.push(url);

        if (url.includes("/rest/api/3/issue/PROJ-1?")) {
          return jsonResponse(mainIssue());
        }

        if (url.includes("/rest/api/3/issue/PROJ-1/comment")) {
          return jsonResponse({
            startAt: 0,
            total: 1,
            comments: [
              {
                id: "c-1",
                author: { displayName: "Reviewer" },
                created: "2026-04-01T10:00:00.000Z",
                body: "Looks reproducible.",
              },
            ],
          });
        }

        if (url.includes("/gateway/api/graphql")) {
          return jsonResponse({
            data: {
              developmentInformation: {
                details: {
                  instanceTypes: [
                    {
                      name: "github",
                      repository: [
                        {
                          name: "checkout-api",
                          branches: [
                            {
                              name: "feature/PROJ-1",
                              url: "https://git/branch/1",
                              lastCommit: { timestamp: "2026-04-02T10:00:00.000Z" },
                            },
                          ],
                          pullRequests: [
                            {
                              name: "Fix checkout",
                              status: "OPEN",
                              url: "https://git/pr/1",
                              lastUpdate: "2026-04-03T10:00:00.000Z",
                            },
                          ],
                        },
                      ],
                      danglingPullRequests: [
                        {
                          name: "Fix checkout",
                          status: "OPEN",
                          url: "https://git/pr/1",
                          branchName: "feature/PROJ-1",
                          lastUpdate: "2026-04-03T10:00:00.000Z",
                          author: { name: "Developer" },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          });
        }

        if (url.includes("/rest/api/3/issue/PROJ-1/remotelink")) {
          return jsonResponse([
            {
              id: 9,
              application: { name: "Confluence" },
              object: {
                title: "Checkout Design",
                url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Checkout+Design",
              },
            },
          ]);
        }

        if (url.includes("/rest/api/content/123")) {
          return jsonResponse({
            id: "123",
            title: "Checkout Design",
            space: { key: "ENG" },
            _links: { base: "https://example.atlassian.net/wiki", webui: "/spaces/ENG/pages/123/Checkout+Design" },
            version: { when: "2026-04-02T10:00:00.000Z" },
            body: { storage: { value: "<p>Design details.</p>" } },
          });
        }

        return jsonResponse({}, 404, "Not Found");
      },
    });
    const source = new AtlassianRestSource({
      client,
      jiraCloudId: "cloud-1",
    });

    const issue = await source.getIssue("PROJ-1");
    const comments = await source.getComments("PROJ-1");
    const attachments = await source.getAttachments("PROJ-1");
    const links = await source.getLinkedIssues("PROJ-1");
    const development = await source.getDevelopmentLinks("PROJ-1");
    const pages = await source.getConfluencePages("PROJ-1");

    expect(issue.ticket.key).toBe("PROJ-1");
    expect(comments).toHaveLength(1);
    expect(attachments).toEqual([
      expect.objectContaining({
        filename: "checkout-error.png",
        mimeType: "image/png",
        sizeBytes: 1200,
      }),
    ]);
    expect(links).toEqual([expect.objectContaining({ issueKey: "TEST-1", issueType: "Test" })]);
    expect(development.pullRequests).toHaveLength(1);
    expect(development.branches).toHaveLength(1);
    expect(pages).toEqual([
      expect.objectContaining({ id: "123", title: "Checkout Design", space: "ENG", body: "Design details." }),
    ]);
    expect(development.branches[0]).toEqual(
      expect.objectContaining({ name: "feature/PROJ-1", repository: "checkout-api", provider: "github" }),
    );
    expect(development.pullRequests[0]).toEqual(
      expect.objectContaining({
        title: "Fix checkout",
        repository: "checkout-api",
        provider: "github",
        sourceBranch: "feature/PROJ-1",
        author: { name: "Developer" },
      }),
    );
    expect(source.getSourceName()).toBe("jira-rest");
    expect(source.getProvenance().every((item) => item.success)).toBe(true);
    expect(calls.some((url) => url.includes("/rest/api/3/issue/PROJ-1?"))).toBe(true);
    expect(calls.some((url) => url.includes("/gateway/api/graphql"))).toBe(true);
    expect(calls.some((url) => url.includes("/rest/dev-status/latest/issue/detail"))).toBe(false);
  });
});

function mainIssue() {
  return {
    id: "10001",
    key: "PROJ-1",
    self: "https://example.atlassian.net/rest/api/3/issue/10001",
    fields: {
      summary: "Checkout bug",
      description: "Checkout fails.",
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      labels: ["checkout"],
      components: [{ name: "Payments" }],
      attachment: [
        {
          id: "att-1",
          filename: "checkout-error.png",
          mimeType: "image/png",
          size: 1200,
          content: "https://example.atlassian.net/secure/attachment/att-1/checkout-error.png",
        },
      ],
      issuelinks: [
        {
          type: { outward: "tests" },
          outwardIssue: {
            key: "TEST-1",
            fields: {
              summary: "Checkout regression",
              issuetype: { name: "Test" },
              status: { name: "Ready" },
            },
          },
        },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}
