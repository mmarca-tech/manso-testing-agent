import { z } from "zod";
import { ToolProvenanceSchema, WarningSchema } from "../contextPack/schema.js";

export const XRAY_TEST_GENERATION_SCHEMA_VERSION = "1.0.0" as const;

export const XrayGeneratedTestStepSchema = z
  .object({
    action: z.string().min(1),
    data: z.string().optional(),
    expectedResult: z.string().min(1),
  })
  .strict();

export const XrayGeneratedTestEvidenceSchema = z
  .object({
    source: z.enum(["jira", "comment", "pull-request", "code-diff", "confluence", "xray-review", "existing-xray-test", "assumption"]),
    reference: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export const XrayGeneratedTestCaseSchema = z
  .object({
    action: z.enum(["create", "update", "keep", "deprecate"]),
    existingTestKey: z.string().min(1).optional(),
    title: z.string().min(1),
    objective: z.string().min(1),
    priority: z.enum(["low", "medium", "high"]),
    coverageAreas: z.array(z.string()),
    preconditions: z.array(z.string()),
    steps: z.array(XrayGeneratedTestStepSchema),
    sourceEvidence: z.array(XrayGeneratedTestEvidenceSchema),
    riskCovered: z.string().min(1),
    readiness: z.enum(["ready", "needs-clarification"]),
    openQuestions: z.array(z.string()),
    rationale: z.string().min(1),
  })
  .strict();

export const XrayTestGenerationPlanSchema = z
  .object({
    strategySummary: z.string().min(1),
    coverageGaps: z.array(z.string()),
    testCases: z.array(XrayGeneratedTestCaseSchema),
  })
  .strict();

export const AppliedXrayTestCaseSchema = z
  .object({
    action: z.enum(["create", "update", "keep", "deprecate"]),
    status: z.enum(["created", "updated", "kept", "deprecated", "skipped"]),
    requestedTitle: z.string().min(1),
    existingTestKey: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    issueId: z.string().min(1).optional(),
    linkedToTicket: z.boolean().optional(),
    warnings: z.array(z.string()),
  })
  .strict();

export const AppliedXrayTestSetSchema = z
  .object({
    status: z.enum(["created", "dry-run", "skipped"]),
    title: z.string().min(1),
    key: z.string().min(1).optional(),
    issueId: z.string().min(1).optional(),
    includedTestKeys: z.array(z.string()),
    includedTestIssueIds: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

export const XrayTestApplicationSchema = z
  .object({
    status: z.enum(["applied", "dry-run"]),
    tests: z.array(AppliedXrayTestCaseSchema),
    testSet: AppliedXrayTestSetSchema,
  })
  .strict();

export const XrayTestGenerationPackSchema = z
  .object({
    schemaVersion: z.literal(XRAY_TEST_GENERATION_SCHEMA_VERSION),
    ticket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
        url: z.string().optional(),
      })
      .strict(),
    plan: XrayTestGenerationPlanSchema,
    application: XrayTestApplicationSchema,
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        sourceContextPath: z.string().min(1),
        sourceXrayTestReviewPath: z.string().min(1).optional(),
        sourcePrChangesPath: z.string().min(1).optional(),
        sourceConfluenceImpactPath: z.string().min(1).optional(),
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

export type XrayGeneratedTestStep = z.infer<typeof XrayGeneratedTestStepSchema>;
export type XrayGeneratedTestEvidence = z.infer<typeof XrayGeneratedTestEvidenceSchema>;
export type XrayGeneratedTestCase = z.infer<typeof XrayGeneratedTestCaseSchema>;
export type XrayTestGenerationPlan = z.infer<typeof XrayTestGenerationPlanSchema>;
export type AppliedXrayTestCase = z.infer<typeof AppliedXrayTestCaseSchema>;
export type AppliedXrayTestSet = z.infer<typeof AppliedXrayTestSetSchema>;
export type XrayTestApplication = z.infer<typeof XrayTestApplicationSchema>;
export type XrayTestGenerationPack = z.infer<typeof XrayTestGenerationPackSchema>;
