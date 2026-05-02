import { z } from "zod";
import { ConfluencePageSchema, ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const CONFLUENCE_IMPACT_SCHEMA_VERSION = "1.0.0" as const;

export const ConfluenceImpactSchema = z
  .object({
    summary: z.string().min(1),
    ticketRelevance: z.string().min(1),
    impactedAreas: z.array(z.string()),
    decisionsOrConstraints: z.array(z.string()),
    risks: z.array(z.string()),
    testingNotes: z.array(z.string()),
  })
  .strict();

export const ConfluenceImpactPageSchema = z
  .object({
    page: ConfluencePageSchema,
    extraction: z
      .object({
        contentSource: z.enum(["context", "confluence-rest"]),
        bodyAvailable: z.boolean(),
        bodyLength: z.number().int().nonnegative(),
      })
      .strict(),
    impact: ConfluenceImpactSchema,
  })
  .strict();

export const ConfluenceImpactPackSchema = z
  .object({
    schemaVersion: z.literal(CONFLUENCE_IMPACT_SCHEMA_VERSION),
    ticket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
        url: z.string().optional(),
      })
      .strict(),
    pages: z.array(ConfluenceImpactPageSchema),
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

export type ConfluenceImpact = z.infer<typeof ConfluenceImpactSchema>;
export type ConfluenceImpactPage = z.infer<typeof ConfluenceImpactPageSchema>;
export type ConfluenceImpactPack = z.infer<typeof ConfluenceImpactPackSchema>;
