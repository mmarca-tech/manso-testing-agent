import { readFile } from "node:fs/promises";
import { z } from "zod";

const ConfigSchema = z
  .object({
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
    openAi: z
      .object({
        apiKey: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
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
  const openAi = loadOpenAiConfig(fileConfig.openAi ?? {});
  const xray = loadXrayConfig(fileConfig.xray ?? {});

  return {
    ...(jiraRest ? { jiraRest } : {}),
    ...(azureDevOps ? { azureDevOps } : {}),
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

function loadOpenAiConfig(configured: NonNullable<z.infer<typeof ConfigSchema>["openAi"]>): RuntimeConfig["openAi"] | undefined {
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

function loadXrayConfig(configured: NonNullable<z.infer<typeof ConfigSchema>["xray"]>): RuntimeConfig["xray"] | undefined {
  const clientId = configured.clientId ?? process.env.XRAY_CLIENT_ID;
  const clientSecret = configured.clientSecret ?? process.env.XRAY_CLIENT_SECRET;
  const baseUrl = configured.baseUrl ?? process.env.XRAY_BASE_URL ?? "https://xray.cloud.getxray.app";
  const testIssueLinkType = configured.testIssueLinkType ?? process.env.XRAY_TEST_LINK_TYPE ?? "tests";
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
