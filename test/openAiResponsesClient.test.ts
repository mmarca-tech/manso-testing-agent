import { describe, expect, it } from "vitest";
import { extractOpenAiOutputText, OpenAiResponsesLlmClient } from "../src/integrations/llm/clients/openAiResponsesClient.js";
import { parseJsonObject } from "../src/integrations/llm/json.js";

describe("OpenAiResponsesLlmClient", () => {
  it("retries retryable responses through the SDK", async () => {
    let calls = 0;

    const client = new OpenAiResponsesLlmClient({
      apiKey: "test-key",
      model: "test-model",
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ error: { message: "temporary" } }, 502, "Bad Gateway", {
            "retry-after": "0",
            "retry-after-ms": "0",
          });
        }

        return jsonResponse(openAiResponse("{\"ok\":true}"));
      },
      maxRetries: 1,
    });

    const text = await client.generateText({
      systemPrompt: "system",
      userPrompt: "user",
    });

    expect(calls).toBe(2);
    expect(parseJsonObject(text)).toEqual({ ok: true });
  });

  it("does not retry non-retryable client errors", async () => {
    let calls = 0;

    const client = new OpenAiResponsesLlmClient({
      apiKey: "test-key",
      model: "test-model",
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({ error: { message: "bad request" } }, 400, "Bad Request");
      },
      maxRetries: 1,
    });

    await expect(client.generateText({ systemPrompt: "system", userPrompt: "user" })).rejects.toThrow(
      /OpenAI Responses API request failed: .*bad request/,
    );

    expect(calls).toBe(1);
  });

  it("extracts OpenAI response text defensively", () => {
    expect(parseJsonObject(extractOpenAiOutputText(openAiResponse("{\"ok\":true}")))).toEqual({ ok: true });
    expect(() => extractOpenAiOutputText({ output: [] })).toThrow("OpenAI response text was empty");
    expect(() => extractOpenAiOutputText({})).toThrow("OpenAI response did not include output text");
  });
});

function openAiResponse(outputText: string): unknown {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    status: "completed",
    output_text: outputText,
    output: [
      {
        id: "msg_test",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
  };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json", ...headers },
  });
}
