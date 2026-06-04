export type LlmProvider = "openai" | "anthropic";

export interface LlmRuntimeConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  maxOutputTokens?: number;
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

export interface LlmTextGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  operation?: string;
  maxOutputTokens?: number;
}

export interface LlmTextClient {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly toolName: string;
  generateText(request: LlmTextGenerationRequest): Promise<string>;
}
