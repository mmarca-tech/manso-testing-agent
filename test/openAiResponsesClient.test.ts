import { describe, expect, it } from "vitest";
import { extractOutputText, parseJsonObject, postOpenAiResponses } from "../src/integrations/openai/responsesClient.js";

describe("postOpenAiResponses", () => {
  it("retries retryable 502 responses using retry_after from the response body", async () => {
    let calls = 0;
    const delays: number[] = [];
    const retryMessages: string[] = [];

    const payload = await postOpenAiResponses({
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      body: { model: "test-model", input: "test" },
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ retryable: true, retry_after: 60 }, 502, "Bad Gateway");
        }

        return jsonResponse({ output_text: "{\"ok\":true}" });
      },
      sleepFn: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onRetry: (message) => retryMessages.push(message),
    });

    expect(calls).toBe(2);
    expect(delays).toEqual([60_000]);
    expect(retryMessages[0]).toContain("Attempt 1/3 failed");
    expect(parseJsonObject(extractOutputText(payload))).toEqual({ ok: true });
  });

  it("does not retry non-retryable client errors", async () => {
    let calls = 0;

    await expect(
      postOpenAiResponses({
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
        body: { model: "test-model", input: "test" },
        fetchFn: async () => {
          calls += 1;
          return jsonResponse({ error: "bad request" }, 400, "Bad Request");
        },
        sleepFn: async () => undefined,
        onRetry: () => undefined,
      }),
    ).rejects.toThrow("OpenAI Responses API 400 Bad Request");

    expect(calls).toBe(1);
  });
});

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}
