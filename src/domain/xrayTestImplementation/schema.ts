import { z } from "zod";
import { ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const XRAY_TEST_IMPLEMENTATION_SCHEMA_VERSION = "1.0.0" as const;

export const XrayTestImplementationGuidanceFileSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const XrayTestImplementationAgentUsageSchema = z
  .object({
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().min(1).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheCreationInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const XrayTestImplementationCommandResultSchema = z
  .object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    usage: XrayTestImplementationAgentUsageSchema.optional(),
  })
  .strict();

export const XrayTestImplementationHealingAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    promptPath: z.string().min(1),
    command: XrayTestImplementationCommandResultSchema,
    verification: XrayTestImplementationCommandResultSchema,
    changedFiles: z.array(z.string()),
  })
  .strict();

export const XrayTestImplementationResultSchema = z
  .object({
    status: z.enum(["prompt-only", "completed", "failed"]),
    repoRoot: z.string().min(1),
    branch: z.string().min(1),
    targetBranch: z.string().min(1),
    promptPath: z.string().min(1),
    guidanceFiles: z.array(XrayTestImplementationGuidanceFileSchema),
    command: XrayTestImplementationCommandResultSchema.optional(),
    verification: XrayTestImplementationCommandResultSchema.optional(),
    healingAttempts: z.array(XrayTestImplementationHealingAttemptSchema).optional(),
    changedFiles: z.array(z.string()),
    commitSha: z.string().min(1).optional(),
    pushed: z.boolean(),
  })
  .strict();

export const XrayTestImplementationPullRequestSchema = z
  .object({
    status: z.enum(["created", "reused", "skipped"]),
    provider: z.string().min(1).optional(),
    id: z.number().int().positive().optional(),
    url: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    targetBranch: z.string().min(1).optional(),
    sourceBranch: z.string().min(1).optional(),
    warnings: z.array(z.string()),
  })
  .strict();

export const XrayTestImplementationPackSchema = z
  .object({
    schemaVersion: z.literal(XRAY_TEST_IMPLEMENTATION_SCHEMA_VERSION),
    ticket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
        url: z.string().optional(),
      })
      .strict(),
    implementation: XrayTestImplementationResultSchema,
    pullRequest: XrayTestImplementationPullRequestSchema,
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        sourceXrayTestGenerationPath: z.string().min(1),
        tools: z.array(ToolProvenanceSchema),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type XrayTestImplementationGuidanceFile = z.infer<typeof XrayTestImplementationGuidanceFileSchema>;
export type XrayTestImplementationAgentUsage = z.infer<typeof XrayTestImplementationAgentUsageSchema>;
export type XrayTestImplementationCommandResult = z.infer<typeof XrayTestImplementationCommandResultSchema>;
export type XrayTestImplementationHealingAttempt = z.infer<typeof XrayTestImplementationHealingAttemptSchema>;
export type XrayTestImplementationResult = z.infer<typeof XrayTestImplementationResultSchema>;
export type XrayTestImplementationPullRequest = z.infer<typeof XrayTestImplementationPullRequestSchema>;
export type XrayTestImplementationPack = z.infer<typeof XrayTestImplementationPackSchema>;
