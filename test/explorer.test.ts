import { describe, expect, it, vi } from "vitest";
import { exploreBeforeImplement, resolveModality } from "../src/agents/explorer/index.js";
import type { StackConfig } from "../src/config/agentConfig.js";
import type { TestDesignPack } from "../src/domain/testDesignPack/schema.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";
import type { ImplementationAgentRunner } from "../src/integrations/llm/agentRunner.js";
import type { McpServers } from "../src/integrations/mcp/config.js";

function stack(overrides: Partial<StackConfig> = {}): StackConfig {
  return { id: "playwright-bdd-ts", root: ".", verifyCommand: "npm test", ...overrides };
}

function design(tags: string[] = []): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "ENV-1", title: "Env story" },
    outputMode: "gherkin",
    acceptanceCriteria: [],
    strategySummary: "",
    coverageGaps: [],
    scenarios: [
      {
        kind: "gherkin", title: "Open page", feature: "F", tags, acIds: [], risk: "medium", readiness: "ready",
        objective: "Open the page", preconditions: [],
        steps: [{ keyword: "Given", text: "I open the page" }, { keyword: "When", text: "x" }, { keyword: "Then", text: "y" }],
        sourceEvidence: [], openQuestions: [], rationale: "",
      },
    ],
    acCoverageMatrix: [], riskRanking: [], openQuestions: [],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "ENV-1", llm: { provider: "anthropic", model: "stub" }, tools: [] },
    warnings: [],
  };
}

function runner(result: CommandResult): ImplementationAgentRunner {
  return { kind: "shell", commandLabel: "stub", run: async () => result };
}

const playwrightMcp = { playwright: { command: "npx", args: ["@playwright/mcp"] } } as unknown as McpServers;

describe("resolveModality", () => {
  it("uses the stack kind when set", () => {
    expect(resolveModality(stack({ kind: "api" }), design())).toBe("api");
    expect(resolveModality(stack({ kind: "ui" }), design())).toBe("ui");
  });
  it("infers api from an openApiUrl with no appUrl", () => {
    expect(resolveModality(stack({ openApiUrl: "http://x/swagger.json" }), design())).toBe("api");
  });
  it("infers api from @api tags, ui otherwise", () => {
    expect(resolveModality(stack(), design(["@api"]))).toBe("api");
    expect(resolveModality(stack(), design())).toBe("ui");
  });
});

describe("exploreBeforeImplement — API", () => {
  it("summarizes the OpenAPI spec into a brief", async () => {
    const spec = {
      servers: [{ url: "http://localhost:8080" }],
      paths: { "/widgets": { get: { summary: "List widgets" }, post: { operationId: "createWidget" } } },
      components: { schemas: { Widget: {}, Error: {} } },
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(spec), { status: 200 })) as unknown as typeof fetch;
    const res = await exploreBeforeImplement({
      stack: stack({ kind: "api", openApiUrl: "http://localhost:8080/swagger.json" }),
      testDesign: design(), repoRoot: "/r", runner: runner({ command: "x", exitCode: 0, durationMs: 1 }), fetchFn,
    });
    expect(res.modality).toBe("api");
    expect(res.brief).toContain("GET /widgets");
    expect(res.brief).toContain("POST /widgets");
    expect(res.brief).toContain("Widget");
    expect(res.warnings).toHaveLength(0);
  });

  it("warns and returns no brief when the OpenAPI fetch fails", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await exploreBeforeImplement({
      stack: stack({ kind: "api", openApiUrl: "http://localhost:8080/swagger.json" }),
      testDesign: design(), repoRoot: "/r", runner: runner({ command: "x", exitCode: 0, durationMs: 1 }), fetchFn,
    });
    expect(res.brief).toBe("");
    expect(res.warnings[0]?.message).toContain("Could not fetch OpenAPI");
  });
});

describe("exploreBeforeImplement — UI", () => {
  it("returns the agent's locator brief when Playwright MCP is available", async () => {
    const res = await exploreBeforeImplement({
      stack: stack({ kind: "ui", appUrl: "http://localhost:3000" }),
      testDesign: design(), repoRoot: "/r",
      runner: runner({ command: "agent", exitCode: 0, durationMs: 1, stdout: "### Open page\n- button[role=button name=Submit]" }),
      mcpServers: playwrightMcp,
    });
    expect(res.modality).toBe("ui");
    expect(res.brief).toContain("role=button");
    expect(res.warnings).toHaveLength(0);
  });

  it("skips (warns) when no Playwright MCP server is configured", async () => {
    const res = await exploreBeforeImplement({
      stack: stack({ kind: "ui", appUrl: "http://localhost:3000" }),
      testDesign: design(), repoRoot: "/r", runner: runner({ command: "x", exitCode: 0, durationMs: 1 }),
    });
    expect(res.brief).toBe("");
    expect(res.warnings[0]?.message).toContain("No Playwright MCP");
  });

  it("skips (warns) when there is no appUrl", async () => {
    const res = await exploreBeforeImplement({
      stack: stack({ kind: "ui" }), testDesign: design(), repoRoot: "/r",
      runner: runner({ command: "x", exitCode: 0, durationMs: 1 }), mcpServers: playwrightMcp,
    });
    expect(res.brief).toBe("");
    expect(res.warnings[0]?.message).toContain("No appUrl");
  });

  it("warns when the exploration agent fails", async () => {
    const res = await exploreBeforeImplement({
      stack: stack({ kind: "ui", appUrl: "http://localhost:3000" }),
      testDesign: design(), repoRoot: "/r",
      runner: runner({ command: "agent", exitCode: 1, durationMs: 1, stderr: "boom" }), mcpServers: playwrightMcp,
    });
    expect(res.brief).toBe("");
    expect(res.warnings[0]?.message).toContain("did not complete");
  });
});
