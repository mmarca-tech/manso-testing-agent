import { describe, expect, it, vi } from "vitest";
import { AnthropicMessagesLlmClient } from "../src/integrations/llm/clients/anthropicMessagesClient.js";
import { OpenAiResponsesLlmClient } from "../src/integrations/llm/clients/openAiResponsesClient.js";
import { OpenAiChatCompletionsLlmClient } from "../src/integrations/llm/clients/openAiChatCompletionsClient.js";

describe("governed LLM calls", () => {
  it.each(["anthropic", "responses", "chat"] as const)("meters %s usage and honors the output cap", async (provider) => {
    const payload = provider === "anthropic"
      ? { content: [{ type: "text", text: "result" }], usage: { input_tokens: 10, output_tokens: 20 } }
      : provider === "responses"
        ? { output_text: "result", usage: { input_tokens: 10, output_tokens: 20 } }
        : { choices: [{ message: { content: "result" } }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    }));
    const options = { apiKey: "test-key", model: "test", fetchFn, maxRetries: 0 };
    const client = provider === "anthropic" ? new AnthropicMessagesLlmClient(options)
      : provider === "responses" ? new OpenAiResponsesLlmClient(options)
        : new OpenAiChatCompletionsLlmClient(options);
    expect(await client.generateText({ systemPrompt: "system", userPrompt: "user", maxOutputTokens: 4000 })).toBe("result");
    expect(client.getAccumulatedUsage()).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 20 });
    const sent = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(sent.max_tokens ?? sent.max_output_tokens ?? sent.max_completion_tokens).toBe(4000);
  });

  it("accounts paid responses even when text extraction fails", async () => {
    const client = new OpenAiResponsesLlmClient({
      apiKey: "key", model: "test", maxRetries: 0,
      fetchFn: async () => new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20 } }), {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(client.generateText({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow("output text");
    expect(client.getAccumulatedUsage()).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 20 });
  });

  it.each(["anthropic", "responses", "chat"] as const)("disables hidden paid retries for %s governed calls", async (provider) => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: "unavailable", type: "api_error" } }), {
      status: 500, headers: { "content-type": "application/json" },
    }));
    const options = { apiKey: "key", model: "test", fetchFn, maxRetries: 2 };
    const client = provider === "anthropic" ? new AnthropicMessagesLlmClient(options)
      : provider === "responses" ? new OpenAiResponsesLlmClient(options)
        : new OpenAiChatCompletionsLlmClient(options);
    await expect(client.generateText({ systemPrompt: "s", userPrompt: "u", maxRetries: 0 })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("sanitizes output before the instrumented task wrapper receives it", async () => {
    const client = new OpenAiResponsesLlmClient({
      apiKey: "key", model: "test", maxRetries: 0,
      fetchFn: async () => new Response(JSON.stringify({ output_text: "private value", usage: { input_tokens: 1, output_tokens: 1 } }), {
        headers: { "content-type": "application/json" },
      }),
    });
    expect(await client.generateText({
      systemPrompt: "s", userPrompt: "u", redactOutput: (text) => text.replace("private value", "[REDACTED]"),
    })).toBe("[REDACTED]");
  });
});
