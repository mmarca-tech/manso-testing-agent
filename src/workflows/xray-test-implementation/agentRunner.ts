import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions, type Usage as CodexUsage } from "@openai/codex-sdk";
import { query as queryClaude, type Options as ClaudeOptions, type SDKMessage, type SDKResultMessage, type SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import type {
  XrayTestImplementationAgentUsage,
  XrayTestImplementationCommandResult,
} from "../../domain/xrayTestImplementation/schema.js";
import { runShellCommand, type ShellRunResult } from "../../integrations/git/localGit.js";
import {
  buildOtlpTraceExporterConfig,
  createTracedWorkflow,
  formatOtlpHeaders,
  jiraIssueSessionId,
  type SpanAttributeValue,
} from "../../integrations/llm/telemetry/observability.js";
import type { LlmProvider, ObservabilityTelemetryConfig } from "../../integrations/llm/types.js";
import { CliError } from "../../shared/cli.js";

export type ImplementationAgentRunnerKind = "codex-sdk" | "claude-sdk" | "shell";
export type ImplementationAgentPhase = "implementation" | "healing";

export interface ImplementationAgentRunInput {
  issueKey: string;
  repoRoot: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  phase: ImplementationAgentPhase;
}

export interface ImplementationAgentRunner {
  readonly kind: ImplementationAgentRunnerKind;
  readonly provider?: LlmProvider | undefined;
  readonly model?: string | undefined;
  readonly commandLabel: string;
  run(input: ImplementationAgentRunInput): Promise<XrayTestImplementationCommandResult>;
}

export interface ResolvedImplementationAgentRunners {
  implementation: ImplementationAgentRunner;
  healing: ImplementationAgentRunner;
}

export interface ImplementationAgentRunnerArgs {
  agentCommand?: string;
  healAgentCommand?: string;
  agentPath?: string;
  agentArguments?: string;
}

interface CodexSdkRunnerOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  codexPathOverride?: string;
  telemetry?: ObservabilityTelemetryConfig;
}

interface ClaudeSdkRunnerOptions {
  model?: string;
  pathToClaudeCodeExecutable?: string;
}

export class CodexSdkRunner implements ImplementationAgentRunner {
  readonly kind = "codex-sdk" as const;
  readonly provider = "openai" as const;
  readonly model?: string | undefined;
  readonly commandLabel = "codex-sdk";
  private readonly options: CodexSdkRunnerOptions;

  constructor(options: CodexSdkRunnerOptions = {}) {
    this.options = options;
    this.model = options.model;
  }

  async run(input: ImplementationAgentRunInput): Promise<XrayTestImplementationCommandResult> {
    const startedAt = Date.now();
    const codex = new Codex(buildCodexOptions(this.options, input.env));
    const threadOptions: ThreadOptions = {
      workingDirectory: input.repoRoot,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      skipGitRepoCheck: false,
      ...(this.options.model ? { model: this.options.model } : {}),
    };
    const thread = codex.startThread(threadOptions);
    const streamedTurn = await thread.runStreamed(input.prompt);
    let usage: CodexUsage | undefined;
    const output: string[] = [];
    let failureMessage: string | undefined;

    for await (const event of streamedTurn.events) {
      if (event.type === "turn.completed") {
        usage = event.usage;
        continue;
      }
      if (event.type === "turn.failed") {
        failureMessage = event.error.message;
        continue;
      }
      if (event.type === "error") {
        failureMessage = event.message;
        continue;
      }
      collectCodexEventOutput(event, output);
    }

    return {
      command: this.commandLabel,
      exitCode: failureMessage ? 1 : 0,
      durationMs: Date.now() - startedAt,
      ...(output.length > 0 ? { stdout: output.join("\n\n") } : {}),
      ...(failureMessage ? { stderr: failureMessage } : {}),
      ...(usage ? { usage: mapCodexUsage(usage, this.options.model) } : {}),
    };
  }
}

export class ClaudeSdkRunner implements ImplementationAgentRunner {
  readonly kind = "claude-sdk" as const;
  readonly provider = "anthropic" as const;
  readonly model?: string | undefined;
  readonly commandLabel = "claude-sdk";
  private readonly options: ClaudeSdkRunnerOptions;

  constructor(options: ClaudeSdkRunnerOptions = {}) {
    this.options = options;
    this.model = options.model;
  }

  async run(input: ImplementationAgentRunInput): Promise<XrayTestImplementationCommandResult> {
    const startedAt = Date.now();
    const messages = queryClaude({
      prompt: input.prompt,
      options: {
        cwd: input.repoRoot,
        env: input.env,
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable } : {}),
      },
    });

    let result: SDKResultMessage | undefined;
    const output: string[] = [];

    for await (const message of messages) {
      if (message.type === "result") {
        result = message;
        continue;
      }
      collectClaudeMessageOutput(message, output);
    }

    if (!result) {
      return {
        command: this.commandLabel,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stderr: "Claude SDK completed without a result message.",
      };
    }

    const usage = mapClaudeUsage(result, this.options.model);
    if (result.subtype !== "success") {
      return {
        command: this.commandLabel,
        exitCode: 1,
        durationMs: result.duration_ms || Date.now() - startedAt,
        ...(output.length > 0 ? { stdout: output.join("\n\n") } : {}),
        stderr: result.errors.length > 0 ? result.errors.join("\n") : result.subtype,
        usage,
      };
    }

    return {
      command: this.commandLabel,
      exitCode: 0,
      durationMs: result.duration_ms || Date.now() - startedAt,
      stdout: [result.result, ...output].filter(Boolean).join("\n\n"),
      usage,
    };
  }
}

export class ShellImplementationAgentRunner implements ImplementationAgentRunner {
  readonly kind = "shell" as const;
  readonly commandLabel: string;

  constructor(command: string) {
    this.commandLabel = command;
  }

  async run(input: ImplementationAgentRunInput): Promise<XrayTestImplementationCommandResult> {
    const result = await runShellCommand(this.commandLabel, input.repoRoot, input.env, input.prompt);
    return toCommandResult(result, true);
  }
}

export function resolveImplementationAgentRunners(
  args: ImplementationAgentRunnerArgs,
  config: RuntimeConfig | undefined,
): ResolvedImplementationAgentRunners {
  const explicitAgentCommand = args.agentCommand ?? nonEmpty(process.env.MANSO_TEST_IMPLEMENTATION_COMMAND);
  if (explicitAgentCommand) {
    const implementation = new ShellImplementationAgentRunner(explicitAgentCommand);
    const healing = new ShellImplementationAgentRunner(args.healAgentCommand ?? explicitAgentCommand);
    return { implementation, healing };
  }

  const agentArguments = args.agentArguments ?? nonEmpty(process.env.MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS);
  if (agentArguments) {
    throw new CliError("--agent-arguments is only supported with --agent-command or MANSO_TEST_IMPLEMENTATION_COMMAND. SDK runners use provider config/env instead.");
  }

  const provider = resolveImplementationProvider(config);
  const agentPath = args.agentPath ?? nonEmpty(process.env.MANSO_TEST_IMPLEMENTATION_AGENT_PATH);
  const implementation = provider === "anthropic"
    ? new ClaudeSdkRunner({
        model: resolveAnthropicModel(config),
        ...(agentPath ? { pathToClaudeCodeExecutable: agentPath } : {}),
      })
    : new CodexSdkRunner({
        ...resolveOpenAiSdkOptions(config),
        ...(agentPath ? { codexPathOverride: agentPath } : {}),
        ...(config?.observability?.telemetry ? { telemetry: config.observability.telemetry } : {}),
      });

  const healing = args.healAgentCommand
    ? new ShellImplementationAgentRunner(args.healAgentCommand)
    : implementation;

  return { implementation, healing };
}

export async function runImplementationAgent(
  runner: ImplementationAgentRunner,
  input: ImplementationAgentRunInput,
  telemetry: ObservabilityTelemetryConfig | undefined,
): Promise<XrayTestImplementationCommandResult> {
  const run = (runnerInput: ImplementationAgentRunInput) => runner.run(runnerInput);
  const tracedRun = createTracedWorkflow(run, telemetry, {
    name: `agent.${runner.kind}.${input.phase}`,
    attributes: {
      "workflow.name": "test-implementation",
      "workflow.issue": input.issueKey,
      "workflow.phase": input.phase,
      "agent.kind": runner.kind,
      ...(runner.provider ? { "llm.provider": runner.provider } : {}),
      ...(runner.model ? { "llm.model_name": runner.model } : {}),
    },
    sessionId: (runnerInput) => jiraIssueSessionId(runnerInput.issueKey),
    input: (runnerInput) => ({
      issue: runnerInput.issueKey,
      repoRoot: runnerInput.repoRoot,
      phase: runnerInput.phase,
      promptChars: runnerInput.prompt.length,
    }),
    output: (result) => ({
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      usage: result.usage,
    }),
    outputAttributes: (result) => agentUsageSpanAttributes(result, input, runner),
  });

  return tracedRun(input);
}

export function agentUsageSpanAttributes(
  result: XrayTestImplementationCommandResult,
  input: ImplementationAgentRunInput,
  runner: ImplementationAgentRunner,
): Record<string, SpanAttributeValue | undefined> {
  return {
    "workflow.name": "test-implementation",
    "workflow.issue": input.issueKey,
    "workflow.phase": input.phase,
    "agent.kind": runner.kind,
    "llm.provider": result.usage?.provider ?? runner.provider,
    "llm.model_name": result.usage?.model ?? runner.model,
    "llm.token_count.prompt": result.usage?.inputTokens,
    "llm.token_count.completion": result.usage?.outputTokens,
    "llm.token_count.cached_input": result.usage?.cachedInputTokens,
    "llm.token_count.cache_creation_input": result.usage?.cacheCreationInputTokens,
    "llm.token_count.reasoning_output": result.usage?.reasoningOutputTokens,
    "llm.cost.total_usd": result.usage?.totalCostUsd,
  };
}

function buildCodexOptions(options: CodexSdkRunnerOptions, env: NodeJS.ProcessEnv): CodexOptions {
  const codexOptions: CodexOptions = {
    env: envToStringRecord(env),
  };
  const codexConfig = buildCodexConfig(options.telemetry);

  if (options.apiKey) {
    codexOptions.apiKey = options.apiKey;
  }
  if (options.baseUrl) {
    codexOptions.baseUrl = options.baseUrl;
  }
  if (options.codexPathOverride) {
    codexOptions.codexPathOverride = options.codexPathOverride;
  }
  if (codexConfig) {
    codexOptions.config = codexConfig;
  }

  return codexOptions;
}

function buildCodexConfig(telemetry: ObservabilityTelemetryConfig | undefined): CodexOptions["config"] | undefined {
  const explicitConfig = parseOptionalJsonConfig(nonEmpty(process.env.MANSO_CODEX_SDK_CONFIG), "MANSO_CODEX_SDK_CONFIG");
  if (explicitConfig) {
    return explicitConfig;
  }

  const forwardOtel = parseBoolean(nonEmpty(process.env.MANSO_CODEX_FORWARD_OTEL), false);
  if (!forwardOtel || !telemetry?.enabled) {
    return undefined;
  }
  const exporter = buildOtlpTraceExporterConfig(telemetry);
  const headers = formatOtlpHeaders(exporter.headers);

  return {
    otel: {
      environment: telemetry.projectName,
      trace_exporter: "otlp-http",
      log_user_prompt: false,
      exporters: {
        "otlp-http": {
          endpoint: exporter.endpoint,
          protocol: "http/protobuf",
          ...(headers ? { headers } : {}),
        },
      },
    },
  };
}

function collectCodexEventOutput(event: ThreadEvent, output: string[]): void {
  if (event.type !== "item.completed") {
    return;
  }

  if (event.item.type === "agent_message" && event.item.text.trim().length > 0) {
    output.push(event.item.text);
    return;
  }

  if (event.item.type === "command_execution") {
    const commandOutput = [`$ ${event.item.command}`, event.item.aggregated_output.trim()].filter(Boolean).join("\n");
    if (commandOutput.trim().length > 0) {
      output.push(commandOutput);
    }
  }
}

function collectClaudeMessageOutput(message: SDKMessage, output: string[]): void {
  if (message.type !== "assistant") {
    return;
  }

  const text = message.message.content
    .map((block) => block.type === "text" ? block.text : undefined)
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n");
  if (text.length > 0) {
    output.push(text);
  }
}

function mapCodexUsage(usage: CodexUsage, model: string | undefined): XrayTestImplementationAgentUsage {
  return {
    provider: "openai",
    ...(model ? { model } : {}),
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

function mapClaudeUsage(result: SDKResultMessage, configuredModel: string | undefined): XrayTestImplementationAgentUsage {
  const usage = result.usage as Record<string, unknown>;
  const modelUsage = Object.entries(result.modelUsage);
  const singleModel = modelUsage.length === 1 ? modelUsage[0]?.[0] : undefined;
  const summedModelUsage = sumClaudeModelUsage(modelUsage.map(([, value]) => value));

  return {
    provider: "anthropic",
    ...(singleModel ?? configuredModel ? { model: singleModel ?? configuredModel } : {}),
    inputTokens: numericField(usage, "input_tokens") ?? summedModelUsage.inputTokens,
    cachedInputTokens: numericField(usage, "cache_read_input_tokens") ?? summedModelUsage.cacheReadInputTokens,
    cacheCreationInputTokens: numericField(usage, "cache_creation_input_tokens") ?? summedModelUsage.cacheCreationInputTokens,
    outputTokens: numericField(usage, "output_tokens") ?? summedModelUsage.outputTokens,
    totalCostUsd: result.total_cost_usd,
  };
}

function sumClaudeModelUsage(modelUsage: Array<SDKResultSuccess["modelUsage"][string]>): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
} {
  if (modelUsage.length === 0) {
    return {};
  }

  return modelUsage.reduce(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  );
}

function toCommandResult(result: ShellRunResult, includeOutput: boolean): XrayTestImplementationCommandResult {
  return {
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(includeOutput && result.stdout ? { stdout: result.stdout } : {}),
    ...(includeOutput && result.stderr ? { stderr: result.stderr } : {}),
  };
}

function resolveImplementationProvider(config: RuntimeConfig | undefined): LlmProvider {
  const provider = config?.llm?.provider ?? nonEmpty(process.env.LLM_PROVIDER) ?? "openai";
  if (provider === "openai" || provider === "anthropic") {
    return provider;
  }

  throw new CliError(`LLM provider must be one of: openai, anthropic. Actual value: ${provider}`);
}

function resolveOpenAiSdkOptions(config: RuntimeConfig | undefined): CodexSdkRunnerOptions {
  const llm = config?.llm?.provider === "openai" ? config.llm : undefined;
  const model = llm?.model ?? config?.openAi?.model ?? nonEmpty(process.env.LLM_MODEL) ?? nonEmpty(process.env.OPENAI_MODEL) ?? "gpt-5.5";
  const apiKey = llm?.apiKey ?? config?.openAi?.apiKey ?? nonEmpty(process.env.LLM_API_KEY) ?? nonEmpty(process.env.OPENAI_API_KEY);
  const baseUrl = llm?.baseUrl ?? config?.openAi?.baseUrl ?? nonEmpty(process.env.LLM_BASE_URL) ?? nonEmpty(process.env.OPENAI_BASE_URL);

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    model,
  };
}

function resolveAnthropicModel(config: RuntimeConfig | undefined): string {
  const llm = config?.llm?.provider === "anthropic" ? config.llm : undefined;
  return llm?.model ?? nonEmpty(process.env.LLM_MODEL) ?? nonEmpty(process.env.ANTHROPIC_MODEL) ?? "claude-sonnet-4-6";
}

function envToStringRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function numericField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalJsonConfig(value: string | undefined, envName: string): CodexOptions["config"] | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`${envName} must be a JSON object.`);
  }

  return parsed as CodexOptions["config"];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
