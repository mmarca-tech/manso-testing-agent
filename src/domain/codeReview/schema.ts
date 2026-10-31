import { z } from "zod";
import { ContextPackSchema } from "../contextPack/schema.js";

export const CODE_REVIEW_SCHEMA_VERSION = "1.0.0" as const;
export const CodeReviewPullRequestSchema = z.object({
  id: z.number().int().positive(), title: z.string().min(1), url: z.string().url(),
  description: z.string().optional(), sourceBranch: z.string().optional(), targetBranch: z.string().optional(),
  sourceCommit: z.string().optional(), targetCommit: z.string().optional(),
}).strict();
export const CodeReviewResultSchema = z.object({
  summary: z.string().min(1),
  businessImpact: z.string().min(1),
  technicalAssessment: z.string().min(1),
  approvalRecommendation: z.enum(["approve", "approve-with-comments", "changes-requested", "needs-human-review"]),
  findings: z.array(z.object({
    title: z.string().min(1),
    severity: z.enum(["blocker", "high", "medium", "low", "info"]),
    category: z.enum(["technical", "business"]),
    details: z.string().min(1), recommendation: z.string().min(1), evidence: z.array(z.string()).min(1),
    filePath: z.string().optional(), line: z.number().int().positive().optional(),
    side: z.enum(["left", "right"]).optional(),
  }).strict()),
  questions: z.array(z.string()),
}).strict();
export const CodeReviewPackSchema = z.object({
  schemaVersion: z.literal(CODE_REVIEW_SCHEMA_VERSION),
  pullRequest: CodeReviewPullRequestSchema,
  ticket: ContextPackSchema.optional(),
  detectedTicketKey: z.string().optional(),
  diff: z.object({
    files: z.array(z.object({
      path: z.string(), changeType: z.enum(["add", "edit", "delete", "rename", "unknown"]), patch: z.string().optional(),
    }).strict()),
    hasPatches: z.boolean(), allChangesIncluded: z.boolean().optional(), warnings: z.array(z.string()).optional(),
  }).strict(),
  review: CodeReviewResultSchema,
  provenance: z.object({
    generatedAt: z.string().datetime(),
    llm: z.object({ provider: z.string(), model: z.string() }).strict(),
    runCostUsd: z.number().nonnegative().optional(),
  }).strict(),
  warnings: z.array(z.string()),
}).strict();
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;
export type CodeReviewFinding = CodeReviewResult["findings"][number];
export type CodeReviewPack = z.infer<typeof CodeReviewPackSchema>;
