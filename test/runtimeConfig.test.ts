import { afterEach, describe, expect, it } from "vitest";
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
    expect(config.openAi).toEqual({
      apiKey: "openai-token",
      model: "gpt-test",
      baseUrl: "https://openai.example/v1",
    });
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
