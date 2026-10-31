import type {
  CommandResult,
  HealingAttempt,
} from "../../domain/implementationPack/schema.js";
import {
  runImplementationAgent,
  type ImplementationAgentRunner,
  type ImplementationAgentRunInput,
} from "../../integrations/llm/agentRunner.js";
import type { ObservabilityTelemetryConfig } from "../../integrations/llm/types.js";
import { resolveMcpServers, type McpServers } from "../../integrations/mcp/config.js";
import { buildHealingPrompt } from "../implementer/prompts.js";
import { detectChangedFiles } from "../implementer/index.js";
import { runVerifier } from "../verifier/index.js";

export interface HealerInput {
  issueKey: string;
  repoRoot: string;
  runner: ImplementationAgentRunner;
  /** The verification result that triggered this attempt. */
  previousVerification: CommandResult;
  /** Files the previous attempt left changed. */
  previousChangedFiles: string[];
  /** Verify command to re-run after the agent edits. */
  verifyCommand: string;
  /** 1-based attempt number. */
  attempt: number;
  /** Total attempt budget (informational, surfaced in the prompt). */
  maxAttempts: number;
  /** Path to the original implementation prompt, if known. */
  originalPromptPath?: string;
  /** Extra env merged on top of process.env for the agent process. */
  env?: NodeJS.ProcessEnv;
  /** MCP servers to expose to the healing agent (M11). */
  mcpServers?: McpServers;
  /** OTel telemetry config; when enabled the heal run is traced. */
  telemetry?: ObservabilityTelemetryConfig;
}

export interface HealerResult {
  attempt: HealingAttempt;
  /** Files changed after this attempt (cumulative working-tree state). */
  changedFiles: string[];
  /** The healing prompt sent to the agent — surfaced for tests. */
  prompt: string;
}

/**
 * Healer sub-agent: build a narrow "fix the failing tests" prompt, invoke the
 * code agent, and re-run the verify command. One iteration; the orchestrator
 * decides whether to call it again.
 */
export async function runHealer(input: HealerInput): Promise<HealerResult> {
  const prompt = buildHealingPrompt({
    issueKey: input.issueKey,
    repoRoot: input.repoRoot,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    verification: input.previousVerification,
    changedFiles: input.previousChangedFiles,
    ...(input.originalPromptPath ? { originalPromptPath: input.originalPromptPath } : {}),
  });

  const env = input.env ?? process.env;
  const { servers: mcpServers } = resolveMcpServers(input.mcpServers, env);
  const runInput: ImplementationAgentRunInput = {
    issueKey: input.issueKey,
    repoRoot: input.repoRoot,
    prompt,
    env,
    phase: "healing",
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  };

  const agent = await runImplementationAgent(input.runner, runInput, input.telemetry);
  const changedFiles = await detectChangedFiles(input.repoRoot);
  const verification = await runVerifier({
    command: input.verifyCommand,
    repoRoot: input.repoRoot,
    ...(input.env ? { env: input.env } : {}),
  });

  return {
    attempt: {
      attempt: input.attempt,
      agent,
      verification,
    },
    changedFiles,
    prompt,
  };
}
