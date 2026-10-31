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

export const FixVersionSchema = z
  .object({
    name: z.string().min(1),
    released: z.boolean().optional(),
    /** As Jira reports it, typically `YYYY-MM-DD`. */
    releaseDate: z.string().optional(),
  })
  .strict();

export const TicketSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    issueType: z.string().optional(),
    status: z.string().optional(),
    /** Jira status category key: "new", "indeterminate" or "done". Stable across team workflows. */
    statusCategory: z.string().optional(),
    /** Resolution name, e.g. "Done", "Won't Do", "Duplicate". */
    resolution: z.string().optional(),
    assignee: PersonSchema.optional(),
    reporter: PersonSchema.optional(),
    labels: z.array(z.string()),
    components: z.array(z.string()),
    fixVersions: z.array(FixVersionSchema).optional(),
    /** When the work actually completed: JSM "Change completion date", else the resolution date. Site-local offset, as Jira returns it. */
    completedAt: z.string().optional(),
    /** Display names from the "Affected services" custom field, resolved by field name. */
    affectedServices: z.array(z.string()).optional(),
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
    /** Extracted/understood content (M10e). Truncated; marked when shortened. */
    analysis: z.string().optional(),
    /** How {@link analysis} was produced. */
    analysisSource: z.enum(["text-extraction", "vision", "pdf-text", "ocr"]).optional(),
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

/**
 * A non-test ticket related to the story (epic/parent, subtask, or a linked
 * story/bug) whose body the Researcher fetched for additional requirement
 * context. Linked Xray Tests go to {@link XrayTestCaseSchema} instead.
 */
export const RelatedTicketSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    issueType: z.string().optional(),
    status: z.string().optional(),
    /** How it relates to the story, e.g. "parent", "subtask", "relates to". */
    relationship: z.string().optional(),
    /** Truncated body — visibly marked with "…[truncated]" when shortened. */
    description: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

/**
 * An atomic acceptance criterion extracted from the ticket. Populated by the
 * Test Architect's AC extraction pass (M6). Empty/undefined in M4 contexts.
 */
export const AcceptanceCriterionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    /** Where the criterion was extracted from, e.g. "description" or "comment:42". */
    source: z.string().optional(),
  })
  .strict();

/** A citation pointing back at the source chunk a claim was derived from. */
export const RetrievalCitationSchema = z
  .object({
    source: z.string().min(1),
    reference: z.string().min(1),
    excerpt: z.string().optional(),
  })
  .strict();

/** A typed node in the {@link EvidenceGraphSchema}. */
export const EvidenceGraphNodeSchema = z
  .object({
    /** Node kind: ticket, confluencePage, figmaFrame, xrayTest, pullRequest, requirement, ... */
    type: z.string().min(1),
    id: z.string().min(1),
    label: z.string().optional(),
  })
  .strict();

/** A typed edge in the {@link EvidenceGraphSchema}. */
export const EvidenceGraphEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    /** Edge kind: documents, illustrates, coveredBy, implementedIn, introduces, ... */
    type: z.string().min(1),
  })
  .strict();

/**
 * The provenance backbone for the traceability matrix. Built by the Context
 * Layer as providers are called; richer kinds and edges land in M10.
 */
export const EvidenceGraphSchema = z
  .object({
    nodes: z.array(EvidenceGraphNodeSchema),
    edges: z.array(EvidenceGraphEdgeSchema),
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
    relatedTickets: z.array(RelatedTicketSchema).optional(),
    development: DevelopmentSchema,
    confluencePages: z.array(ConfluencePageSchema),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
    evidenceGraph: EvidenceGraphSchema.optional(),
    retrievalCitations: z.array(RetrievalCitationSchema).optional(),
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
export type FixVersion = z.infer<typeof FixVersionSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type TicketLink = z.infer<typeof TicketLinkSchema>;
export type Description = z.infer<typeof DescriptionSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type XrayTestCase = z.infer<typeof XrayTestCaseSchema>;
export type RelatedTicket = z.infer<typeof RelatedTicketSchema>;
export type Branch = z.infer<typeof BranchSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type Development = z.infer<typeof DevelopmentSchema>;
export type ConfluencePage = z.infer<typeof ConfluencePageSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type RetrievalCitation = z.infer<typeof RetrievalCitationSchema>;
export type EvidenceGraphNode = z.infer<typeof EvidenceGraphNodeSchema>;
export type EvidenceGraphEdge = z.infer<typeof EvidenceGraphEdgeSchema>;
export type EvidenceGraph = z.infer<typeof EvidenceGraphSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
