import Anthropic from "@anthropic-ai/sdk";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import {
  MimeType,
  type NodeTracerProvider,
  register,
  traceChain,
} from "@arizeai/phoenix-otel";
import OpenAI from "openai";
import type { LlmTextClient, LlmTextGenerationRequest, PhoenixTelemetryConfig } from "../types.js";

let tracerProvider: NodeTracerProvider | undefined;
let instrumentationRegistered = false;

type SpanAttributeValue = string | number | boolean;

export interface PhoenixWorkflowTraceOptions<Input, Output> {
  name: string;
  attributes: Record<string, SpanAttributeValue>;
  input: (input: Input) => unknown;
  output: (output: Output) => unknown;
}

export function createPhoenixInstrumentedLlmTextClient(
  client: LlmTextClient,
  config: PhoenixTelemetryConfig | undefined,
): LlmTextClient {
  if (!config?.enabled) {
    return client;
  }

  initializePhoenixTelemetry(config);
  return new PhoenixInstrumentedLlmTextClient(client);
}

export function createPhoenixTracedWorkflow<Input, Output>(
  workflow: (input: Input) => Promise<Output>,
  config: PhoenixTelemetryConfig | undefined,
  options: PhoenixWorkflowTraceOptions<Input, Output>,
): (input: Input) => Promise<Output> {
  if (!config?.enabled) {
    return workflow;
  }

  initializePhoenixTelemetry(config);
  return traceChain(workflow, {
    name: options.name,
    attributes: options.attributes,
    processInput: (input) => ({
      "input.value": stringifySpanPayload(options.input(input)),
      "input.mime_type": MimeType.JSON,
    }),
    processOutput: (output) => ({
      "output.value": stringifySpanPayload(options.output(output)),
      "output.mime_type": MimeType.JSON,
    }),
  });
}

export async function flushPhoenixTelemetry(): Promise<void> {
  try {
    await tracerProvider?.forceFlush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Phoenix telemetry flush failed: ${message}`);
  }
}

export function initializePhoenixTelemetry(config: PhoenixTelemetryConfig | undefined): void {
  if (!config?.enabled || instrumentationRegistered) {
    return;
  }

  tracerProvider = register({
    projectName: config.projectName,
    ...(config.url ? { url: config.url } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.batch !== undefined ? { batch: config.batch } : {}),
  });

  new OpenAIInstrumentation({ tracerProvider }).manuallyInstrument(OpenAI);
  new AnthropicInstrumentation({ tracerProvider }).manuallyInstrument(Anthropic);
  instrumentationRegistered = true;
}

function stringifySpanPayload(payload: unknown): string {
  return JSON.stringify(payload) ?? "null";
}

class PhoenixInstrumentedLlmTextClient implements LlmTextClient {
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
