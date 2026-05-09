import { z } from "zod";
import { ContextPackSchema, ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const RELEASE_NOTES_SCHEMA_VERSION = "1.0.0" as const;

export const ReleaseNoteChangeItemSchema = z
  .object({
    area: z.string().min(1),
    description: z.string().min(1),
    impact: z.string().min(1),
    tickets: z.array(z.string()),
  })
  .strict();

export const ReleaseNoteTicketSummarySchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    issueType: z.string().optional(),
    status: z.string().optional(),
    relationship: z.string().optional(),
    summary: z.string().min(1),
    userImpact: z.string().optional(),
    technicalNotes: z.array(z.string()).optional(),
    developmentNotes: z.array(z.string()).optional(),
    confluenceNotes: z.array(z.string()).optional(),
    risks: z.array(z.string()),
    testingNotes: z.array(z.string()),
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
    ticketSummaries: z.array(ReleaseNoteTicketSummarySchema),
  })
  .strict();

export const ReleaseNotesLinkedTicketSchema = z
  .object({
    relationship: z.string().optional(),
    context: ContextPackSchema,
  })
  .strict();

export const ReleaseNotesPackSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_NOTES_SCHEMA_VERSION),
    releaseTicket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
        issueType: z.string().optional(),
        status: z.string().optional(),
        url: z.string().optional(),
      })
      .strict(),
    linkedTickets: z.array(ReleaseNotesLinkedTicketSchema),
    notes: ReleaseNotesSchema,
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        issueKey: z.string().min(1),
        source: z.literal("jira-rest"),
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

export type ReleaseNoteChangeItem = z.infer<typeof ReleaseNoteChangeItemSchema>;
export type ReleaseNoteTicketSummary = z.infer<typeof ReleaseNoteTicketSummarySchema>;
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;
export type ReleaseNotesLinkedTicket = z.infer<typeof ReleaseNotesLinkedTicketSchema>;
export type ReleaseNotesPack = z.infer<typeof ReleaseNotesPackSchema>;
