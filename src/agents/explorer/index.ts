import type { StackConfig } from "../../config/agentConfig.js";
import type { TestDesignPack } from "../../domain/testDesignPack/schema.js";
import type { Warning } from "../../domain/contextPack/schema.js";
import type { ImplementationAgentRunner } from "../../integrations/llm/agentRunner.js";
import type { McpServers } from "../../integrations/mcp/config.js";
import { isRecord } from "../../shared/utils.js";

/**
 * Explore-before-implement (M20). With the app running, ground the tests in
 * reality before any code is written:
 *   - UI stacks: drive the live app through the Playwright MCP server and report
 *     real DOM locators (role / label / test-id), visible text, and flows.
 *   - API stacks: fetch the OpenAPI/Swagger spec and summarize the relevant
 *     endpoints, methods, and schemas.
 * The result is an "exploration brief" injected into the implement prompt so the
 * agent stops inventing selectors/endpoints. Best-effort: when exploration can't
 * run (no app URL, no Playwright MCP, fetch fails), it returns an empty brief +
 * a warning and the implement step proceeds as today.
 */
export type Modality = "ui" | "api";

export interface ExploreInput {
  stack: StackConfig;
  testDesign: TestDesignPack;
  repoRoot: string;
  /** Live app base URL (UI). Defaults to stack.appUrl. */
  appUrl?: string;
  /** OpenAPI/Swagger URL (API). Defaults to stack.openApiUrl. */
  openApiUrl?: string;
  /** Agent runner used to drive the Playwright MCP exploration (UI). */
  runner: ImplementationAgentRunner;
  /** MCP servers available this run (needs a Playwright server for UI). */
  mcpServers?: McpServers;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
  /** Injected for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

export interface ExploreResult {
  modality: Modality;
  /** Markdown brief injected into the implement prompt; empty when none produced. */
  brief: string;
  warnings: Warning[];
}

/** Resolve UI vs API from the stack kind, then OpenAPI presence, then tags. */
export function resolveModality(stack: StackConfig, testDesign: TestDesignPack): Modality {
  if (stack.kind) {
    return stack.kind;
  }
  if (stack.openApiUrl && !stack.appUrl) {
    return "api";
  }
  const tags = testDesign.scenarios.flatMap((s) => s.tags.map((t) => t.toLowerCase()));
  if (tags.includes("@api") && !tags.includes("@ui")) {
    return "api";
  }
  return "ui";
}

export async function exploreBeforeImplement(input: ExploreInput): Promise<ExploreResult> {
  const modality = resolveModality(input.stack, input.testDesign);
  return modality === "api" ? exploreApi(input) : exploreUi(input);
}

// --- API ------------------------------------------------------------------

async function exploreApi(input: ExploreInput): Promise<ExploreResult> {
  const url = input.openApiUrl ?? input.stack.openApiUrl;
  if (!url) {
    return { modality: "api", brief: "", warnings: [warn("No openApiUrl configured; skipped API exploration.")] };
  }
  const fetchFn = input.fetchFn ?? fetch;
  let spec: unknown;
  try {
    const res = await fetchFn(url, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spec = await res.json();
  } catch (error) {
    return {
      modality: "api",
      brief: "",
      warnings: [warn(`Could not fetch OpenAPI at ${url}: ${errorMessage(error)}; proceeding without an API brief.`)],
    };
  }
  input.onProgress?.(`Exploration: summarized OpenAPI from ${url}.`);
  return { modality: "api", brief: summarizeOpenApi(spec, url), warnings: [] };
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function summarizeOpenApi(spec: unknown, url: string): string {
  const lines = [`# API exploration (OpenAPI: ${url})`, ""];
  const servers = isRecord(spec) && Array.isArray(spec.servers)
    ? spec.servers.map((s) => (isRecord(s) ? s.url : undefined)).filter((u): u is string => typeof u === "string")
    : [];
  if (servers.length > 0) {
    lines.push(`Servers: ${servers.join(", ")}`, "");
  }
  const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
  lines.push("Endpoints:");
  let count = 0;
  for (const [path, ops] of Object.entries(paths)) {
    if (!isRecord(ops)) continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (count >= 80) break;
      count += 1;
      const summary = isRecord(op) ? String(op.summary ?? op.operationId ?? "") : "";
      lines.push(`- \`${method.toUpperCase()} ${path}\`${summary ? ` — ${summary}` : ""}`);
    }
  }
  if (count === 0) {
    lines.push("- (no operations found in the spec)");
  }
  const schemas = isRecord(spec) && isRecord(spec.components) && isRecord(spec.components.schemas)
    ? Object.keys(spec.components.schemas)
    : [];
  if (schemas.length > 0) {
    lines.push("", `Schemas: ${schemas.slice(0, 60).join(", ")}`);
  }
  lines.push("", "Use these real endpoints, methods, and schemas when implementing the API tests — do not invent paths or payload shapes.");
  return lines.join("\n");
}

// --- UI -------------------------------------------------------------------

async function exploreUi(input: ExploreInput): Promise<ExploreResult> {
  const appUrl = input.appUrl ?? input.stack.appUrl;
  if (!appUrl) {
    return { modality: "ui", brief: "", warnings: [warn("No appUrl configured; skipped live UI exploration.")] };
  }
  const hasPlaywright = input.mcpServers
    ? Object.keys(input.mcpServers).some((name) => /playwright/i.test(name))
    : false;
  if (!hasPlaywright) {
    return {
      modality: "ui",
      brief: "",
      warnings: [warn("No Playwright MCP server configured; skipped live UI exploration (tests will be implemented without real locators).")],
    };
  }

  let result;
  try {
    result = await input.runner.run({
      issueKey: input.testDesign.ticket.key,
      repoRoot: input.repoRoot,
      prompt: buildUiExplorePrompt(appUrl, input.testDesign),
      env: input.env ?? process.env,
      phase: "implementation",
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    });
  } catch (error) {
    return { modality: "ui", brief: "", warnings: [warn(`UI exploration failed: ${errorMessage(error)}; proceeding without a locator brief.`)] };
  }
  if (result.exitCode !== 0) {
    return { modality: "ui", brief: "", warnings: [warn("UI exploration agent did not complete; proceeding without a locator brief.")] };
  }
  input.onProgress?.(`Exploration: captured live UI locators from ${appUrl}.`);
  return { modality: "ui", brief: (result.stdout ?? "").trim(), warnings: [] };
}

function buildUiExplorePrompt(appUrl: string, testDesign: TestDesignPack): string {
  const lines: string[] = [];
  lines.push(`# Explore the live app for ${testDesign.ticket.key} — do NOT write code`, "");
  lines.push(
    `The application is running at ${appUrl}. Using the Playwright MCP tools,`,
    `open it and walk through each scenario's flow to discover the REAL UI.`,
    "Your only job is to OBSERVE and REPORT — do not edit any files or write tests.",
    "",
  );
  lines.push("For each scenario below, report:");
  lines.push("- the concrete steps to reach the screen(s) it touches;");
  lines.push("- the real, stable locators for each element involved — prefer role + accessible name, then `data-testid`, then visible text;");
  lines.push("- the actual visible text/labels and any observed states (empty, loading, error).");
  lines.push("", "Output a concise Markdown brief, one section per scenario. Use real values you observed — never guess.", "");
  lines.push("## Scenarios", "");
  testDesign.scenarios.forEach((scenario, index) => {
    lines.push(`### ${index + 1}. ${scenario.title}`);
    lines.push(`Objective: ${scenario.objective}`);
    if (scenario.kind === "gherkin") {
      for (const step of scenario.steps) lines.push(`  ${step.keyword} ${step.text}`);
    }
    lines.push("");
  });
  return `${lines.join("\n").trim()}\n`;
}

function warn(message: string): Warning {
  return { section: "exploration", toolName: "explorer", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
