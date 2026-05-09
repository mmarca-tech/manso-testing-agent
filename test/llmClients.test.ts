import { describe, expect, it } from "vitest";
import { AnthropicMessagesLlmClient, extractAnthropicOutputText } from "../src/integrations/llm/clients/anthropicMessagesClient.js";
import { createLlmTextClient } from "../src/integrations/llm/factory.js";
import { OpenAiResponsesLlmClient } from "../src/integrations/llm/clients/openAiResponsesClient.js";

describe("LLM clients", () => {
  it("sends OpenAI Responses requests through the provider-neutral client", async () => {
    const requests: CapturedRequest[] = [];
    const client = new OpenAiResponsesLlmClient({
      apiKey: "openai-token",
      model: "gpt-test",
      baseUrl: "https://openai.example/v1",
      maxOutputTokens: 123,
      fetchFn: async (input, init) => {
        requests.push(await captureRequest(input, init));
        return jsonResponse(openAiResponse("{\"ok\":true}"));
      },
      maxRetries: 0,
    });

    const text = await client.generateText({
      systemPrompt: "system prompt",
      userPrompt: "user prompt",
    });

    expect(text).toBe("{\"ok\":true}");
    expect(requests[0]?.url).toBe("https://openai.example/v1/responses");
    expect(requests[0]?.headers.authorization).toBe("Bearer openai-token");
    expect(requests[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      model: "gpt-test",
      instructions: "system prompt",
      input: "user prompt",
      max_output_tokens: 123,
      stream: false,
    });
  });

  it("sends Anthropic Messages requests and extracts text blocks", async () => {
    const requests: CapturedRequest[] = [];
    const client = new AnthropicMessagesLlmClient({
      apiKey: "anthropic-token",
      model: "claude-test",
      baseUrl: "https://anthropic.example/v1",
      apiVersion: "2024-01-01",
      maxOutputTokens: 456,
      fetchFn: async (input, init) => {
        requests.push(await captureRequest(input, init));
        return jsonResponse(
          anthropicResponse([
            { type: "text", text: "{\"ok\":" },
            { type: "text", text: "true}" },
          ]),
        );
      },
      maxRetries: 0,
    });

    const text = await client.generateText({
      systemPrompt: "system prompt",
      userPrompt: "user prompt",
    });

    expect(text).toBe("{\"ok\":\ntrue}");
    expect(requests[0]?.url).toBe("https://anthropic.example/v1/messages");
    expect(requests[0]?.headers["x-api-key"]).toBe("anthropic-token");
    expect(requests[0]?.headers["anthropic-version"]).toBe("2024-01-01");
    expect(requests[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      model: "claude-test",
      max_tokens: 456,
      system: "system prompt",
      messages: [{ role: "user", content: "user prompt" }],
      stream: false,
    });
  });

  it("retries Anthropic retryable responses through the SDK", async () => {
    let calls = 0;
    const client = new AnthropicMessagesLlmClient({
      apiKey: "anthropic-token",
      model: "claude-test",
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ error: { message: "temporary" } }, 502, "Bad Gateway", {
            "retry-after": "0",
            "retry-after-ms": "0",
          });
        }

        return jsonResponse(anthropicResponse([{ type: "text", text: "{\"ok\":true}" }]));
      },
      maxRetries: 1,
    });

    const text = await client.generateText({
      systemPrompt: "system",
      userPrompt: "user",
    });

    expect(text).toBe("{\"ok\":true}");
    expect(calls).toBe(2);
  });

  it("reports Anthropic API errors with provider context", async () => {
    const client = new AnthropicMessagesLlmClient({
      apiKey: "anthropic-token",
      model: "claude-test",
      fetchFn: async () => jsonResponse({ error: { message: "bad request", type: "invalid_request_error" } }, 400, "Bad Request"),
      maxRetries: 0,
    });

    await expect(client.generateText({ systemPrompt: "system", userPrompt: "user" })).rejects.toThrow(
      /Anthropic Messages API request failed: .*bad request/,
    );
  });

  it("extracts Anthropic text defensively", () => {
    expect(() => extractAnthropicOutputText({ content: [] })).toThrow("Anthropic response text was empty");
    expect(() => extractAnthropicOutputText({})).toThrow("Anthropic response did not include output text");
  });

  it("creates provider clients from runtime config", () => {
    expect(createLlmTextClient({ provider: "openai", apiKey: "key", model: "gpt-test" }).toolName).toBe("openai:responses");
    expect(createLlmTextClient({ provider: "anthropic", apiKey: "key", model: "claude-test" }).toolName).toBe("anthropic:messages");
  });
});

interface CapturedRequest {
  url: string;
  body: string | undefined;
  headers: Record<string, string>;
}

async function captureRequest(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<CapturedRequest> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key.toLowerCase(), value));

  return {
    url: input instanceof Request ? input.url : String(input),
    body: typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : undefined,
    headers: Object.fromEntries(headers.entries()),
  };
}

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

function anthropicResponse(content: unknown[]): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
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
