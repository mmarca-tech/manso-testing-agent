import { describe, expect, it } from "vitest";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";

function response(status: number, headers: Record<string, string> = {}, body: unknown = { ok: status < 400 }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function clientWith(statuses: Array<number | [number, Record<string, string>]>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const queue = [...statuses];
  const client = new AtlassianRestClient({
    jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
    fetchFn: async (_url, init) => {
      calls.push(String(init?.method));
      const next = queue.shift() ?? 200;
      return Array.isArray(next) ? response(next[0], next[1]) : response(next);
    },
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

describe("AtlassianRestClient rate-limit retry", () => {
  it("retries a 429, honouring Retry-After, then succeeds", async () => {
    const { client, calls, sleeps } = clientWith([[429, { "retry-after": "2" }], 200]);
    await expect(client.getJson("jira", "/rest/api/3/myself")).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["GET", "GET"]);
    expect(sleeps).toEqual([2000]);
  });

  it("caps a huge Retry-After", async () => {
    const { client, sleeps } = clientWith([[429, { "retry-after": "3600" }], 200]);
    await client.getJson("jira", "/x");
    expect(sleeps).toEqual([30_000]);
  });

  it("gives up after 3 retries and surfaces the last error", async () => {
    const { client, calls } = clientWith([429, 429, 429, 429, 200]);
    await expect(client.getJson("jira", "/x")).rejects.toThrow(/jira REST 429/);
    expect(calls).toHaveLength(4);
  });

  it("does not retry other errors", async () => {
    const { client, calls } = clientWith([404]);
    await expect(client.getJson("jira", "/x")).rejects.toThrow(/jira REST 404/);
    expect(calls).toHaveLength(1);
  });

  it("retries 503 for GET but not for POST, which may already have been applied", async () => {
    const get = clientWith([503, 200]);
    await expect(get.client.getJson("jira", "/x")).resolves.toEqual({ ok: true });
    expect(get.calls).toHaveLength(2);

    const post = clientWith([503, 200]);
    await expect(post.client.postJson("jira", "/x", {})).rejects.toThrow(/jira REST 503/);
    expect(post.calls).toHaveLength(1);
  });

  it("retries 429 for POST", async () => {
    const { client, calls } = clientWith([429, 200]);
    await expect(client.postJson("jira", "/x", {})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["POST", "POST"]);
  });
});
