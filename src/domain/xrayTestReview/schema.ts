import { z } from "zod";
import { ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const XRAY_TEST_REVIEW_SCHEMA_VERSION = "1.0.0" as const;

export const XrayReviewedTestCaseSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    status: z.string().optional(),
    relationship: z.string().optional(),
    url: z.string().optional(),
    summary: z.string().min(1),
    coveredAcceptanceCriteria: z.array(z.string()),
    coveredBehaviors: z.array(z.string()),
    testDataOrPreconditions: z.array(z.string()),
    gapsOrAmbiguities: z.array(z.string()),
    updateRecommendation: z.enum(["keep", "update", "deprecate", "unclear"]),
    rationale: z.string().min(1),
  })
  .strict();

export const XrayTestReviewAnalysisSchema = z
  .object({
    overallSummary: z.string().min(1),
    coveredAcceptanceCriteria: z.array(z.string()),
    gapsOrAmbiguities: z.array(z.string()),
    testCases: z.array(XrayReviewedTestCaseSchema),
  })
  .strict();

export const XrayTestReviewPackSchema = z
  .object({
    schemaVersion: z.literal(XRAY_TEST_REVIEW_SCHEMA_VERSION),
    ticket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
        url: z.string().optional(),
      })
      .strict(),
    review: XrayTestReviewAnalysisSchema,
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        sourceContextPath: z.string().min(1),
        llm: z
          .object({
            provider: z.string().min(1),
            model: z.string().min(1),
          })
          .strict()
          .optional(),
        tools: z.array(ToolProvenanceSchema),
      })
      .strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type XrayReviewedTestCase = z.infer<typeof XrayReviewedTestCaseSchema>;
export type XrayTestReviewAnalysis = z.infer<typeof XrayTestReviewAnalysisSchema>;
export type XrayTestReviewPack = z.infer<typeof XrayTestReviewPackSchema>;
