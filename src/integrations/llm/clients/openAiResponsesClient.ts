import OpenAI from "openai";
import { isRecord } from "../json.js";
import { addUsage, extractOpenAiResponsesUsage, newUsageTotals } from "../usage.js";
import { isStructuredOutputRejection } from "./openAiChatCompletionsClient.js";
import type { LlmTextClient, LlmTextGenerationRequest, LlmUsageTotals } from "../types.js";

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
  private readonly usage = newUsageTotals();
  /** Set when the deployment rejects text.format (structured outputs). */
  private structuredUnsupported = false;

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
    const useSchema = request.responseSchema !== undefined && !this.structuredUnsupported;
    const create = (withSchema: boolean) =>
      this.client.responses.create({
        model: this.model,
        instructions: request.systemPrompt,
        input: buildResponsesInput(request),
        stream: false,
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
        ...(withSchema && request.responseSchema
          ? {
              text: {
                format: {
                  type: "json_schema" as const,
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
      if (useSchema && isStructuredOutputRejection(error)) {
        this.structuredUnsupported = true;
        try {
          payload = await create(false);
        } catch (fallbackError) {
          throw formatOpenAiError(fallbackError);
        }
      } else {
        throw formatOpenAiError(error);
      }
    }

    addUsage(this.usage, extractOpenAiResponsesUsage(payload));
    const text = extractOpenAiOutputText(payload);
    return request.redactOutput ? request.redactOutput(text) : text;
  }

  getAccumulatedUsage(): LlmUsageTotals {
    return { ...this.usage };
  }
}

type ResponsesInput = string | OpenAI.Responses.ResponseInput;

/** Input: a plain string, or a user turn with text + input_image parts. */
export function buildResponsesInput(request: LlmTextGenerationRequest): ResponsesInput {
  if (!request.images || request.images.length === 0) {
    return request.userPrompt;
  }
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: request.userPrompt },
        ...request.images.map((image) => ({
          type: "input_image" as const,
          image_url: `data:${image.mediaType};base64,${image.dataBase64}`,
          detail: "auto" as const,
        })),
      ],
    },
  ];
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
