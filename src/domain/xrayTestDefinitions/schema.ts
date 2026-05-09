import { z } from "zod";
import { ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const XRAY_TEST_DEFINITIONS_SCHEMA_VERSION = "1.0.0" as const;

export const XrayTestStepDefinitionSchema = z
  .object({
    action: z.string().min(1),
    data: z.string().optional(),
    expectedResult: z.string().optional(),
  })
  .strict();

export const XrayTestDefinitionSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    issueId: z.string().optional(),
    status: z.string().optional(),
    testType: z.string().optional(),
    description: z.string().optional(),
    labels: z.array(z.string()),
    gherkin: z.string().optional(),
    steps: z.array(XrayTestStepDefinitionSchema),
  })
  .strict();

export const XrayTestDefinitionsPackSchema = z
  .object({
    schemaVersion: z.literal(XRAY_TEST_DEFINITIONS_SCHEMA_VERSION),
    ticket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
        url: z.string().optional(),
      })
      .strict(),
    definitions: z.array(XrayTestDefinitionSchema),
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        sourceContextPath: z.string().min(1),
        tools: z.array(ToolProvenanceSchema),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type XrayTestStepDefinition = z.infer<typeof XrayTestStepDefinitionSchema>;
export type XrayTestDefinition = z.infer<typeof XrayTestDefinitionSchema>;
export type XrayTestDefinitionsPack = z.infer<typeof XrayTestDefinitionsPackSchema>;
