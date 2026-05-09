import Anthropic from "@anthropic-ai/sdk";
import { isRecord } from "../json.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../types.js";

export interface AnthropicMessagesLlmClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  maxOutputTokens?: number;
  fetchFn?: typeof fetch;
  maxRetries?: number;
}

const DEFAULT_ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 16_000;

export class AnthropicMessagesLlmClient implements LlmTextClient {
  readonly provider = "anthropic";
  readonly toolName = "anthropic:messages";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxOutputTokens: number;

  constructor(options: AnthropicMessagesLlmClientOptions) {
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: normalizeAnthropicBaseUrl(options.baseUrl) } : {}),
      ...(options.fetchFn ? { fetch: options.fetchFn } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      defaultHeaders: {
        "anthropic-version": options.apiVersion ?? DEFAULT_ANTHROPIC_API_VERSION,
      },
    });
  }

  async generateText(request: LlmTextGenerationRequest): Promise<string> {
    let payload: unknown;
    try {
      payload = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
        system: request.systemPrompt,
        messages: [
          {
            role: "user",
            content: request.userPrompt,
          },
        ],
        stream: false,
      });
    } catch (error) {
      throw formatAnthropicError(error);
    }

    return extractAnthropicOutputText(payload);
  }
}

export function extractAnthropicOutputText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new Error("Anthropic response did not include output text.");
  }

  const parts: string[] = [];
  for (const content of payload.content) {
    if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
      parts.push(content.text);
    }
  }

  const text = parts.join("\n").trim();
  if (!text) {
    throw new Error("Anthropic response text was empty.");
  }

  return text;
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function formatAnthropicError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`Anthropic Messages API request failed: ${error.message}`, { cause: error });
  }

  return new Error(`Anthropic Messages API request failed: ${String(error)}`);
}
