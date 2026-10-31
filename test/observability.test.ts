import { describe, expect, it } from "vitest";
import {
  buildOtlpTraceExporterConfig,
  ensureLangfuseOtlpTraceEndpoint,
  ensurePhoenixOtlpTraceEndpoint,
  flushTelemetry,
  formatOtlpHeaders,
  jiraIssueSessionId,
  normalizeSessionId,
  withTelemetrySession,
} from "../src/integrations/llm/telemetry/observability.js";
import { isTelemetryActive } from "../src/integrations/llm/telemetry/state.js";

describe("Langfuse OTLP endpoint", () => {
  it("appends the OTel traces path to a base URL", () => {
    expect(ensureLangfuseOtlpTraceEndpoint("https://cloud.langfuse.com")).toBe(
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });

  it("is idempotent when the full path is already present", () => {
    const full = "https://cloud.langfuse.com/api/public/otel/v1/traces";
    expect(ensureLangfuseOtlpTraceEndpoint(full)).toBe(full);
  });

  it("completes a partial /api/public/otel base", () => {
    expect(ensureLangfuseOtlpTraceEndpoint("https://eu.cloud.langfuse.com/api/public/otel")).toBe(
      "https://eu.cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });
});

describe("Phoenix OTLP endpoint", () => {
  it("appends /v1/traces", () => {
    expect(ensurePhoenixOtlpTraceEndpoint("http://localhost:6006")).toBe("http://localhost:6006/v1/traces");
  });
});

describe("buildOtlpTraceExporterConfig", () => {
  it("builds a Langfuse exporter with Basic auth and the default cloud host", () => {
    const config = buildOtlpTraceExporterConfig({
      provider: "langfuse",
      enabled: true,
      projectName: "manso",
      publicKey: "pk-123",
      secretKey: "sk-456",
    });
    expect(config.endpoint).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    const expectedAuth = `Basic ${Buffer.from("pk-123:sk-456").toString("base64")}`;
    expect(config.headers?.Authorization).toBe(expectedAuth);
    expect(config.headers?.["x-langfuse-ingestion-version"]).toBe("4");
  });

  it("honours a custom Langfuse base URL", () => {
    const config = buildOtlpTraceExporterConfig({
      provider: "langfuse",
      enabled: true,
      projectName: "manso",
      url: "https://us.cloud.langfuse.com",
      publicKey: "pk",
      secretKey: "sk",
    });
    expect(config.endpoint).toBe("https://us.cloud.langfuse.com/api/public/otel/v1/traces");
  });

  it("builds a Phoenix exporter with Bearer auth when an API key is set", () => {
    const config = buildOtlpTraceExporterConfig({
      provider: "phoenix",
      enabled: true,
      projectName: "manso",
      url: "http://localhost:6006",
      apiKey: "phx-key",
    });
    expect(config.endpoint).toBe("http://localhost:6006/v1/traces");
    expect(config.headers?.Authorization).toBe("Bearer phx-key");
  });
});

describe("formatOtlpHeaders", () => {
  it("joins headers into a comma-separated string", () => {
    expect(formatOtlpHeaders({ a: "1", b: "2" })).toBe("a=1,b=2");
  });

  it("returns undefined for empty headers", () => {
    expect(formatOtlpHeaders(undefined)).toBeUndefined();
    expect(formatOtlpHeaders({})).toBeUndefined();
  });
});

describe("session ids", () => {
  it("derives a stable, upper-cased session id from a Jira key", () => {
    expect(jiraIssueSessionId("qatg-2940")).toBe("jira:QATG-2940");
  });

  it("trims and length-bounds raw session ids", () => {
    expect(normalizeSessionId("  abc  ")).toBe("abc");
    expect(normalizeSessionId("")).toBeUndefined();
  });
});

describe("withTelemetrySession", () => {
  it("runs the callback and returns its value when telemetry is inactive", async () => {
    expect(isTelemetryActive()).toBe(false);
    await expect(withTelemetrySession("jira:QATG-2940", async () => "ok")).resolves.toBe("ok");
  });

  it("runs the callback when no session id is provided", async () => {
    await expect(withTelemetrySession(undefined, async () => 42)).resolves.toBe(42);
  });
});

describe("flushTelemetry", () => {
  it("resolves without throwing when telemetry was never initialized", async () => {
    expect(isTelemetryActive()).toBe(false);
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });
});
