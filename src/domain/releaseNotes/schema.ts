import { z } from "zod";
import { WarningSchema } from "../contextPack/schema.js";

export const RELEASE_NOTES_SCHEMA_VERSION = "1.1.0" as const;

export const ReleaseNoteChangeItemSchema = z
  .object({
    area: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const ReleaseNotesTicketSummarySchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

/** The three sections of the team release-note template (Product Team X / TI 9a). */
export const ReleaseNoteSectionSchema = z.enum(["newFeature", "maintenance", "bugFix"]);

/**
 * One LLM-authored, per-ticket entry. Prose only — ticket URL, product
 * affected and release date are joined in deterministically from Jira so the
 * model cannot invent them.
 */
export const ReleaseNoteEntrySchema = z
  .object({
    key: z.string().min(1),
    section: ReleaseNoteSectionSchema,
    description: z.string().min(1),
    /** Why the change matters; absent when the ticket does not say. */
    why: z.string().nullish(),
    /** True when the source tickets lack the context to state the value honestly. */
    insufficientContext: z.boolean().default(false),
  })
  .strict();

export const ReleaseNotesSchema = z
  .object({
    title: z.string().min(1),
    audience: z.string().min(1),
    summary: z.string().min(1),
    highlights: z.array(z.string()),
    changeItems: z.array(ReleaseNoteChangeItemSchema),
    deploymentNotes: z.array(z.string()),
    testingNotes: z.array(z.string()),
    knownRisks: z.array(z.string()),
    ticketSummaries: z.array(ReleaseNotesTicketSummarySchema),
    /** Defaulted so a model that omits them degrades to issue-type classification instead of the fallback. */
    releaseEntries: z.array(ReleaseNoteEntrySchema).default([]),
    /** What readers need to do, if anything. Empty unless the tickets support it. */
    actionNeeded: z.array(z.string()).default([]),
  })
  .strict();

export const TeamTemplateRowSchema = z
  .object({
    ticketKey: z.string().min(1),
    ticketUrl: z.string().optional(),
    description: z.string().min(1),
    why: z.string().optional(),
    /** Affected services first, then components; de-duplicated. */
    productAffected: z.array(z.string()),
    releaseDate: z.string().optional(),
    insufficientContext: z.boolean(),
  })
  .strict();

export const TeamTemplateSchema = z
  .object({
    newFeatures: z.array(TeamTemplateRowSchema),
    maintenance: z.array(TeamTemplateRowSchema),
    bugFixes: z.array(TeamTemplateRowSchema),
  })
  .strict();

export const ReleaseMetadataSchema = z
  .object({
    version: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    contributors: z.array(z.string()),
  })
  .strict();

export const ExcludedTicketSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    status: z.string().optional(),
    reason: z.string().min(1),
  })
  .strict();

export const ReleaseTicketRefSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().optional(),
    issueType: z.string().optional(),
    status: z.string().optional(),
    /** When the release completed (e.g. JSM "Change completion date"); site-local offset. */
    completedAt: z.string().optional(),
  })
  .strict();

export const ReleaseNotesPackSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_NOTES_SCHEMA_VERSION),
    releaseIssueKey: z.string().min(1),
    /** The release ticket itself; optional so packs written before it existed still parse. */
    releaseTicket: ReleaseTicketRefSchema.optional(),
    notes: ReleaseNotesSchema,
    releaseMetadata: ReleaseMetadataSchema,
    teamTemplate: TeamTemplateSchema,
    /** Linked tickets left out of the notes, for reviewer visibility. */
    excludedTickets: z.array(ExcludedTicketSchema),
    linkedTicketKeys: z.array(z.string()),
    pullRequestsAnalyzed: z.number().int().nonnegative(),
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        llm: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
        commentPosted: z.boolean(),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type ReleaseNoteChangeItem = z.infer<typeof ReleaseNoteChangeItemSchema>;
export type ReleaseNotesTicketSummary = z.infer<typeof ReleaseNotesTicketSummarySchema>;
export type ReleaseNoteSection = z.infer<typeof ReleaseNoteSectionSchema>;
export type ReleaseNoteEntry = z.infer<typeof ReleaseNoteEntrySchema>;
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;
export type TeamTemplateRow = z.infer<typeof TeamTemplateRowSchema>;
export type TeamTemplate = z.infer<typeof TeamTemplateSchema>;
export type ReleaseMetadata = z.infer<typeof ReleaseMetadataSchema>;
export type ExcludedTicket = z.infer<typeof ExcludedTicketSchema>;
export type ReleaseTicketRef = z.infer<typeof ReleaseTicketRefSchema>;
export type ReleaseNotesPack = z.infer<typeof ReleaseNotesPackSchema>;
/** The parts of a pack the internal (team-template) renderers need. */
export type TeamReleaseNotes = Pick<ReleaseNotesPack, "notes" | "releaseMetadata" | "teamTemplate" | "excludedTickets">;

export const MONTHLY_RELEASE_NOTES_SCHEMA_VERSION = "1.0.0" as const;

export const MonthlySummarySchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    highlights: z.array(z.string()),
  })
  .strict();

/** All releases (e.g. JSM changes) completed in one calendar month, plus a month-level summary. */
export const MonthlyReleaseNotesPackSchema = z
  .object({
    schemaVersion: z.literal(MONTHLY_RELEASE_NOTES_SCHEMA_VERSION),
    kind: z.literal("monthly"),
    project: z.string().min(1),
    issueType: z.string().min(1),
    /** `YYYY-MM`. */
    month: z.string().regex(/^\d{4}-\d{2}$/),
    /** The exact query used to select the releases, for traceability. */
    jql: z.string().min(1),
    matchedCount: z.number().int().nonnegative(),
    /** Matched releases whose notes could not be built; each also has a warning. */
    failedKeys: z.array(z.string()),
    summary: MonthlySummarySchema,
    releases: z.array(ReleaseNotesPackSchema),
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        llm: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
        concurrency: z.number().int().positive(),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type MonthlySummary = z.infer<typeof MonthlySummarySchema>;
export type MonthlyReleaseNotesPack = z.infer<typeof MonthlyReleaseNotesPackSchema>;
