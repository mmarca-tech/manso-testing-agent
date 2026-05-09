import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";

const originalJiraUrl = process.env.JIRA_URL;
const originalJiraUsername = process.env.JIRA_USERNAME;
const originalJiraApiToken = process.env.JIRA_API_TOKEN;
const originalJiraCloudId = process.env.JIRA_CLOUD_ID;
const originalConfluenceUrl = process.env.CONFLUENCE_URL;
const originalConfluenceUsername = process.env.CONFLUENCE_USERNAME;
const originalConfluenceApiToken = process.env.CONFLUENCE_API_TOKEN;
const originalConfluenceEnabled = process.env.CONFLUENCE_ENABLED;
const originalAzureDevOpsPat = process.env.AZURE_DEVOPS_PAT;
const originalAzureDevOpsToken = process.env.AZURE_DEVOPS_TOKEN;
const originalSystemAccessToken = process.env.SYSTEM_ACCESSTOKEN;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiModel = process.env.OPENAI_MODEL;
const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAiMaxOutputTokens = process.env.OPENAI_MAX_OUTPUT_TOKENS;
const originalLlmProvider = process.env.LLM_PROVIDER;
const originalLlmApiKey = process.env.LLM_API_KEY;
const originalLlmModel = process.env.LLM_MODEL;
const originalLlmBaseUrl = process.env.LLM_BASE_URL;
const originalLlmApiVersion = process.env.LLM_API_VERSION;
const originalLlmMaxOutputTokens = process.env.LLM_MAX_OUTPUT_TOKENS;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicModel = process.env.ANTHROPIC_MODEL;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAnthropicApiVersion = process.env.ANTHROPIC_API_VERSION;
const originalAnthropicMaxOutputTokens = process.env.ANTHROPIC_MAX_OUTPUT_TOKENS;
const originalPhoenixEnabled = process.env.PHOENIX_ENABLED;
const originalPhoenixProjectName = process.env.PHOENIX_PROJECT_NAME;
const originalPhoenixCollectorEndpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;
const originalPhoenixUrl = process.env.PHOENIX_URL;
const originalPhoenixApiKey = process.env.PHOENIX_API_KEY;
const originalPhoenixBatch = process.env.PHOENIX_BATCH;
const originalXrayBaseUrl = process.env.XRAY_BASE_URL;
const originalXrayClientId = process.env.XRAY_CLIENT_ID;
const originalXrayClientSecret = process.env.XRAY_CLIENT_SECRET;
const originalXrayTestLinkType = process.env.XRAY_TEST_LINK_TYPE;
const originalXrayTestLinkDirection = process.env.XRAY_TEST_LINK_DIRECTION;

describe("loadRuntimeConfig", () => {
  afterEach(() => {
    restoreEnv("JIRA_URL", originalJiraUrl);
    restoreEnv("JIRA_USERNAME", originalJiraUsername);
    restoreEnv("JIRA_API_TOKEN", originalJiraApiToken);
    restoreEnv("JIRA_CLOUD_ID", originalJiraCloudId);
    restoreEnv("CONFLUENCE_URL", originalConfluenceUrl);
    restoreEnv("CONFLUENCE_USERNAME", originalConfluenceUsername);
    restoreEnv("CONFLUENCE_API_TOKEN", originalConfluenceApiToken);
    restoreEnv("CONFLUENCE_ENABLED", originalConfluenceEnabled);
    restoreEnv("AZURE_DEVOPS_PAT", originalAzureDevOpsPat);
    restoreEnv("AZURE_DEVOPS_TOKEN", originalAzureDevOpsToken);
    restoreEnv("SYSTEM_ACCESSTOKEN", originalSystemAccessToken);
    restoreEnv("OPENAI_API_KEY", originalOpenAiApiKey);
    restoreEnv("OPENAI_MODEL", originalOpenAiModel);
    restoreEnv("OPENAI_BASE_URL", originalOpenAiBaseUrl);
    restoreEnv("OPENAI_MAX_OUTPUT_TOKENS", originalOpenAiMaxOutputTokens);
    restoreEnv("LLM_PROVIDER", originalLlmProvider);
    restoreEnv("LLM_API_KEY", originalLlmApiKey);
    restoreEnv("LLM_MODEL", originalLlmModel);
    restoreEnv("LLM_BASE_URL", originalLlmBaseUrl);
    restoreEnv("LLM_API_VERSION", originalLlmApiVersion);
    restoreEnv("LLM_MAX_OUTPUT_TOKENS", originalLlmMaxOutputTokens);
    restoreEnv("ANTHROPIC_API_KEY", originalAnthropicApiKey);
    restoreEnv("ANTHROPIC_MODEL", originalAnthropicModel);
    restoreEnv("ANTHROPIC_BASE_URL", originalAnthropicBaseUrl);
    restoreEnv("ANTHROPIC_API_VERSION", originalAnthropicApiVersion);
    restoreEnv("ANTHROPIC_MAX_OUTPUT_TOKENS", originalAnthropicMaxOutputTokens);
    restoreEnv("PHOENIX_ENABLED", originalPhoenixEnabled);
    restoreEnv("PHOENIX_PROJECT_NAME", originalPhoenixProjectName);
    restoreEnv("PHOENIX_COLLECTOR_ENDPOINT", originalPhoenixCollectorEndpoint);
    restoreEnv("PHOENIX_URL", originalPhoenixUrl);
    restoreEnv("PHOENIX_API_KEY", originalPhoenixApiKey);
    restoreEnv("PHOENIX_BATCH", originalPhoenixBatch);
    restoreEnv("XRAY_BASE_URL", originalXrayBaseUrl);
    restoreEnv("XRAY_CLIENT_ID", originalXrayClientId);
    restoreEnv("XRAY_CLIENT_SECRET", originalXrayClientSecret);
    restoreEnv("XRAY_TEST_LINK_TYPE", originalXrayTestLinkType);
    restoreEnv("XRAY_TEST_LINK_DIRECTION", originalXrayTestLinkDirection);
  });

  it("loads Jira REST credentials from environment variables", async () => {
    process.env.JIRA_URL = "https://example.atlassian.net";
    process.env.JIRA_USERNAME = "user@example.com";
    process.env.JIRA_API_TOKEN = "token";
    process.env.JIRA_CLOUD_ID = "cloud-1";
    delete process.env.CONFLUENCE_URL;
    delete process.env.CONFLUENCE_USERNAME;
    delete process.env.CONFLUENCE_API_TOKEN;
    delete process.env.CONFLUENCE_ENABLED;

    const config = await loadRuntimeConfig();

    expect(config.jiraRest).toEqual(
      expect.objectContaining({
        jiraUrl: "https://example.atlassian.net",
        jiraUsername: "user@example.com",
        jiraApiToken: "token",
        jiraCloudId: "cloud-1",
        confluenceUrl: "https://example.atlassian.net/wiki",
        confluenceUsername: "user@example.com",
        confluenceApiToken: "token",
        includeConfluence: true,
      }),
    );
  });

  it("returns no Jira REST config when required credentials are missing", async () => {
    delete process.env.JIRA_URL;
    delete process.env.JIRA_USERNAME;
    delete process.env.JIRA_API_TOKEN;

    const config = await loadRuntimeConfig();

    expect(config.jiraRest).toBeUndefined();
  });

  it("can disable Confluence REST configuration", async () => {
    process.env.JIRA_URL = "https://example.atlassian.net";
    process.env.JIRA_USERNAME = "user@example.com";
    process.env.JIRA_API_TOKEN = "token";
    process.env.CONFLUENCE_ENABLED = "false";

    const config = await loadRuntimeConfig();

    expect(config.jiraRest).toEqual(
      expect.objectContaining({
        jiraUrl: "https://example.atlassian.net",
        includeConfluence: false,
      }),
    );
    expect(config.jiraRest?.confluenceUrl).toBeUndefined();
    expect(config.jiraRest?.confluenceUsername).toBeUndefined();
    expect(config.jiraRest?.confluenceApiToken).toBeUndefined();
  });

  it("loads Azure DevOps and OpenAI settings for PR change summaries", async () => {
    process.env.AZURE_DEVOPS_PAT = "ado-token";
    process.env.OPENAI_API_KEY = "openai-token";
    process.env.OPENAI_MODEL = "gpt-test";
    process.env.OPENAI_BASE_URL = "https://openai.example/v1";

    const config = await loadRuntimeConfig();

    expect(config.azureDevOps).toEqual({ token: "ado-token" });
    expect(config.llm).toEqual({
      provider: "openai",
      apiKey: "openai-token",
      model: "gpt-test",
      baseUrl: "https://openai.example/v1",
    });
    expect(config.openAi).toEqual({
      apiKey: "openai-token",
      model: "gpt-test",
      baseUrl: "https://openai.example/v1",
    });
  });

  it("loads generic LLM settings before provider-specific environment variables", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_API_KEY = "generic-token";
    process.env.LLM_MODEL = "generic-model";
    process.env.LLM_BASE_URL = "https://llm.example/v1";
    process.env.LLM_API_VERSION = "2024-01-01";
    process.env.LLM_MAX_OUTPUT_TOKENS = "1234";
    process.env.ANTHROPIC_API_KEY = "anthropic-token";
    process.env.ANTHROPIC_MODEL = "claude-provider-specific";

    const config = await loadRuntimeConfig();

    expect(config.llm).toEqual({
      provider: "anthropic",
      apiKey: "generic-token",
      model: "generic-model",
      baseUrl: "https://llm.example/v1",
      apiVersion: "2024-01-01",
      maxOutputTokens: 1234,
    });
  });

  it("prefers config file LLM settings over environment variables", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_API_KEY = "env-token";
    process.env.LLM_MODEL = "env-model";
    const tempDir = await mkdtemp(join(tmpdir(), "manso-runtime-config-"));
    const configPath = join(tempDir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          llm: {
            provider: "anthropic",
            apiKey: "file-token",
            model: "file-model",
            baseUrl: "https://file.example/v1",
            apiVersion: "2025-01-01",
            maxOutputTokens: 777,
          },
        }),
      );

      const config = await loadRuntimeConfig({ configPath });

      expect(config.llm).toEqual({
        provider: "anthropic",
        apiKey: "file-token",
        model: "file-model",
        baseUrl: "https://file.example/v1",
        apiVersion: "2025-01-01",
        maxOutputTokens: 777,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads Anthropic provider-specific settings when selected", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "anthropic-token";
    process.env.ANTHROPIC_MODEL = "claude-test";
    process.env.ANTHROPIC_BASE_URL = "https://anthropic.example/v1";
    process.env.ANTHROPIC_API_VERSION = "2024-02-02";
    process.env.ANTHROPIC_MAX_OUTPUT_TOKENS = "4096";

    const config = await loadRuntimeConfig();

    expect(config.llm).toEqual({
      provider: "anthropic",
      apiKey: "anthropic-token",
      model: "claude-test",
      baseUrl: "https://anthropic.example/v1",
      apiVersion: "2024-02-02",
      maxOutputTokens: 4096,
    });
  });

  it("returns no LLM config when the selected provider has no API key", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;

    const config = await loadRuntimeConfig();

    expect(config.llm).toBeUndefined();
  });

  it("rejects unsupported LLM providers", async () => {
    process.env.LLM_PROVIDER = "unsupported";
    process.env.LLM_API_KEY = "token";

    await expect(loadRuntimeConfig()).rejects.toThrow("LLM provider must be one of: openai, anthropic");
  });

  it("loads Phoenix telemetry settings when enabled", async () => {
    process.env.PHOENIX_ENABLED = "true";
    process.env.PHOENIX_PROJECT_NAME = "agent-costs";
    process.env.PHOENIX_COLLECTOR_ENDPOINT = "https://phoenix.example/v1/traces";
    process.env.PHOENIX_API_KEY = "phoenix-token";
    process.env.PHOENIX_BATCH = "false";

    const config = await loadRuntimeConfig();

    expect(config.observability?.phoenix).toEqual({
      enabled: true,
      projectName: "agent-costs",
      url: "https://phoenix.example/v1/traces",
      apiKey: "phoenix-token",
      batch: false,
    });
  });

  it("prefers config file Phoenix telemetry settings over environment variables", async () => {
    process.env.PHOENIX_ENABLED = "true";
    process.env.PHOENIX_PROJECT_NAME = "env-project";
    process.env.PHOENIX_URL = "https://env-phoenix.example";
    const tempDir = await mkdtemp(join(tmpdir(), "manso-runtime-config-"));
    const configPath = join(tempDir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          observability: {
            phoenix: {
              enabled: true,
              projectName: "file-project",
              url: "https://file-phoenix.example",
              apiKey: "file-token",
              batch: false,
            },
          },
        }),
      );

      const config = await loadRuntimeConfig({ configPath });

      expect(config.observability?.phoenix).toEqual({
        enabled: true,
        projectName: "file-project",
        url: "https://file-phoenix.example",
        apiKey: "file-token",
        batch: false,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads Xray Cloud settings for test generation", async () => {
    process.env.XRAY_BASE_URL = "https://eu.xray.cloud.getxray.app";
    process.env.XRAY_CLIENT_ID = "xray-client";
    process.env.XRAY_CLIENT_SECRET = "xray-secret";
    process.env.XRAY_TEST_LINK_TYPE = "tests";
    process.env.XRAY_TEST_LINK_DIRECTION = "ticket-to-test";

    const config = await loadRuntimeConfig();

    expect(config.xray).toEqual({
      baseUrl: "https://eu.xray.cloud.getxray.app",
      clientId: "xray-client",
      clientSecret: "xray-secret",
      testIssueLinkType: "tests",
      testIssueLinkDirection: "ticket-to-test",
    });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
