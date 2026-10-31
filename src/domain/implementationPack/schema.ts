import { z } from "zod";
import { ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const IMPLEMENTATION_SCHEMA_VERSION = "1.0.0" as const;

/** Token-and-cost usage attributed to one code-agent run. */
export const AgentUsageSchema = z
  .object({
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().min(1).optional(),
    inputTokens: z.number().nonnegative().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
    cacheCreationInputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    reasoningOutputTokens: z.number().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative().optional(),
  })
  .strict();

/** Captured outcome of a single shell or agent command invocation. */
export const CommandResultSchema = z
  .object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    usage: AgentUsageSchema.optional(),
  })
  .strict();

/** Outcome of automating one scenario from the TestDesignPack. */
export const IMPLEMENTED_SCENARIO_STATUSES = ["implemented", "skipped", "failed"] as const;
export const ImplementedScenarioSchema = z
  .object({
    scenarioIndex: z.number().int().nonnegative(),
    title: z.string().min(1),
    acIds: z.array(z.string()),
    status: z.enum(IMPLEMENTED_SCENARIO_STATUSES),
    /** Why a scenario was skipped or failed. */
    reason: z.string().optional(),
  })
  .strict();

/** One iteration of the heal loop after a failed verification. */
export const HealingAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    /** Result of the healing agent invocation. */
    agent: CommandResultSchema,
    /** Result of the verify command after the healing attempt. */
    verification: CommandResultSchema,
  })
  .strict();

/** Pull-request reference produced by the VCS adapter (M9c). */
export const PULL_REQUEST_STATUSES = [
  "raised",
  "updated",
  "exists",
  "skipped",
  "failed",
  "dry-run",
] as const;
export const PullRequestReferenceSchema = z
  .object({
    /** Web URL of the PR. Not always known (failed / dry-run / some "exists" responses). */
    url: z.string().url().optional(),
    status: z.enum(PULL_REQUEST_STATUSES),
    branch: z.string().min(1),
    targetBranch: z.string().min(1),
    /** Platform PR identifier when known. */
    pullRequestId: z.number().int().nonnegative().optional(),
    message: z.string().optional(),
  })
  .strict();

export const IMPLEMENTATION_STATUSES = ["completed", "partial", "failed", "dry-run"] as const;

export const ImplementationPackSchema = z
  .object({
    schemaVersion: z.literal(IMPLEMENTATION_SCHEMA_VERSION),
    ticket: z.object({ key: z.string().min(1), title: z.string().min(1) }).strict(),
    /** Stack id from the TestDesignPack / .agents config (e.g. "playwright-bdd-ts"). */
    stack: z.string().min(1),
    /** Absolute path of the target repository. */
    repoRoot: z.string().min(1),
    /** Working branch the implementation was performed on. */
    branch: z.string().min(1).optional(),
    /** Pull-request target branch when known. */
    targetBranch: z.string().min(1).optional(),

    status: z.enum(IMPLEMENTATION_STATUSES),

    /** Outcome of the code-agent invocation that produced the changes. */
    implementation: CommandResultSchema,
    /** Optional verification run (M9a). */
    verification: CommandResultSchema.optional(),
    /** Heal loop attempts after a failing first verification (M9b). */
    healingAttempts: z.array(HealingAttemptSchema),

    /** Files the agent modified, repo-relative. */
    changedFiles: z.array(z.string().min(1)),
    /** Per-scenario implementation outcome. */
    scenarios: z.array(ImplementedScenarioSchema),

    /** Path to the prompt that drove the agent, when written to disk. */
    promptPath: z.string().min(1).optional(),

    /** Pull request reference once the VCS adapter raises one (M9b). */
    pullRequest: PullRequestReferenceSchema.optional(),

    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        issueKey: z.string().min(1),
        sourceTestDesignPath: z.string().optional(),
        llm: z
          .object({
            provider: z.enum(["openai", "anthropic"]),
            model: z.string().min(1).optional(),
          })
          .strict(),
        tools: z.array(ToolProvenanceSchema),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type ImplementedScenario = z.infer<typeof ImplementedScenarioSchema>;
export type HealingAttempt = z.infer<typeof HealingAttemptSchema>;
export type PullRequestReference = z.infer<typeof PullRequestReferenceSchema>;
export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number];
export type ImplementationPack = z.infer<typeof ImplementationPackSchema>;
