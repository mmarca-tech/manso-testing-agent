import Anthropic from "@anthropic-ai/sdk";
import { isRecord } from "../json.js";
import { addUsage, extractAnthropicUsage, newUsageTotals } from "../usage.js";
import type { LlmTextClient, LlmTextGenerationRequest, LlmUsageTotals } from "../types.js";

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
  private readonly usage = newUsageTotals();
  /** Set when the endpoint rejects forced tool-use (structured outputs). */
  private structuredUnsupported = false;

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
    const useSchema = request.responseSchema !== undefined && !this.structuredUnsupported;
    const toolName = request.schemaName ?? "structured_output";
    const finish = (text: string): string => (request.redactOutput ? request.redactOutput(text) : text);
    const create = (withSchema: boolean) =>
      this.client.messages.create({
        model: this.model,
        max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
        system: request.systemPrompt,
        messages: [
          {
            role: "user",
            content: buildAnthropicUserContent(request),
          },
        ],
        stream: false,
        // Structured outputs via forced tool-use: the model must "call" a tool
        // whose input schema is the response contract; the input IS the result.
        ...(withSchema && request.responseSchema
          ? {
              tools: [
                {
                  name: toolName,
                  description: "Emit the structured result.",
                  input_schema: request.responseSchema as Anthropic.Tool["input_schema"],
                },
              ],
              tool_choice: { type: "tool" as const, name: toolName },
            }
          : {}),
      }, request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {});

    let payload: unknown;
    let usedSchema = useSchema;
    try {
      payload = await create(useSchema);
    } catch (error) {
      if (useSchema && isAnthropicStructuredRejection(error)) {
        this.structuredUnsupported = true;
        usedSchema = false;
        try {
          payload = await create(false);
        } catch (fallbackError) {
          throw formatAnthropicError(fallbackError);
        }
      } else {
        throw formatAnthropicError(error);
      }
    }

    addUsage(this.usage, extractAnthropicUsage(payload));
    if (usedSchema) {
      const toolInput = extractAnthropicToolInput(payload, toolName);
      if (toolInput !== undefined) return finish(JSON.stringify(toolInput));
      // Model answered with text despite the forced tool — fall through.
    }
    return finish(extractAnthropicOutputText(payload));
  }

  getAccumulatedUsage(): LlmUsageTotals {
    return { ...this.usage };
  }
}

type AnthropicUserContent = Anthropic.MessageCreateParamsNonStreaming["messages"][number]["content"];

/** User content: a plain string, or text + image blocks for vision requests. */
export function buildAnthropicUserContent(request: LlmTextGenerationRequest): AnthropicUserContent {
  if (!request.images || request.images.length === 0) {
    return request.userPrompt;
  }
  return [
    { type: "text", text: request.userPrompt },
    ...request.images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType as "image/png", data: image.dataBase64 },
    })),
  ];
}

/** The forced tool call's input IS the structured result. Exported for tests. */
export function extractAnthropicToolInput(payload: unknown, toolName: string): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.content)) return undefined;
  for (const block of payload.content) {
    if (isRecord(block) && block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  return undefined;
}

function isAnthropicStructuredRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tool_choice|input_schema|tools/i.test(message);
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
