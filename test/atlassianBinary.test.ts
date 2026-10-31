import { describe, expect, it, vi } from "vitest";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";

describe("AtlassianRestClient.getBinary", () => {
  it("requests with Accept: */* (not octet-stream) so Jira serves image bytes", async () => {
    let seenAccept: string | undefined;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenAccept = headers.get("accept") ?? undefined;
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });
    const client = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn,
    });

    const { data, contentType } = await client.getBinary("jira", "/rest/api/3/attachment/content/10001");

    expect(seenAccept).toBe("*/*");
    expect(contentType).toBe("image/png");
    expect(Array.from(data)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
