import { readFile } from "node:fs/promises";
import { z } from "zod";
import { loadMemoryCabinConfig, type MemoryCabinConfig } from "../memory/config.js";
import type {
  LangfuseTelemetryConfig,
  LlmProvider,
  LlmRuntimeConfig,
  ObservabilityTelemetryConfig,
  OpenAiApiStyle,
  OpenTelemetryProvider,
  PhoenixTelemetryConfig,
} from "../integrations/llm/types.js";

const ConfigSchema = z
  .object({
    memoryCabin: z.unknown().optional(),
    jiraRest: z
      .object({
        jiraUrl: z.string().url().optional(),
        jiraUsername: z.string().min(1).optional(),
        jiraApiToken: z.string().min(1).optional(),
        jiraCloudId: z.string().min(1).optional(),
        confluenceUrl: z.string().url().optional(),
        confluenceUsername: z.string().min(1).optional(),
        confluenceApiToken: z.string().min(1).optional(),
        includeConfluence: z.boolean().optional(),
      })
      .strict()
      .optional(),
    azureDevOps: z
      .object({
        token: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    github: z
      .object({
        token: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    openAi: z
      .object({
        apiKey: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
      })
      .strict()
      .optional(),
    llm: z
      .object({
        provider: z.enum(["openai", "anthropic"]).optional(),
        apiKey: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
        apiVersion: z.string().min(1).optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        apiStyle: z.enum(["responses", "chat-completions"]).optional(),
      })
      .strict()
      .optional(),
    implementationLlm: z
      .object({
        provider: z.enum(["openai", "anthropic"]).optional(),
        apiKey: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
        apiVersion: z.string().min(1).optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        apiStyle: z.enum(["responses", "chat-completions"]).optional(),
      })
      .strict()
      .optional(),
    observability: z
      .object({
        provider: z.enum(["phoenix", "langfuse"]).optional(),
        enabled: z.boolean().optional(),
        projectName: z.string().min(1).optional(),
        url: z.string().url().optional(),
        apiKey: z.string().min(1).optional(),
        publicKey: z.string().min(1).optional(),
        secretKey: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
        batch: z.boolean().optional(),
      })
      .strict()
      .optional(),
    xray: z
      .object({
        baseUrl: z.string().url().optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        testIssueLinkType: z.string().min(1).optional(),
        testIssueLinkDirection: z.enum(["test-to-ticket", "ticket-to-test"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface CliOptions {
  configPath?: string;
}

export interface RuntimeConfig {
  memoryCabin?: MemoryCabinConfig;
  jiraRest?: {
    jiraUrl: string;
    jiraUsername: string;
    jiraApiToken: string;
    jiraCloudId?: string;
    confluenceUrl?: string;
    confluenceUsername?: string;
    confluenceApiToken?: string;
    includeConfluence: boolean;
  };
  azureDevOps?: {
    token: string;
  };
  github?: {
    token: string;
  };
  llm?: LlmRuntimeConfig;
  /**
   * Optional override for the implementation half (Codex / Claude Agent SDK).
   * When unset, the implementation falls back to the design `llm`. This lets
   * you mix providers, e.g. Azure GPT for design + Anthropic Claude for implement.
   */
  implementationLlm?: LlmRuntimeConfig;
  observability?: {
    provider: OpenTelemetryProvider;
    telemetry: ObservabilityTelemetryConfig;
  };
  openAi?: {
    apiKey: string;
    model: string;
    baseUrl?: string;
  };
  xray?: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    testIssueLinkType: string;
    testIssueLinkDirection: "test-to-ticket" | "ticket-to-test";
  };
}

export async function loadRuntimeConfig(options: CliOptions = {}): Promise<RuntimeConfig> {
  const fileConfig = options.configPath
    ? ConfigSchema.parse(JSON.parse(await readFile(options.configPath, "utf8")))
    : {};

  const jiraRest = loadJiraRestConfig(fileConfig.jiraRest ?? {});
  const azureDevOps = loadAzureDevOpsConfig(fileConfig.azureDevOps ?? {});
  const github = loadGitHubConfig(fileConfig.github ?? {});
  const llm = loadLlmConfig(fileConfig.llm ?? {}, fileConfig.openAi ?? {});
  const implementationLlm = loadImplementationLlmConfig(fileConfig.implementationLlm ?? {});
  const observability = loadObservabilityConfig(fileConfig.observability ?? {});
  const openAi = loadOpenAiConfig(fileConfig.openAi ?? {}, llm);
  const xray = loadXrayConfig(fileConfig.xray ?? {});
  const memoryCabin = loadMemoryCabinConfig(fileConfig.memoryCabin ?? {});

  return {
    ...(memoryCabin.enabled ? { memoryCabin } : {}),
    ...(jiraRest ? { jiraRest } : {}),
    ...(azureDevOps ? { azureDevOps } : {}),
    ...(github ? { github } : {}),
    ...(llm ? { llm } : {}),
    ...(implementationLlm ? { implementationLlm } : {}),
    ...(observability ? { observability } : {}),
    ...(openAi ? { openAi } : {}),
    ...(xray ? { xray } : {}),
  };
}

function loadJiraRestConfig(configured: NonNullable<z.infer<typeof ConfigSchema>["jiraRest"]>): RuntimeConfig["jiraRest"] | undefined {
  const jiraUrl = configured.jiraUrl ?? process.env.JIRA_URL;
  const jiraUsername = configured.jiraUsername ?? process.env.JIRA_USERNAME;
  const jiraApiToken = configured.jiraApiToken ?? process.env.JIRA_API_TOKEN;
  const jiraCloudId = configured.jiraCloudId ?? process.env.JIRA_CLOUD_ID;

  if (!jiraUrl || !jiraUsername || !jiraApiToken) {
    return undefined;
  }

  const includeConfluence = parseBoolean(process.env.CONFLUENCE_ENABLED, configured.includeConfluence ?? true);
  const confluenceUrl = includeConfluence
    ? configured.confluenceUrl ?? process.env.CONFLUENCE_URL ?? `${jiraUrl.replace(/\/+$/, "")}/wiki`
    : undefined;
  const confluenceUsername = includeConfluence
    ? configured.confluenceUsername ?? process.env.CONFLUENCE_USERNAME ?? jiraUsername
    : undefined;
  const confluenceApiToken = includeConfluence
    ? configured.confluenceApiToken ?? process.env.CONFLUENCE_API_TOKEN ?? jiraApiToken
    : undefined;
  return {
    jiraUrl,
    jiraUsername,
    jiraApiToken,
    ...(jiraCloudId ? { jiraCloudId } : {}),
    ...(confluenceUrl && confluenceUsername && confluenceApiToken
      ? {
          confluenceUrl,
          confluenceUsername,
          confluenceApiToken,
        }
      : {}),
    includeConfluence,
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function loadAzureDevOpsConfig(configured: NonNullable<z.infer<typeof ConfigSchema>["azureDevOps"]>): RuntimeConfig["azureDevOps"] | undefined {
  const token = configured.token ?? process.env.AZURE_DEVOPS_PAT ?? process.env.AZURE_DEVOPS_TOKEN ?? process.env.SYSTEM_ACCESSTOKEN;

  return token ? { token } : undefined;
}

function loadGitHubConfig(configured: NonNullable<z.infer<typeof ConfigSchema>["github"]>): RuntimeConfig["github"] | undefined {
  const token = configured.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  return token ? { token } : undefined;
}

function loadObservabilityConfig(
  configured: NonNullable<z.infer<typeof ConfigSchema>["observability"]>,
): RuntimeConfig["observability"] | undefined {
  const enabled = configured.enabled ?? parseBoolean(nonEmpty(process.env.OTEL_ENABLED), false);
  if (!enabled) {
    return undefined;
  }

  const selectedProvider = parseOpenTelemetryProvider(configured.provider ?? nonEmpty(process.env.OTEL_PROVIDER) ?? "phoenix");
  if (selectedProvider === "phoenix") {
    const phoenix = loadPhoenixTelemetryConfig(configured, enabled);
    return {
      provider: "phoenix",
      telemetry: { ...phoenix, provider: "phoenix" },
    };
  }

  const langfuse = loadLangfuseTelemetryConfig(configured, enabled);
  return {
    provider: "langfuse",
    telemetry: { ...langfuse, provider: "langfuse" },
  };
}

function loadPhoenixTelemetryConfig(
  configured: NonNullable<z.infer<typeof ConfigSchema>["observability"]>,
  enabled: boolean,
): PhoenixTelemetryConfig {
  const projectName =
    configured.projectName ??
    nonEmpty(process.env.OTEL_PROJECT_NAME) ??
    "manso";
  const url =
    configured.url ??
    nonEmpty(process.env.OTEL_ENDPOINT) ??
    nonEmpty(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ??
    nonEmpty(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const apiKey = configured.apiKey ?? nonEmpty(process.env.OTEL_API_KEY);
  const sessionId = configured.sessionId ?? nonEmpty(process.env.OTEL_SESSION_ID);
  const userId = resolveObservabilityUserId(configured);
  const batch = configured.batch ?? parseBoolean(nonEmpty(process.env.OTEL_BATCH), true);

  return {
    enabled,
    projectName,
    ...(url ? { url } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(userId ? { userId } : {}),
    batch,
  };
}

function loadLangfuseTelemetryConfig(
  configured: NonNullable<z.infer<typeof ConfigSchema>["observability"]>,
  enabled: boolean,
): LangfuseTelemetryConfig {
  const publicKey = configured.publicKey ?? nonEmpty(process.env.OTEL_PUBLIC_KEY);
  const secretKey = configured.secretKey ?? nonEmpty(process.env.OTEL_SECRET_KEY);
  if (!publicKey || !secretKey) {
    throw new Error("Langfuse telemetry requires OTEL_PUBLIC_KEY and OTEL_SECRET_KEY, or observability publicKey and secretKey.");
  }

  const projectName =
    configured.projectName ??
    nonEmpty(process.env.OTEL_PROJECT_NAME) ??
    "manso";
  const url =
    configured.url ??
    nonEmpty(process.env.OTEL_ENDPOINT) ??
    nonEmpty(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ??
    nonEmpty(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const sessionId = configured.sessionId ?? nonEmpty(process.env.OTEL_SESSION_ID);
  const userId = resolveObservabilityUserId(configured);
  const batch = configured.batch ?? parseBoolean(nonEmpty(process.env.OTEL_BATCH), true);

  return {
    enabled,
    projectName,
    ...(url ? { url } : {}),
    publicKey,
    secretKey,
    ...(sessionId ? { sessionId } : {}),
    ...(userId ? { userId } : {}),
    batch,
  };
}

function resolveObservabilityUserId(configured: NonNullable<z.infer<typeof ConfigSchema>["observability"]>): string | undefined {
  return nonEmpty(process.env.BUILD_REQUESTEDFOREMAIL) ??
    nonEmpty(process.env.RELEASE_REQUESTEDFOREMAIL) ??
    nonEmpty(process.env.SYSTEM_PULLREQUEST_SOURCECOMMITTEREMAIL) ??
    nonEmpty(process.env.BUILD_REQUESTEDFORID) ??
    nonEmpty(process.env.BUILD_REQUESTEDFOR) ??
    configured.userId ??
    nonEmpty(process.env.OTEL_USER_ID);
}

function loadOpenAiConfig(
  configured: NonNullable<z.infer<typeof ConfigSchema>["openAi"]>,
  llm: RuntimeConfig["llm"],
): RuntimeConfig["openAi"] | undefined {
  if (llm?.provider === "openai") {
    return {
      apiKey: llm.apiKey,
      model: llm.model,
      ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
    };
  }

  const apiKey = configured.apiKey ?? process.env.OPENAI_API_KEY;
  const model = configured.model ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
  const baseUrl = configured.baseUrl ?? process.env.OPENAI_BASE_URL;

  if (!apiKey) {
    return undefined;
  }

  return {
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function loadLlmConfig(
  configured: NonNullable<z.infer<typeof ConfigSchema>["llm"]>,
  configuredOpenAi: NonNullable<z.infer<typeof ConfigSchema>["openAi"]>,
): RuntimeConfig["llm"] | undefined {
  const provider = parseLlmProvider(configured.provider ?? nonEmpty(process.env.LLM_PROVIDER) ?? "openai");
  if (provider === "openai") {
    const apiKey = configured.apiKey ?? nonEmpty(process.env.LLM_API_KEY) ?? configuredOpenAi.apiKey ?? nonEmpty(process.env.OPENAI_API_KEY);
    const model = configured.model ?? nonEmpty(process.env.LLM_MODEL) ?? configuredOpenAi.model ?? nonEmpty(process.env.OPENAI_MODEL) ?? "gpt-5.5";
    const baseUrl = configured.baseUrl ?? nonEmpty(process.env.LLM_BASE_URL) ?? configuredOpenAi.baseUrl ?? nonEmpty(process.env.OPENAI_BASE_URL);

    if (!apiKey) {
      return undefined;
    }

    const maxOutputTokens = configured.maxOutputTokens ?? parseOptionalPositiveInteger(
      nonEmpty(process.env.LLM_MAX_OUTPUT_TOKENS) ?? nonEmpty(process.env.OPENAI_MAX_OUTPUT_TOKENS),
      provider,
    );

    const apiStyle = resolveOpenAiApiStyle(configured.apiStyle, baseUrl);

    return {
      provider,
      apiKey,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      apiStyle,
    };
  }

  const apiKey = configured.apiKey ?? nonEmpty(process.env.LLM_API_KEY) ?? nonEmpty(process.env.ANTHROPIC_API_KEY);
  const model = configured.model ?? nonEmpty(process.env.LLM_MODEL) ?? nonEmpty(process.env.ANTHROPIC_MODEL) ?? "claude-sonnet-4-6";
  const baseUrl = configured.baseUrl ?? nonEmpty(process.env.LLM_BASE_URL) ?? nonEmpty(process.env.ANTHROPIC_BASE_URL);
  const apiVersion =
    configured.apiVersion ?? nonEmpty(process.env.LLM_API_VERSION) ?? nonEmpty(process.env.ANTHROPIC_API_VERSION) ?? "2023-06-01";

  if (!apiKey) {
    return undefined;
  }

  const maxOutputTokens =
    configured.maxOutputTokens ??
    parseOptionalPositiveInteger(nonEmpty(process.env.LLM_MAX_OUTPUT_TOKENS) ?? nonEmpty(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS), provider) ??
    16_000;

  return {
    provider,
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    apiVersion,
    maxOutputTokens,
  };
}

/**
 * Resolve an optional implementation-only LLM override. Returns undefined when
 * no IMPLEMENTATION_LLM_* env var is set and no `implementationLlm` block is
 * supplied — in that case the implementation half reuses the design `llm`.
 *
 * When opted into, the resolver follows the same defaulting + env-var
 * fallback shape as `loadLlmConfig`, but is read from `IMPLEMENTATION_LLM_*`
 * (with provider-prefixed fallbacks like `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
 */
function loadImplementationLlmConfig(
  configured: NonNullable<z.infer<typeof ConfigSchema>["implementationLlm"]>,
): LlmRuntimeConfig | undefined {
  const explicitProvider = configured.provider ?? nonEmpty(process.env.IMPLEMENTATION_LLM_PROVIDER);
  const explicitApiKey = configured.apiKey ?? nonEmpty(process.env.IMPLEMENTATION_LLM_API_KEY);
  const explicitModel = configured.model ?? nonEmpty(process.env.IMPLEMENTATION_LLM_MODEL);
  const explicitBaseUrl = configured.baseUrl ?? nonEmpty(process.env.IMPLEMENTATION_LLM_BASE_URL);

  // No opt-in signal at all — caller falls back to the design LLM.
  if (!explicitProvider && !explicitApiKey && !explicitModel && !explicitBaseUrl) {
    return undefined;
  }

  const provider = parseLlmProvider(explicitProvider ?? "openai");

  if (provider === "openai") {
    const apiKey = explicitApiKey ?? nonEmpty(process.env.OPENAI_API_KEY);
    if (!apiKey) {
      return undefined;
    }
    const model = explicitModel ?? nonEmpty(process.env.OPENAI_MODEL) ?? "gpt-5";
    const baseUrl = explicitBaseUrl ?? nonEmpty(process.env.OPENAI_BASE_URL);
    const maxOutputTokens = configured.maxOutputTokens ?? parseOptionalPositiveInteger(
      nonEmpty(process.env.IMPLEMENTATION_LLM_MAX_OUTPUT_TOKENS),
      provider,
    );
    const apiStyle = resolveOpenAiApiStyle(configured.apiStyle, baseUrl);
    return {
      provider,
      apiKey,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      apiStyle,
    };
  }

  const apiKey = explicitApiKey ?? nonEmpty(process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    return undefined;
  }
  const model = explicitModel ?? nonEmpty(process.env.ANTHROPIC_MODEL) ?? "claude-sonnet-4-6";
  const baseUrl = explicitBaseUrl ?? nonEmpty(process.env.ANTHROPIC_BASE_URL);
  const apiVersion = configured.apiVersion ?? nonEmpty(process.env.IMPLEMENTATION_LLM_API_VERSION) ?? nonEmpty(process.env.ANTHROPIC_API_VERSION) ?? "2023-06-01";
  const maxOutputTokens = configured.maxOutputTokens ?? parseOptionalPositiveInteger(
    nonEmpty(process.env.IMPLEMENTATION_LLM_MAX_OUTPUT_TOKENS) ?? nonEmpty(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS),
    provider,
  ) ?? 16_000;

  return {
    provider,
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    apiVersion,
    maxOutputTokens,
  };
}

function parseLlmProvider(value: string): LlmProvider {
  if (value === "openai" || value === "anthropic") {
    return value;
  }

  throw new Error(`LLM provider must be one of: openai, anthropic. Actual value: ${value}`);
}

/**
 * Pick the OpenAI API style — explicit config wins, then `LLM_API_STYLE` env,
 * then auto-detect from the base URL. Azure OpenAI defaults to chat-completions
 * because the Responses API is regionally rolled out and unavailable in many
 * tenants today.
 */
function resolveOpenAiApiStyle(
  configured: OpenAiApiStyle | undefined,
  baseUrl: string | undefined,
): OpenAiApiStyle {
  if (configured === "responses" || configured === "chat-completions") {
    return configured;
  }
  const envValue = nonEmpty(process.env.LLM_API_STYLE);
  if (envValue === "responses" || envValue === "chat-completions") {
    return envValue;
  }
  if (baseUrl && /openai\.azure\.com|\.azure-api\.net/i.test(baseUrl)) {
    return "chat-completions";
  }
  return "responses";
}

function parseOpenTelemetryProvider(value: string): OpenTelemetryProvider {
  if (value === "phoenix" || value === "langfuse") {
    return value;
  }

  throw new Error(`OpenTelemetry provider must be one of: phoenix, langfuse. Actual value: ${value}`);
}

function parseOptionalPositiveInteger(value: string | undefined, provider: LlmProvider): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`LLM max output tokens for ${provider} must be a positive integer. Actual value: ${value}`);
  }

  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  // An unmapped Azure Pipelines variable arrives as the literal "$(NAME)" —
  // treat that (and blank) as unset so an undefined optional var can't poison
  // config (e.g. an unset IMPLEMENTATION_LLM_BASE_URL becoming a bad base URL).
  if (trimmed.length === 0 || /^\$\([A-Za-z0-9_.]+\)$/.test(trimmed)) {
    return undefined;
  }

  return value;
}

function loadXrayConfig(configured: NonNullable<z.infer<typeof ConfigSchema>["xray"]>): RuntimeConfig["xray"] | undefined {
  const clientId = configured.clientId ?? process.env.XRAY_CLIENT_ID;
  const clientSecret = configured.clientSecret ?? process.env.XRAY_CLIENT_SECRET;
  const baseUrl = configured.baseUrl ?? process.env.XRAY_BASE_URL ?? "https://xray.cloud.getxray.app";
  // Default to the "is tested by" relationship so the STORY shows it (the
  // resolver derives the link direction from this phrase). Static for our Jira;
  // still overridable via XRAY_TEST_LINK_TYPE for instances that differ.
  const testIssueLinkType = configured.testIssueLinkType ?? process.env.XRAY_TEST_LINK_TYPE ?? "is tested by";
  const testIssueLinkDirection = parseXrayTestLinkDirection(
    configured.testIssueLinkDirection ?? process.env.XRAY_TEST_LINK_DIRECTION,
  );

  if (!clientId || !clientSecret) {
    return undefined;
  }

  return {
    baseUrl,
    clientId,
    clientSecret,
    testIssueLinkType,
    testIssueLinkDirection,
  };
}

function parseXrayTestLinkDirection(value: string | undefined): "test-to-ticket" | "ticket-to-test" {
  if (value === "ticket-to-test") {
    return "ticket-to-test";
  }

  return "test-to-ticket";
}
