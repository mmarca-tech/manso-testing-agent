import { z } from "zod";
import { PersonSchema, ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const PR_CHANGES_SCHEMA_VERSION = "1.0.0" as const;

export const PullRequestFileChangeSchema = z
  .object({
    path: z.string().min(1),
    changeType: z.string().min(1),
    originalPath: z.string().optional(),
    isFolder: z.boolean().optional(),
    url: z.string().optional(),
  })
  .strict();

export const PullRequestSourceFileSchema = z
  .object({
    path: z.string().min(1),
    role: z.literal("changed"),
    changeType: z.string().optional(),
    language: z.string().optional(),
    content: z.string(),
    truncated: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();

export const PullRequestCommitSchema = z
  .object({
    id: z.string().min(1),
    comment: z.string().optional(),
    author: PersonSchema.optional(),
    authoredAt: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

export const PullRequestDiffSchema = z
  .object({
    provider: z.string().min(1),
    files: z.array(PullRequestFileChangeSchema),
    sourceFiles: z.array(PullRequestSourceFileSchema).default([]),
    commits: z.array(PullRequestCommitSchema),
    changeCounts: z.record(z.string(), z.number()),
    allChangesIncluded: z.boolean().optional(),
  })
  .strict();

export const PullRequestUnderstandingSchema = z
  .object({
    summary: z.string().min(1),
    changeAreas: z.array(z.string()),
    risks: z.array(z.string()),
    testingNotes: z.array(z.string()),
  })
  .strict();

export const PullRequestChangeSummarySchema = z
  .object({
    title: z.string().min(1),
    status: z.string().optional(),
    url: z.string().optional(),
    repository: z.string().optional(),
    provider: z.string().optional(),
    sourceBranch: z.string().optional(),
    targetBranch: z.string().optional(),
    author: PersonSchema.optional(),
    lastUpdatedAt: z.string().optional(),
    diff: PullRequestDiffSchema,
    understanding: PullRequestUnderstandingSchema,
  })
  .strict();

export const PrChangesPackSchema = z
  .object({
    schemaVersion: z.literal(PR_CHANGES_SCHEMA_VERSION),
    ticket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
        url: z.string().optional(),
      })
      .strict(),
    pullRequests: z.array(PullRequestChangeSummarySchema),
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        sourceContextPath: z.string().min(1),
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

export type PullRequestFileChange = z.infer<typeof PullRequestFileChangeSchema>;
export type PullRequestSourceFile = z.infer<typeof PullRequestSourceFileSchema>;
export type PullRequestCommit = z.infer<typeof PullRequestCommitSchema>;
export type PullRequestDiff = z.infer<typeof PullRequestDiffSchema>;
export type PullRequestUnderstanding = z.infer<typeof PullRequestUnderstandingSchema>;
export type PullRequestChangeSummary = z.infer<typeof PullRequestChangeSummarySchema>;
export type PrChangesPack = z.infer<typeof PrChangesPackSchema>;
