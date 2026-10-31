import { describe, expect, it } from "vitest";
import {
  McpServersSchema,
  describeMcpServers,
  resolveMcpServers,
  toCodexMcpConfig,
  type McpServers,
} from "../src/integrations/mcp/config.js";

describe("McpServersSchema", () => {
  it("accepts stdio, http, and sse server shapes", () => {
    const parsed = McpServersSchema.parse({
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      figma: { type: "http", url: "https://figma.example/mcp", headers: { Authorization: "Bearer x" } },
      legacy: { type: "sse", url: "https://sse.example/mcp" },
    });
    expect(Object.keys(parsed)).toEqual(["playwright", "figma", "legacy"]);
  });

  it("rejects an unknown field on a server (strict)", () => {
    expect(() => McpServersSchema.parse({ x: { command: "a", bogus: 1 } })).toThrow();
  });
});

describe("resolveMcpServers", () => {
  it("expands ${ENV} placeholders in headers, url, and env from the environment", () => {
    const servers: McpServers = {
      figma: { type: "http", url: "https://${FIGMA_HOST}/mcp", headers: { Authorization: "Bearer ${FIGMA_TOKEN}" } },
      pw: { command: "npx", env: { PW_TOKEN: "${PW_TOKEN}" } },
    };
    const { servers: resolved, warnings } = resolveMcpServers(servers, {
      FIGMA_HOST: "figma.internal",
      FIGMA_TOKEN: "secret-abc",
      PW_TOKEN: "pw-123",
    } as NodeJS.ProcessEnv);

    const figma = resolved.figma as { url: string; headers: Record<string, string> };
    expect(figma.url).toBe("https://figma.internal/mcp");
    expect(figma.headers.Authorization).toBe("Bearer secret-abc");
    const pw = resolved.pw as { env: Record<string, string> };
    expect(pw.env.PW_TOKEN).toBe("pw-123");
    expect(warnings).toEqual([]);
  });

  it("warns and leaves the placeholder literal when an env var is missing", () => {
    const { servers, warnings } = resolveMcpServers(
      { figma: { type: "http", url: "https://figma.example/mcp", headers: { Authorization: "Bearer ${MISSING}" } } },
      {} as NodeJS.ProcessEnv,
    );
    const figma = servers.figma as { headers: Record<string, string> };
    expect(figma.headers.Authorization).toBe("Bearer ${MISSING}");
    expect(warnings.some((w) => /MISSING/.test(w))).toBe(true);
  });

  it("returns an empty map for undefined input", () => {
    expect(resolveMcpServers(undefined)).toEqual({ servers: {}, warnings: [] });
  });
});

describe("toCodexMcpConfig", () => {
  it("maps stdio servers into mcp_servers and drops http/sse", () => {
    const config = toCodexMcpConfig({
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      figma: { type: "http", url: "https://figma.example/mcp" },
    });
    expect(config).toEqual({ mcp_servers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } });
  });

  it("returns undefined when there are no stdio servers", () => {
    expect(toCodexMcpConfig({ figma: { type: "http", url: "https://x/mcp" } })).toBeUndefined();
  });
});

describe("describeMcpServers", () => {
  it("summarizes each server on one line", () => {
    const lines = describeMcpServers({
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      figma: { type: "http", url: "https://figma.example/mcp" },
    });
    expect(lines[0]).toBe("- playwright (stdio): npx @playwright/mcp@latest");
    expect(lines[1]).toBe("- figma (http): https://figma.example/mcp");
  });
});
