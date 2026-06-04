import { describe, expect, it } from "vitest";
import {
  azurePullRequestSessionId,
  buildOtlpTraceExporterConfig,
  ensureLangfuseOtlpTraceEndpoint,
  ensurePhoenixOtlpTraceEndpoint,
  formatOtlpHeaders,
  jiraIssueSessionId,
  normalizeSessionId,
  normalizeUserId,
  sessionSpanAttributes,
  userSpanAttributes,
} from "../src/integrations/llm/telemetry/observability.js";

describe("observability telemetry", () => {
  it("normalizes Phoenix and Langfuse OTLP trace endpoints", () => {
    expect(ensurePhoenixOtlpTraceEndpoint("http://localhost:6006")).toBe("http://localhost:6006/v1/traces");
    expect(ensurePhoenixOtlpTraceEndpoint("http://localhost:6006/v1/traces")).toBe("http://localhost:6006/v1/traces");
    expect(ensureLangfuseOtlpTraceEndpoint("https://cloud.langfuse.com")).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    expect(ensureLangfuseOtlpTraceEndpoint("https://cloud.langfuse.com/api/public/otel")).toBe(
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });

  it("builds Langfuse OTLP headers from public and secret keys", () => {
    const config = buildOtlpTraceExporterConfig({
      provider: "langfuse",
      enabled: true,
      projectName: "agent-costs",
      url: "https://us.cloud.langfuse.com",
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      batch: true,
    });

    expect(config.endpoint).toBe("https://us.cloud.langfuse.com/api/public/otel/v1/traces");
    expect(config.headers).toEqual({
      Authorization: `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
      "x-langfuse-ingestion-version": "4",
    });
    expect(formatOtlpHeaders(config.headers)).toBe(
      `Authorization=Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")},x-langfuse-ingestion-version=4`,
    );
  });

  it("builds provider-neutral session attributes for Langfuse sessions", () => {
    expect(jiraIssueSessionId(" demo-123 ")).toBe("jira:DEMO-123");
    expect(azurePullRequestSessionId({
      organization: "example-org",
      project: "sample-project",
      repository: "sample-repository",
      pullRequestId: 138545,
    })).toBe("ado-pr:example-org/sample-project/sample-repository/138545");
    expect(azurePullRequestSessionId({
      organization: "example-org",
      project: "sample-project",
      repository: "repo",
      pullRequestId: 1,
      ticketKey: "help-456",
    })).toBe("jira:HELP-456");
    expect(sessionSpanAttributes("jira:DEMO-123")).toEqual({
      "session.id": "jira:DEMO-123",
      "langfuse.session.id": "jira:DEMO-123",
    });
    expect(userSpanAttributes("ado.requester@example.com")).toEqual({
      "user.id": "ado.requester@example.com",
      "langfuse.user.id": "ado.requester@example.com",
    });
  });

  it("normalizes session and user IDs to Langfuse's 200 character limit", () => {
    expect(normalizeSessionId("  shared-session  ")).toBe("shared-session");
    expect(normalizeSessionId("x".repeat(201))).toHaveLength(200);
    expect(normalizeSessionId("   ")).toBeUndefined();
    expect(normalizeUserId("  user@example.com  ")).toBe("user@example.com");
    expect(normalizeUserId("x".repeat(201))).toHaveLength(200);
    expect(normalizeUserId("   ")).toBeUndefined();
  });
});
