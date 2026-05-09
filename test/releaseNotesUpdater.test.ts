import { describe, expect, it } from "vitest";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { JiraReleaseNotesUpdater } from "../src/integrations/atlassianRest/releaseNotesUpdater.js";

describe("JiraReleaseNotesUpdater", () => {
  it("updates the configured Jira field with Markdown text", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const updater = new JiraReleaseNotesUpdater({
      client: clientWithFetch(async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return emptyResponse(204);
      }),
      fieldId: "customfield_11101",
      fieldFormat: "text",
    });

    await updater.update("ITSM-1234", "# Release notes\n\n- Change one");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/rest/api/3/issue/ITSM-1234");
    expect(requests[0]?.body).toEqual({
      fields: {
        customfield_11101: "# Release notes\n\n- Change one",
      },
    });
    expect(updater.getProvenance()[0]).toEqual(expect.objectContaining({ success: true }));
  });

  it("falls back to Atlassian Document Format in auto mode", async () => {
    const requests: unknown[] = [];
    const updater = new JiraReleaseNotesUpdater({
      client: clientWithFetch(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        if (requests.length === 1) {
          return jsonResponse({ errorMessages: ["Field expects an object."] }, 400, "Bad Request");
        }

        return emptyResponse(204);
      }),
    });

    await updater.update("ITSM-1234", "# Release notes\n\n- Change one");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      fields: {
        customfield_11101: "# Release notes\n\n- Change one",
      },
    });
    expect(requests[1]).toEqual({
      fields: {
        customfield_11101: expect.objectContaining({
          type: "doc",
          version: 1,
          content: expect.arrayContaining([
            expect.objectContaining({ type: "heading" }),
            expect.objectContaining({ type: "bulletList" }),
          ]),
        }),
      },
    });
    expect(updater.getWarnings()[0]?.message).toContain("retrying with Atlassian Document Format");
  });
});

function clientWithFetch(fetchFn: typeof fetch): AtlassianRestClient {
  return new AtlassianRestClient({
    jira: { baseUrl: "https://example.atlassian.net", username: "user@example.com", apiToken: "token" },
    fetchFn,
  });
}

function emptyResponse(status: number): Response {
  return new Response(undefined, { status });
}

function jsonResponse(body: unknown, status: number, statusText: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}
