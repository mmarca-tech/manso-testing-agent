import { z } from "zod";
import { ContextPackSchema, ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";
import { PullRequestDiffSchema } from "../prChanges/schema.js";

export const CODE_REVIEW_SCHEMA_VERSION = "1.0.0" as const;

export const CodeReviewPullRequestSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string().optional(),
    sourceBranch: z.string().optional(),
    targetBranch: z.string().optional(),
    repository: z.string().optional(),
    project: z.string().optional(),
    organization: z.string().optional(),
    url: z.string().url(),
  })
  .strict();

export const CodeReviewFindingSchema = z
  .object({
    title: z.string().min(1),
    severity: z.enum(["blocker", "high", "medium", "low", "info"]),
    category: z.enum(["technical", "business"]),
    details: z.string().min(1),
    recommendation: z.string().min(1),
    evidence: z.array(z.string()),
    filePath: z.string().optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();

export const CodeReviewResultSchema = z
  .object({
    summary: z.string().min(1),
    businessImpact: z.string().min(1),
    technicalAssessment: z.string().min(1),
    approvalRecommendation: z.enum(["approve", "approve-with-comments", "changes-requested", "needs-human-review"]),
    findings: z.array(CodeReviewFindingSchema),
    questions: z.array(z.string()),
  })
  .strict();

export const CodeReviewPackSchema = z
  .object({
    schemaVersion: z.literal(CODE_REVIEW_SCHEMA_VERSION),
    pullRequest: CodeReviewPullRequestSchema,
    ticket: ContextPackSchema.optional(),
    detectedTicketKey: z.string().optional(),
    diff: PullRequestDiffSchema,
    review: CodeReviewResultSchema,
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        llm: z
          .object({
            provider: z.string().min(1),
            model: z.string().min(1),
          })
          .strict(),
        tools: z.array(ToolProvenanceSchema),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type CodeReviewPullRequest = z.infer<typeof CodeReviewPullRequestSchema>;
export type CodeReviewFinding = z.infer<typeof CodeReviewFindingSchema>;
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;
export type CodeReviewPack = z.infer<typeof CodeReviewPackSchema>;
