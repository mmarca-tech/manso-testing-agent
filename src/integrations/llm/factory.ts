import { AnthropicMessagesLlmClient } from "./clients/anthropicMessagesClient.js";
import { OpenAiResponsesLlmClient } from "./clients/openAiResponsesClient.js";
import { createPhoenixInstrumentedLlmTextClient, initializePhoenixTelemetry } from "./telemetry/phoenix.js";
import type { LlmRuntimeConfig, LlmTextClient, PhoenixTelemetryConfig } from "./types.js";

export interface CreateLlmTextClientOptions {
  fetchFn?: typeof fetch;
  phoenixTelemetry?: PhoenixTelemetryConfig | undefined;
}

export function createLlmTextClient(config: LlmRuntimeConfig, options: CreateLlmTextClientOptions = {}): LlmTextClient {
  initializePhoenixTelemetry(options.phoenixTelemetry);

  if (config.provider === "openai") {
    return createPhoenixInstrumentedLlmTextClient(new OpenAiResponsesLlmClient({
      apiKey: config.apiKey,
      model: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    }), options.phoenixTelemetry);
  }

  return createPhoenixInstrumentedLlmTextClient(new AnthropicMessagesLlmClient({
    apiKey: config.apiKey,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  }), options.phoenixTelemetry);
}
