import { AnthropicMessagesLlmClient } from "./clients/anthropicMessagesClient.js";
import { OpenAiChatCompletionsLlmClient } from "./clients/openAiChatCompletionsClient.js";
import { OpenAiResponsesLlmClient } from "./clients/openAiResponsesClient.js";
import { createInstrumentedLlmTextClient, initializeTelemetry } from "./telemetry/observability.js";
import type { LlmRuntimeConfig, LlmTextClient, ObservabilityTelemetryConfig } from "./types.js";

export interface CreateLlmTextClientOptions {
  fetchFn?: typeof fetch;
  telemetry?: ObservabilityTelemetryConfig | undefined;
}

export function createLlmTextClient(config: LlmRuntimeConfig, options: CreateLlmTextClientOptions = {}): LlmTextClient {
  initializeTelemetry(options.telemetry);

  if (config.provider === "openai") {
    const openAiOptions = {
      apiKey: config.apiKey,
      model: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    };
    const client = config.apiStyle === "chat-completions"
      ? new OpenAiChatCompletionsLlmClient(openAiOptions)
      : new OpenAiResponsesLlmClient(openAiOptions);
    return createInstrumentedLlmTextClient(client, options.telemetry);
  }

  return createInstrumentedLlmTextClient(new AnthropicMessagesLlmClient({
    apiKey: config.apiKey,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  }), options.telemetry);
}
