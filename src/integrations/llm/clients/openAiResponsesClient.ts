import OpenAI from "openai";
import { isRecord } from "../json.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../types.js";

export interface OpenAiResponsesLlmClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  fetchFn?: typeof fetch;
  maxRetries?: number;
}

export class OpenAiResponsesLlmClient implements LlmTextClient {
  readonly provider = "openai";
  readonly toolName = "openai:responses";
  readonly model: string;
  private readonly client: OpenAI;
  private readonly maxOutputTokens: number | undefined;

  constructor(options: OpenAiResponsesLlmClientOptions) {
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.fetchFn ? { fetch: options.fetchFn } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
  }

  async generateText(request: LlmTextGenerationRequest): Promise<string> {
    const maxOutputTokens = request.maxOutputTokens ?? this.maxOutputTokens;
    let payload: unknown;
    try {
      payload = await this.client.responses.create({
        model: this.model,
        instructions: request.systemPrompt,
        input: request.userPrompt,
        stream: false,
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      });

    } catch (error) {
      throw formatOpenAiError(error);
    }

    return extractOpenAiOutputText(payload);
  }
}

export function extractOpenAiOutputText(payload: unknown): string {
  if (isRecord(payload) && typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    throw new Error("OpenAI response did not include output text.");
  }

  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  const text = parts.join("\n").trim();
  if (!text) {
    throw new Error("OpenAI response text was empty.");
  }

  return text;
}

function formatOpenAiError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`OpenAI Responses API request failed: ${error.message}`, { cause: error });
  }

  return new Error(`OpenAI Responses API request failed: ${String(error)}`);
}
