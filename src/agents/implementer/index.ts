import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { StackConfig } from "../../config/agentConfig.js";
import type {
  CommandResult,
  ImplementedScenario,
  ImplementationStatus,
} from "../../domain/implementationPack/schema.js";
import type { TestDesignPack } from "../../domain/testDesignPack/schema.js";
import {
  runImplementationAgent,
  type ImplementationAgentRunner,
  type ImplementationAgentRunInput,
} from "../../integrations/llm/agentRunner.js";
import type { ObservabilityTelemetryConfig } from "../../integrations/llm/types.js";
import { runShellCommand } from "../../integrations/shell/runShellCommand.js";
import { resolveMcpServers, type McpServers } from "../../integrations/mcp/config.js";
import { loadSkills } from "../../skillLoader/loader.js";
import type { Skill } from "../../skillLoader/types.js";
import { CliError } from "../../shared/cli.js";
import { registerCabinArtifacts } from "../../memory/cabin.js";
import { loadRepoGuidance } from "../../context/repoGuidance.js";
import { buildImplementationPrompt } from "./prompts.js";

export interface ImplementerInput {
  testDesign: TestDesignPack;
  repoRoot: string;
  stack: StackConfig;
  runner: ImplementationAgentRunner;
  /** Optional preloaded binding skill (otherwise resolved from `repoRoot`). */
  bindingSkill?: Skill;
  /** Write the prompt to this absolute path so re-runs can inspect it. */
  promptPath?: string;
  /** Extra env passed to the agent process (merged with process.env). */
  env?: NodeJS.ProcessEnv;
  /** MCP servers from `.agents/manso.config.json` to expose to the agent (M11). */
  mcpServers?: McpServers;
  /** Live exploration brief (real DOM locators / API endpoints) from M20. */
  explorationBrief?: string;
  /** OTel telemetry config; when enabled the agent run is traced as a
   *  Langfuse/Phoenix generation (session + token usage + cost). */
  telemetry?: ObservabilityTelemetryConfig;
}

export interface ImplementerOutput {
  /** Outcome of the agent invocation. */
  implementation: CommandResult;
  /** Repo-relative paths the agent changed (best-effort via git). */
  changedFiles: string[];
  /** Per-scenario implementation status. */
  scenarios: ImplementedScenario[];
  /** Status derived from agent exit code + scenario outcomes. */
  status: ImplementationStatus;
  /** Path the prompt was written to, when `promptPath` was provided. */
  promptPath?: string;
  /** The composed prompt text — useful for tests. */
  prompt: string;
}

/**
 * Implementer sub-agent (M9a).
 *
 * 1. Loads the binding skill for the requested stack (`appliesTo.stacks`
 *    includes the stack id; packaged or repo override).
 * 2. Loads `.agents/` guidance files from the target repo when present.
 * 3. Builds the implementation prompt.
 * 4. Optionally writes the prompt to disk for traceability.
 * 5. Invokes the {@link ImplementationAgentRunner} inside `repoRoot`.
 * 6. Walks the repo for changed files (best effort via `git status`).
 * 7. Maps each TestDesignPack scenario to an {@link ImplementedScenario}.
 *
 * Verification + heal loop + PR are downstream concerns (M9a runs them via
 * the Verifier and the CLI; PR creation lands in M9b).
 */
export async function runImplementer(input: ImplementerInput): Promise<ImplementerOutput> {
  const bindingSkill = input.bindingSkill ?? (await resolveBindingSkill(input.repoRoot, input.stack));
  const { files: guidanceFiles, warnings: guidanceWarnings } = await loadRepoGuidance(input.repoRoot);
  for (const warning of guidanceWarnings) console.warn(`! ${warning}`);
  const featurePaths = await listFeatureFiles(input.repoRoot);

  const env = input.env ?? process.env;
  const { servers: mcpServers } = resolveMcpServers(input.mcpServers, env);
  const hasMcp = Object.keys(mcpServers).length > 0;

  const prompt = buildImplementationPrompt({
    testDesign: input.testDesign,
    repoRoot: input.repoRoot,
    stack: input.stack,
    bindingSkill,
    guidanceFiles,
    featurePaths,
    ...(hasMcp ? { mcpServers } : {}),
    ...(input.explorationBrief ? { explorationBrief: input.explorationBrief } : {}),
  });

  if (input.promptPath) {
    await mkdir(dirname(input.promptPath), { recursive: true });
    await writeFile(input.promptPath, prompt, "utf8");
    registerCabinArtifacts({ directory: dirname(input.promptPath), paths: [input.promptPath] });
  }

  const runInput: ImplementationAgentRunInput = {
    issueKey: input.testDesign.ticket.key,
    repoRoot: input.repoRoot,
    prompt,
    env,
    phase: "implementation",
    ...(hasMcp ? { mcpServers } : {}),
  };

  const implementation = await runImplementationAgent(input.runner, runInput, input.telemetry);
  const changedFiles = await detectChangedFiles(input.repoRoot);
  const scenarios = mapScenarioOutcomes(input.testDesign, implementation);
  const status = deriveStatus(implementation, scenarios);

  return {
    implementation,
    changedFiles,
    scenarios,
    status,
    ...(input.promptPath ? { promptPath: input.promptPath } : {}),
    prompt,
  };
}

async function resolveBindingSkill(repoRoot: string, stack: StackConfig): Promise<Skill> {
  const skills = await loadSkills({
    repoRoot,
    phase: "implementation",
    stack: stack.id,
  });
  const skill = skills.find((candidate) => candidate.appliesTo?.stacks?.includes(stack.id));
  if (!skill) {
    throw new CliError(
      `No implementation binding skill found for stack "${stack.id}". Looked under packaged skills and ${repoRoot}/.agents/skills.`,
    );
  }
  return skill;
}

async function listFeatureFiles(repoRoot: string): Promise<string[]> {
  // The Test Architect writer puts .feature files under <outDir>/<KEY>/features/.
  // We do not know the outDir here, so this is intentionally empty in M9a —
  // the prompt still references the design pack's scenarios in full Gherkin.
  // The user can pass --include-features (M9b enhancement) to surface the paths.
  void repoRoot;
  return [];
}

async function detectChangedFiles(repoRoot: string): Promise<string[]> {
  try {
    const result = await runShellCommand("git status --porcelain", { cwd: repoRoot });
    if (result.exitCode !== 0) {
      return [];
    }
    const files: string[] = [];
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      // porcelain format: "XY <path>" (or "XY <path> -> <renamed>" for renames)
      const arrowIndex = line.indexOf(" -> ");
      const portion = arrowIndex >= 0 ? line.slice(arrowIndex + 4) : line.slice(3);
      const file = portion.trim();
      if (file.length > 0) {
        files.push(file);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function mapScenarioOutcomes(
  testDesign: TestDesignPack,
  implementation: CommandResult,
): ImplementedScenario[] {
  const failed = implementation.exitCode !== 0;
  return testDesign.scenarios.map((scenario, index) => ({
    scenarioIndex: index,
    title: scenario.title,
    acIds: scenario.acIds,
    status: failed ? "failed" : "implemented",
    ...(failed ? { reason: "Implementation agent reported a non-zero exit code." } : {}),
  }));
}

function deriveStatus(
  implementation: CommandResult,
  scenarios: ImplementedScenario[],
): ImplementationStatus {
  if (implementation.exitCode !== 0) {
    return "failed";
  }
  if (scenarios.some((scenario) => scenario.status === "failed")) {
    return "partial";
  }
  return "completed";
}

/** Helper kept on the public surface for callers that want raw outputs. */
export { detectChangedFiles };

// Suppress the unused-import warning for `relative` (kept for future use in M9b).
void relative;
