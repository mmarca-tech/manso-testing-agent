import { z } from "zod";

export const CONTEXT_SCHEMA_VERSION = "1.0.0" as const;

export const PersonSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    accountId: z.string().optional(),
  })
  .strict();

export const WarningSchema = z
  .object({
    section: z.string().min(1),
    toolName: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .strict();

export const ToolProvenanceSchema = z
  .object({
    method: z.string().min(1),
    toolName: z.string().min(1),
    calledAt: z.string().datetime(),
    success: z.boolean(),
    message: z.string().optional(),
  })
  .strict();

export const TicketLinkSchema = z
  .object({
    relationship: z.string().optional(),
    direction: z.enum(["inward", "outward", "unknown"]),
    issueKey: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
    issueType: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

export const TicketSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    issueType: z.string().optional(),
    status: z.string().optional(),
    assignee: PersonSchema.optional(),
    reporter: PersonSchema.optional(),
    labels: z.array(z.string()),
    components: z.array(z.string()),
    url: z.string().optional(),
    links: z.array(TicketLinkSchema),
  })
  .strict();

export const DescriptionSchema = z
  .object({
    format: z.enum(["text", "markdown", "adf", "html", "unknown"]),
    text: z.string(),
    rawFormat: z.string().optional(),
  })
  .strict();

export const CommentSchema = z
  .object({
    id: z.string().optional(),
    author: PersonSchema.optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    body: z.string(),
    visibility: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

export const AttachmentSchema = z
  .object({
    id: z.string().optional(),
    filename: z.string().min(1),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    url: z.string().optional(),
  })
  .strict();

export const XrayTestCaseSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    status: z.string().optional(),
    description: z.string().optional(),
    labels: z.array(z.string()),
    relationship: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

export const BranchSchema = z
  .object({
    name: z.string().min(1),
    repository: z.string().optional(),
    provider: z.string().optional(),
    url: z.string().optional(),
    lastUpdatedAt: z.string().optional(),
  })
  .strict();

export const PullRequestSchema = z
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
  })
  .strict();

export const DevelopmentSchema = z
  .object({
    branches: z.array(BranchSchema),
    pullRequests: z.array(PullRequestSchema),
  })
  .strict();

export const ConfluencePageSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1),
    space: z.string().optional(),
    url: z.string().optional(),
    updatedAt: z.string().optional(),
    body: z.string().optional(),
  })
  .strict();

export const ContextPackSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_SCHEMA_VERSION),
    ticket: TicketSchema,
    description: DescriptionSchema,
    comments: z.array(CommentSchema),
    attachments: z.array(AttachmentSchema).default([]),
    xrayTestCases: z.array(XrayTestCaseSchema),
    development: DevelopmentSchema,
    confluencePages: z.array(ConfluencePageSchema),
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        issueKey: z.string().min(1),
        source: z.literal("jira-rest"),
        tools: z.array(ToolProvenanceSchema),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type Person = z.infer<typeof PersonSchema>;
export type Warning = z.infer<typeof WarningSchema>;
export type ToolProvenance = z.infer<typeof ToolProvenanceSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type TicketLink = z.infer<typeof TicketLinkSchema>;
export type Description = z.infer<typeof DescriptionSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type XrayTestCase = z.infer<typeof XrayTestCaseSchema>;
export type Branch = z.infer<typeof BranchSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type Development = z.infer<typeof DevelopmentSchema>;
export type ConfluencePage = z.infer<typeof ConfluencePageSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
