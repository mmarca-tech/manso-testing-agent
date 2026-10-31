import { join } from "node:path";
import { type AgentConfig, loadAgentConfig, resolveAgentDir } from "../config/agentConfig.js";
import type { RuntimeConfig } from "../config/runtimeConfig.js";
import type { ReadinessCheck, ReadinessReport } from "../domain/readinessReport/schema.js";
import { detectStacks } from "../scaffold/stackDetection.js";
import { pathExists } from "../shared/fsUtils.js";

export interface ReadinessOptions {
  /** Absolute path to the repository being assessed. */
  repoRoot: string;
  /** Resolved runtime config, used to check whether credentials are present. */
  runtimeConfig?: RuntimeConfig;
}

/** A readiness check plus the metadata used to score and gate it. */
interface WeightedCheck extends ReadinessCheck {
  /** Contribution to the 0-100 score. All weights sum to 100. */
  weight: number;
  /** When true, a failure makes the whole repository "not ready". */
  mandatory: boolean;
}

/**
 * Assess how ready a repository is for Manso: mandatory files, config
 * validity, configured vs detected stacks, and credential availability.
 * Produces a scored {@link ReadinessReport} and never throws for a missing or
 * invalid repo — problems are reported as checks instead.
 */
export async function evaluateRepoReadiness(options: ReadinessOptions): Promise<ReadinessReport> {
  const { repoRoot, runtimeConfig } = options;
  const checks: WeightedCheck[] = [];
  const agentDir = await resolveAgentDir(repoRoot);

  let config: AgentConfig | undefined;
  let configError: string | undefined;
  try {
    config = await loadAgentConfig(repoRoot);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  checks.push({
    name: "Agent config",
    weight: 25,
    mandatory: true,
    status: config ? "pass" : "fail",
    message: config
      ? `${join(agentDir, "manso.config.json")} is valid (schema ${config.schemaVersion})`
      : configError ?? "Config could not be loaded.",
  });

  for (const [name, relPath, weight] of [
    ["Test architecture doc", join(agentDir, "test-architecture.md"), 15],
    ["Test conventions", join(agentDir, "test-conventions.json"), 15],
  ] as const) {
    const exists = await pathExists(join(repoRoot, relPath));
    checks.push({
      name,
      weight,
      mandatory: true,
      status: exists ? "pass" : "fail",
      message: exists ? `${relPath} is present` : `${relPath} is missing; run "manso init".`,
    });
  }

  for (const [name, relPath, weight] of [
    ["AGENTS.md anchor", "AGENTS.md", 5],
    ["Product context", join(agentDir, "product-context.md"), 5],
  ] as const) {
    const exists = await pathExists(join(repoRoot, relPath));
    checks.push({
      name,
      weight,
      mandatory: false,
      status: exists ? "pass" : "warn",
      message: exists ? `${relPath} is present` : `${relPath} is missing (recommended).`,
    });
  }

  const configuredStacks = config?.stacks ?? [];
  checks.push({
    name: "Configured stacks",
    weight: 15,
    mandatory: false,
    status: configuredStacks.length > 0 ? "pass" : "warn",
    message:
      configuredStacks.length > 0
        ? `${configuredStacks.length} stack(s) configured: ${configuredStacks.map((stack) => stack.id).join(", ")}`
        : `No stacks configured; edit ${join(agentDir, "manso.config.json")}.`,
  });

  const detectedStacks = await detectStacks(repoRoot);
  const configuredIds = new Set(configuredStacks.map((stack) => stack.id));
  const unconfigured = detectedStacks.filter((stack) => !configuredIds.has(stack.id));
  checks.push({
    name: "Stack detection match",
    weight: 5,
    mandatory: false,
    status: unconfigured.length === 0 ? "pass" : "warn",
    message:
      unconfigured.length > 0
        ? `Detected but not configured: ${unconfigured.map((stack) => stack.id).join(", ")}`
        : detectedStacks.length > 0
          ? "Detected stacks are all present in the config."
          : "No test stacks were detected in the repository.",
  });

  checks.push(
    credentialCheck("Jira credentials", 10, Boolean(runtimeConfig?.jiraRest), "JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN"),
  );
  checks.push(
    credentialCheck("Xray credentials", 5, Boolean(runtimeConfig?.xray), "XRAY_CLIENT_ID / XRAY_CLIENT_SECRET"),
  );

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.reduce((sum, check) => sum + earnedPoints(check), 0);
  const score = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;
  const hardFailure = checks.some((check) => check.mandatory && check.status === "fail");

  return {
    repoRoot,
    score,
    hardFailure,
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      message: check.message,
    })),
  };
}

function credentialCheck(
  name: string,
  weight: number,
  present: boolean,
  envHint: string,
): WeightedCheck {
  return {
    name,
    weight,
    mandatory: false,
    status: present ? "pass" : "warn",
    message: present ? "Credentials are configured." : `Not configured (set ${envHint}).`,
  };
}

function earnedPoints(check: WeightedCheck): number {
  if (check.status === "pass") {
    return check.weight;
  }
  if (check.status === "warn") {
    return check.weight / 2;
  }
  return 0;
}
