import OpenAI from "openai";
import { isRecord } from "../json.js";
import { addUsage, extractOpenAiChatUsage, newUsageTotals } from "../usage.js";
import type { LlmTextClient, LlmTextGenerationRequest, LlmUsageTotals } from "../types.js";

export interface OpenAiChatCompletionsLlmClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  fetchFn?: typeof fetch;
  maxRetries?: number;
}

/**
 * Plain Chat Completions client (`POST /chat/completions`). Used when the
 * Responses API is unavailable — notably Azure OpenAI deployments in regions
 * where Responses has not been rolled out yet.
 */
export class OpenAiChatCompletionsLlmClient implements LlmTextClient {
  readonly provider = "openai";
  readonly toolName = "openai:chat.completions";
  readonly model: string;
  private readonly client: OpenAI;
  private readonly maxOutputTokens: number | undefined;
  private readonly usage = newUsageTotals();
  /** Set when the deployment rejects response_format (older Azure API versions). */
  private structuredUnsupported = false;

  constructor(options: OpenAiChatCompletionsLlmClientOptions) {
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
    const useSchema = request.responseSchema !== undefined && !this.structuredUnsupported;
    const create = (withSchema: boolean) =>
      this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: buildChatUserContent(request) },
        ],
        stream: false,
        // gpt-5 / o-series uses `max_completion_tokens`; the SDK accepts it.
        ...(maxOutputTokens !== undefined ? { max_completion_tokens: maxOutputTokens } : {}),
        ...(withSchema && request.responseSchema
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: {
                  name: request.schemaName ?? "structured_output",
                  schema: request.responseSchema,
                  strict: false,
                },
              },
            }
          : {}),
      }, request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {});

    let payload: unknown;
    try {
      payload = await create(useSchema);
    } catch (error) {
      // Deployment doesn't support structured outputs → remember and fall back
      // to plain text for the rest of the process.
      if (useSchema && isStructuredOutputRejection(error)) {
        this.structuredUnsupported = true;
        try {
          payload = await create(false);
        } catch (fallbackError) {
          throw formatError(fallbackError);
        }
      } else {
        throw formatError(error);
      }
    }

    addUsage(this.usage, extractOpenAiChatUsage(payload));
    const text = extractMessageText(payload);
    return request.redactOutput ? request.redactOutput(text) : text;
  }

  getAccumulatedUsage(): LlmUsageTotals {
    return { ...this.usage };
  }
}

/** Does this API error mean "response_format/json_schema not supported here"? */
export function isStructuredOutputRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /response_format|json_schema|structured output|text\.format/i.test(message);
}

type ChatUserContent = OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];

/** User content: a plain string, or text + image_url parts for vision requests. */
export function buildChatUserContent(request: LlmTextGenerationRequest): ChatUserContent {
  if (!request.images || request.images.length === 0) {
    return request.userPrompt;
  }
  return [
    { type: "text", text: request.userPrompt },
    ...request.images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` },
    })),
  ];
}

export function extractMessageText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("OpenAI chat.completions response did not include choices.");
  }
  for (const choice of payload.choices) {
    if (!isRecord(choice)) continue;
    const message = choice.message;
    if (isRecord(message) && typeof message.content === "string" && message.content.trim().length > 0) {
      return message.content.trim();
    }
  }
  throw new Error("OpenAI chat.completions response did not include message content.");
}

function formatError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`OpenAI Chat Completions API request failed: ${error.message}`, { cause: error });
  }
  return new Error(`OpenAI Chat Completions API request failed: ${String(error)}`);
}
