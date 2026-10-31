import Anthropic from "@anthropic-ai/sdk";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import {
  getDefaultSpanProcessor,
  MimeType,
  register as registerPhoenix,
  traceChain,
} from "@arizeai/phoenix-otel";
import { context, propagation, trace, type Context, type TracerProvider } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import OpenAI from "openai";
import type {
  LangfuseTelemetryConfig,
  LlmTextClient,
  LlmTextGenerationRequest,
  ObservabilityTelemetryConfig,
  OpenTelemetryProvider,
  PhoenixTelemetryConfig,
} from "../types.js";
import { isTelemetryActive, markTelemetryActive } from "./state.js";

export type SpanAttributeValue = string | number | boolean;

const MAX_LANGFUSE_ID_LENGTH = 200;
const BAGGAGE_ATTRIBUTE_PREFIX = "manso.telemetry.attribute.";

export interface WorkflowTraceOptions<Input, Output> {
  name: string;
  attributes: Record<string, SpanAttributeValue>;
  sessionId?: (input: Input) => string | undefined;
  input: (input: Input) => unknown;
  output: (output: Output) => unknown;
  outputAttributes?: (output: Output) => Record<string, SpanAttributeValue | undefined>;
}

export interface OtlpTraceExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

type RegisteredTracerProvider = TracerProvider & {
  forceFlush(): Promise<void>;
};

let tracerProvider: RegisteredTracerProvider | undefined;
let registeredProvider: OpenTelemetryProvider | undefined;
let instrumentationRegistered = false;

export function createInstrumentedLlmTextClient(
  client: LlmTextClient,
  config: ObservabilityTelemetryConfig | undefined,
): LlmTextClient {
  if (!config?.enabled) {
    return client;
  }

  initializeTelemetry(config);
  return new InstrumentedLlmTextClient(client);
}

export function createTracedWorkflow<Input, Output>(
  workflow: (input: Input) => Promise<Output>,
  config: ObservabilityTelemetryConfig | undefined,
  options: WorkflowTraceOptions<Input, Output>,
): (input: Input) => Promise<Output> {
  if (!config?.enabled) {
    return workflow;
  }

  initializeTelemetry(config);
  const tracedWorkflow = traceChain(workflow, {
    name: options.name,
    attributes: options.attributes,
    processInput: (input) => ({
      "input.value": stringifySpanPayload(options.input(input)),
      "input.mime_type": MimeType.JSON,
    }),
    processOutput: (output) => ({
      "output.value": stringifySpanPayload(options.output(output)),
      "output.mime_type": MimeType.JSON,
      ...(options.outputAttributes ? compactSpanAttributes(options.outputAttributes(output)) : {}),
    }),
  });

  return async (input) => {
    const traceAttributes = traceContextAttributes(config, options, input);
    if (Object.keys(traceAttributes).length === 0) {
      return tracedWorkflow(input);
    }

    const tracingContext = withBaggageAttributes(context.active(), traceAttributes);
    return context.with(tracingContext, () => tracedWorkflow(input));
  };
}

export async function flushTelemetry(): Promise<void> {
  try {
    await tracerProvider?.forceFlush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const provider = registeredProvider ? providerDisplayName(registeredProvider) : "OpenTelemetry";
    console.warn(`${provider} telemetry flush failed: ${message}`);
  }
}

export function initializeTelemetry(config: ObservabilityTelemetryConfig | undefined): void {
  if (!config?.enabled) {
    return;
  }

  if (instrumentationRegistered) {
    if (registeredProvider && registeredProvider !== config.provider) {
      console.warn(
        `OpenTelemetry is already initialized for ${providerDisplayName(registeredProvider)}; ignoring ${providerDisplayName(config.provider)}.`,
      );
    }
    return;
  }

  tracerProvider = config.provider === "phoenix"
    ? registerPhoenixTelemetry(config)
    : registerLangfuseTelemetry(config);
  registeredProvider = config.provider;
  registerLlmInstrumentations(tracerProvider);
  instrumentationRegistered = true;
  markTelemetryActive();
}

export function buildOtlpTraceExporterConfig(config: ObservabilityTelemetryConfig): OtlpTraceExporterConfig {
  if (config.provider === "phoenix") {
    return {
      endpoint: ensurePhoenixOtlpTraceEndpoint(config.url ?? "http://localhost:6006"),
      ...(config.apiKey ? { headers: { Authorization: `Bearer ${config.apiKey}` } } : {}),
    };
  }

  return {
    endpoint: ensureLangfuseOtlpTraceEndpoint(config.url ?? "https://cloud.langfuse.com"),
    headers: langfuseOtlpHeaders(config),
  };
}

export function formatOtlpHeaders(headers: Record<string, string> | undefined): string | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  return Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

export function ensurePhoenixOtlpTraceEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

export function ensureLangfuseOtlpTraceEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/public/otel/v1/traces")) {
    return trimmed;
  }
  if (trimmed.endsWith("/api/public/otel")) {
    return `${trimmed}/v1/traces`;
  }

  return `${trimmed}/api/public/otel/v1/traces`;
}

export function normalizeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > MAX_LANGFUSE_ID_LENGTH
    ? trimmed.slice(0, MAX_LANGFUSE_ID_LENGTH)
    : trimmed;
}

export function normalizeUserId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > MAX_LANGFUSE_ID_LENGTH
    ? trimmed.slice(0, MAX_LANGFUSE_ID_LENGTH)
    : trimmed;
}

export function jiraIssueSessionId(issue: string | undefined): string | undefined {
  const normalizedIssue = normalizeSessionId(issue)?.toUpperCase();
  return normalizedIssue ? normalizeSessionId(`jira:${normalizedIssue}`) : undefined;
}

export function azurePullRequestSessionId(input: {
  organization?: string;
  project?: string;
  repository?: string;
  pullRequestId?: number;
  ticketKey?: string;
}): string | undefined {
  const issueSessionId = jiraIssueSessionId(input.ticketKey);
  if (issueSessionId) {
    return issueSessionId;
  }

  if (!input.organization || !input.project || !input.repository || input.pullRequestId === undefined) {
    return undefined;
  }

  return normalizeSessionId(
    `ado-pr:${input.organization}/${input.project}/${input.repository}/${input.pullRequestId}`,
  );
}

export function sessionSpanAttributes(sessionId: string): Record<string, SpanAttributeValue> {
  return {
    "session.id": sessionId,
    "langfuse.session.id": sessionId,
  };
}

export function userSpanAttributes(userId: string): Record<string, SpanAttributeValue> {
  return {
    "user.id": userId,
    "langfuse.user.id": userId,
  };
}

export function setActiveSpanAttributes(attributes: Record<string, SpanAttributeValue | undefined>): void {
  trace.getActiveSpan()?.setAttributes(compactSpanAttributes(attributes));
}

/**
 * Run `fn` with a telemetry session attached so every span created inside it
 * (LLM `task.*` spans plus OpenInference SDK child spans) is tagged with
 * `session.id` / `langfuse.session.id`. This is what groups all LLM calls of a
 * single run under one session in the Langfuse/Phoenix UI.
 *
 * No-op (just runs `fn`) when telemetry was never activated or no session id is
 * available, so callers can wrap unconditionally.
 */
export function withTelemetrySession<T>(
  sessionId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized || !isTelemetryActive()) {
    return fn();
  }

  const tracingContext = withBaggageAttributes(context.active(), sessionSpanAttributes(normalized));
  return context.with(tracingContext, fn);
}

function registerPhoenixTelemetry(config: PhoenixTelemetryConfig): RegisteredTracerProvider {
  const defaultSpanProcessorConfig = {
    ...(config.url ? { url: config.url } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.batch !== undefined ? { batch: config.batch } : {}),
  };
  return registerPhoenix({
    projectName: config.projectName,
    ...defaultSpanProcessorConfig,
    spanProcessors: [
      new BaggageAttributesSpanProcessor(defaultTelemetrySpanAttributes(config)),
      getDefaultSpanProcessor(defaultSpanProcessorConfig),
    ],
  });
}

function registerLangfuseTelemetry(config: LangfuseTelemetryConfig): RegisteredTracerProvider {
  const exporterConfig = buildOtlpTraceExporterConfig({ ...config, provider: "langfuse" });
  const exporter = new OTLPTraceExporter({
    url: exporterConfig.endpoint,
    ...(exporterConfig.headers ? { headers: exporterConfig.headers } : {}),
  });
  const spanProcessor: SpanProcessor = config.batch === false
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": config.projectName,
      "openinference.project.name": config.projectName,
    }),
    spanProcessors: [
      new BaggageAttributesSpanProcessor(defaultTelemetrySpanAttributes(config)),
      spanProcessor,
    ],
  });
  provider.register();
  return provider;
}

function langfuseOtlpHeaders(config: LangfuseTelemetryConfig): Record<string, string> {
  const encodedCredentials = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  return {
    Authorization: `Basic ${encodedCredentials}`,
    "x-langfuse-ingestion-version": "4",
  };
}

function registerLlmInstrumentations(provider: TracerProvider): void {
  new OpenAIInstrumentation({ tracerProvider: provider }).manuallyInstrument(OpenAI);
  new AnthropicInstrumentation({ tracerProvider: provider }).manuallyInstrument(Anthropic);
}

function providerDisplayName(provider: OpenTelemetryProvider): string {
  return provider === "phoenix" ? "Phoenix" : "Langfuse";
}

function stringifySpanPayload(payload: unknown): string {
  return JSON.stringify(payload) ?? "null";
}

function compactSpanAttributes(attributes: Record<string, SpanAttributeValue | undefined>): Record<string, SpanAttributeValue> {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Record<string, SpanAttributeValue>;
}

function resolveWorkflowSessionId<Input, Output>(
  config: ObservabilityTelemetryConfig,
  options: WorkflowTraceOptions<Input, Output>,
  input: Input,
): string | undefined {
  return normalizeSessionId(config.sessionId ?? options.sessionId?.(input));
}

function traceContextAttributes<Input, Output>(
  config: ObservabilityTelemetryConfig,
  options: WorkflowTraceOptions<Input, Output>,
  input: Input,
): Record<string, SpanAttributeValue> {
  const sessionId = resolveWorkflowSessionId(config, options, input);
  const userId = normalizeUserId(config.userId);

  return {
    ...(sessionId ? sessionSpanAttributes(sessionId) : {}),
    ...(userId ? userSpanAttributes(userId) : {}),
  };
}

function withBaggageAttributes(baseContext: Context, attributes: Record<string, SpanAttributeValue>): Context {
  const existingBaggage = propagation.getBaggage(baseContext);
  const entries = Object.fromEntries(existingBaggage?.getAllEntries() ?? []);
  for (const [key, value] of Object.entries(attributes)) {
    entries[baggageAttributeKey(key)] = { value: String(value) };
  }

  return propagation.setBaggage(baseContext, propagation.createBaggage(entries));
}

function baggageAttributeKey(attributeName: string): string {
  return `${BAGGAGE_ATTRIBUTE_PREFIX}${attributeName}`;
}

function defaultTelemetrySpanAttributes(config: { userId?: string }): Record<string, SpanAttributeValue> {
  const userId = normalizeUserId(config.userId);
  return {
    ...(userId ? userSpanAttributes(userId) : {}),
  };
}

class BaggageAttributesSpanProcessor implements SpanProcessor {
  constructor(private readonly defaultAttributes: Record<string, SpanAttributeValue> = {}) {}

  onStart(span: Span, parentContext: Context): void {
    span.setAttributes(this.defaultAttributes);

    const baggage = propagation.getBaggage(parentContext);
    if (!baggage) {
      return;
    }

    for (const [key, entry] of baggage.getAllEntries()) {
      if (key.startsWith(BAGGAGE_ATTRIBUTE_PREFIX)) {
        span.setAttribute(key.slice(BAGGAGE_ATTRIBUTE_PREFIX.length), entry.value);
      }
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class InstrumentedLlmTextClient implements LlmTextClient {
  readonly provider: LlmTextClient["provider"];
  readonly model: string;
  readonly toolName: string;
  private readonly client: LlmTextClient;

  constructor(client: LlmTextClient) {
    this.client = client;
    this.provider = client.provider;
    this.model = client.model;
    this.toolName = client.toolName;
  }

  getAccumulatedUsage() {
    return this.client.getAccumulatedUsage?.();
  }

  async generateText(request: LlmTextGenerationRequest): Promise<string> {
    const operation = request.operation ?? "generateText";
    const tracedGenerateText = traceChain(async (input: LlmTextGenerationRequest) => this.client.generateText(input), {
      name: `task.${operation}`,
      attributes: {
        "task.operation": operation,
        "llm.provider": this.provider,
        "llm.model_name": this.model,
      },
      processInput: (input) => ({
        "input.value": JSON.stringify({
          operation: input.operation,
          maxOutputTokens: input.maxOutputTokens,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
        }),
        "input.mime_type": MimeType.JSON,
      }),
      processOutput: (text) => ({
        "output.value": text,
        "output.mime_type": MimeType.TEXT,
      }),
    });

    return tracedGenerateText(request);
  }
}
