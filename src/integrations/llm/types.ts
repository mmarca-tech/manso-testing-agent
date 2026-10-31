export type LlmProvider = "openai" | "anthropic";

/**
 * Which OpenAI-shape API to call. Standard OpenAI hosts both; Azure OpenAI
 * exposes Chat Completions in every region and Responses regionally — auto-
 * detected from the base URL but overridable with LLM_API_STYLE.
 */
export type OpenAiApiStyle = "responses" | "chat-completions";

export interface LlmRuntimeConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  maxOutputTokens?: number;
  /** OpenAI-only. Ignored when provider is "anthropic". */
  apiStyle?: OpenAiApiStyle;
}

export interface PhoenixTelemetryConfig {
  enabled: boolean;
  projectName: string;
  url?: string;
  apiKey?: string;
  sessionId?: string;
  userId?: string;
  batch?: boolean;
}

export interface LangfuseTelemetryConfig {
  enabled: boolean;
  projectName: string;
  url?: string;
  publicKey: string;
  secretKey: string;
  sessionId?: string;
  userId?: string;
  batch?: boolean;
}

export type OpenTelemetryProvider = "phoenix" | "langfuse";

export type ObservabilityTelemetryConfig =
  | (PhoenixTelemetryConfig & { provider: "phoenix" })
  | (LangfuseTelemetryConfig & { provider: "langfuse" });

/** A base64-encoded image attached to a multimodal LLM request. */
export interface LlmImageInput {
  /** IANA media type, e.g. "image/png" or "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes (no `data:` prefix). */
  dataBase64: string;
}

export interface LlmTextGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  operation?: string;
  maxOutputTokens?: number;
  /** Optional images for multimodal (vision) requests. */
  images?: LlmImageInput[];
  /**
   * JSON Schema the response must conform to (M24 structured outputs).
   * Providers that support it enforce/guide the shape (OpenAI
   * `response_format: json_schema`, Anthropic forced tool-use); providers or
   * deployments that reject it fall back to plain text transparently.
   */
  responseSchema?: Record<string, unknown>;
  /** Short snake_case name for the schema/tool (defaults to "structured_output"). */
  schemaName?: string;
  /** Per-request SDK retry cap (governed calls use zero). */
  maxRetries?: number;
  /** Sanitize generated text before task telemetry sees it. */
  redactOutput?: (text: string) => string;
}

/** Token totals accumulated across a client's `generateText` calls. */
export interface LlmUsageTotals {
  calls: number;
  /** Total input tokens, INCLUDING cached reads (OpenAI convention). */
  inputTokens: number;
  /** Cached/cache-read input tokens (a subset of inputTokens). */
  cachedInputTokens: number;
  outputTokens: number;
}

export interface LlmTextClient {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly toolName: string;
  generateText(request: LlmTextGenerationRequest): Promise<string>;
  /**
   * Accumulated token usage across this client's calls, when the client
   * captures it from API responses. Feeds the design-phase cost ledger —
   * the text APIs don't report a dollar cost, so spend is estimated from
   * these totals × the model price table.
   */
  getAccumulatedUsage?(): LlmUsageTotals | undefined;
}
