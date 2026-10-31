import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "../shared/cli.js";
import { pathExists } from "../shared/fsUtils.js";
import { McpServersSchema } from "../integrations/mcp/config.js";

/**
 * Folder, relative to a repo root, where Manso's config lives. Plural to
 * align with the cross-tool `AGENTS.md` convention and to unify with the
 * `.agents/skills/` layout other agent tooling uses.
 */
export const AGENT_DIR = ".agents";
/** Legacy folder names read as a migration fallback (newest preference first). */
export const LEGACY_AGENT_DIRS = [".agent"] as const;
/** Config file name inside {@link AGENT_DIR}. */
export const AGENT_CONFIG_FILE = "manso.config.json";

/**
 * Resolve the active agent-dir name for a repo: prefer `.agents`; fall back to
 * a legacy dir (`.agent`) only when it exists and `.agents` does not. New repos
 * always use `.agents`.
 */
export async function resolveAgentDir(repoRoot: string): Promise<string> {
  if (await pathExists(join(repoRoot, AGENT_DIR))) {
    return AGENT_DIR;
  }
  for (const legacy of LEGACY_AGENT_DIRS) {
    if (await pathExists(join(repoRoot, legacy))) {
      return legacy;
    }
  }
  return AGENT_DIR;
}

/** Supported test-design output modes. */
export const OUTPUT_MODES = ["gherkin", "plain-english"] as const;
/** Supported gate strictness levels. */
export const GATE_LEVELS = ["required", "warn", "off"] as const;

const StackSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  verifyCommand: z.string().min(1),
  featureGlob: z.string().min(1).optional(),
  // M20 — environment-aware, explore-before-implement. All optional: when a
  // setupCommand is present (and the env comes up), Manso spins the app up,
  // explores it to ground the tests, and verifies against it. When absent (or
  // setup fails), it falls back to today's behaviour without blocking.
  /** "ui" → explore via Playwright MCP for real DOM locators; "api" → OpenAPI. */
  kind: z.enum(["ui", "api"]).optional(),
  /** Command that brings the test environment up (e.g. `docker compose up -d`). */
  setupCommand: z.string().min(1).optional(),
  /** Command that tears the environment down (e.g. `docker compose down -v`). */
  teardownCommand: z.string().min(1).optional(),
  /** Base URL of the running app (UI exploration target + readiness wait). */
  appUrl: z.string().url().optional(),
  /** URL polled to decide the env is ready (defaults to appUrl). */
  healthCheck: z.string().url().optional(),
  /** OpenAPI/Swagger JSON URL for API exploration. */
  openApiUrl: z.string().url().optional(),
  /** Max ms to wait for setup + readiness before falling back. Default 120000.
   *  Raise it for stacks that are slow to boot (e.g. an Nx serve that compiles
   *  on start). */
  readinessTimeoutMs: z.number().int().positive().optional(),
});

const AgentConfigSchema = z.object({
  schemaVersion: z.string().min(1),
  product: z.string().min(1),
  testDesign: z
    .object({
      outputMode: z.enum(OUTPUT_MODES).default("gherkin"),
      language: z.string().min(1).default("en"),
    })
    .prefault({}),
  stacks: z.array(StackSchema).default([]),
  context: z
    .object({
      providers: z.array(z.string().min(1)).default([]),
      rovoMcp: z.object({ enabled: z.boolean().default(false) }).prefault({}),
      linkedTicketDepth: z.number().int().min(0).default(1),
      attachmentUnderstanding: z.boolean().default(true),
    })
    .prefault({}),
  mcpServers: McpServersSchema.default({}),
  xray: z
    .object({
      createCucumberTests: z.boolean().default(true),
      createTestExecutions: z.boolean().default(false),
      /**
       * Extra Jira fields (field id → value) to set on created Test issues, for
       * project-mandatory fields not inherited from the story. e.g.
       * `{ "customfield_15714": { "id": "123" } }`. Overrides inherited values.
       */
      testFields: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),
  policy: z
    .object({
      gates: z
        .object({
          acCoverage: z.enum(GATE_LEVELS).default("required"),
          // M22 — risk/edge coverage: each high-risk AC or derived requirement
          // should have a negative-or-boundary scenario. Defaults to "warn" so
          // it surfaces gaps without hard-blocking existing/unattended runs.
          riskCoverage: z.enum(GATE_LEVELS).default("warn"),
          humanReviewBeforeUpload: z.boolean().default(true),
          humanReviewBeforePr: z.boolean().default(false),
        })
        .prefault({}),
      // M22 — extra design passes. Both default on; gate cost via budgets.
      design: z
        .object({
          /** Mine the full context for requirements the ACs don't state. */
          deriveRequirements: z.boolean().default(true),
          /** Run a bounded "what did this design miss?" critique before upload. */
          adversarialCritique: z.boolean().default(true),
        })
        .prefault({}),
      budgets: z
        .object({
          maxCostPerRunUsd: z.number().nonnegative().optional(),
          maxCostPerDayUsd: z.number().nonnegative().optional(),
        })
        .prefault({}),
      redactPatterns: z.array(z.string()).default([]),
    })
    .prefault({}),
  pr: z
    .object({
      mention: z.string().min(1).default("@manso"),
      maxIterationsPerPr: z.number().int().positive().default(5),
    })
    .prefault({}),
});

/** Validated `.agents/manso.config.json` contents. */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
/** A single configured test stack. */
export type StackConfig = z.infer<typeof StackSchema>;

/** Absolute path to a repo's agent config file (defaults to the `.agents` dir). */
export function agentConfigPath(repoRoot: string, dir: string = AGENT_DIR): string {
  return join(repoRoot, dir, AGENT_CONFIG_FILE);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Parse an in-memory config value against the schema. Throws {@link CliError}
 * with a readable message when it does not validate.
 */
export function parseAgentConfig(value: unknown, source: string): AgentConfig {
  const result = AgentConfigSchema.safeParse(value);
  if (!result.success) {
    throw new CliError(`Invalid Manso config at ${source}:\n${formatZodIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Load and validate `.agents/manso.config.json` from a repository root
 * (falling back to a legacy `.agent/` dir when present).
 * Throws {@link CliError} when the file is missing, not valid JSON, or does not
 * satisfy the schema.
 */
export async function loadAgentConfig(repoRoot: string): Promise<AgentConfig> {
  const configPath = agentConfigPath(repoRoot, await resolveAgentDir(repoRoot));

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new CliError(
      `No Manso config found at ${configPath}. Run "manso init --repo ${repoRoot}".`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseAgentConfig(json, configPath);
}
