import { z } from "zod";
import {
  AcceptanceCriterionSchema,
  ToolProvenanceSchema,
  WarningSchema,
} from "../contextPack/schema.js";

export const TEST_DESIGN_SCHEMA_VERSION = "1.0.0" as const;

export const RISK_LEVELS = ["high", "medium", "low"] as const;
export const READINESS_LEVELS = ["ready", "needs-clarification"] as const;
export const GHERKIN_KEYWORDS = ["Given", "When", "Then", "And", "But"] as const;
/**
 * Scenario polarity — a structured signal (not a tag) of what kind of behaviour
 * a scenario exercises, used by the risk/edge coverage gate (M22):
 *   - "positive"  → happy path / valid behaviour.
 *   - "negative"  → error / rejection / failure path.
 *   - "boundary"  → edge & boundary values, limits, unusual-but-valid data.
 */
export const SCENARIO_POLARITIES = ["positive", "negative", "boundary"] as const;
/** Categories for a derived requirement inferred beyond the literal ACs (M22). */
export const DERIVED_REQUIREMENT_CATEGORIES = [
  "error",
  "boundary",
  "security",
  "data",
  "state",
  "performance",
  "usability",
  "other",
] as const;

export const GherkinStepSchema = z
  .object({
    keyword: z.enum(GHERKIN_KEYWORDS),
    text: z.string().min(1),
    /**
     * Optional Gherkin data table attached to this step — an array of rows,
     * each row an array of cell strings (the first row is typically a header).
     * Use this for steps that assert a list of values (columns, options, …)
     * instead of emitting separate `And <value>` steps.
     */
    dataTable: z.array(z.array(z.string().min(1)).min(1)).min(1).optional(),
  })
  .strict();

export const GherkinExamplesSchema = z
  .object({
    headers: z.array(z.string().min(1)).min(1),
    rows: z.array(z.array(z.string())).min(1),
  })
  .strict();

export const SourceEvidenceSchema = z
  .object({
    /** Where the evidence came from: description, comment:<id>, confluence:<title>, ... */
    source: z.string().min(1),
    /** Pointer into the source (paragraph, line range, section header, ...). */
    reference: z.string().min(1),
    /** Why this evidence justifies the scenario or AC. */
    summary: z.string().min(1),
  })
  .strict();

export const GherkinScenarioSchema = z
  .object({
    kind: z.literal("gherkin"),
    /** Scenario title in business language. */
    title: z.string().min(1),
    /** Feature this scenario belongs to. Scenarios with the same feature are
     *  rendered into the same `.feature` file by the writer. */
    feature: z.string().min(1),
    /** Feature-area tags only (e.g. `@login`). `@smoke` is derived for high
     *  risk; AC ids, risk levels, and polarity live in structured fields, not tags. */
    tags: z.array(z.string()),
    /** AC ids this scenario covers. Must reference ids from the
     *  TestDesignPack.acceptanceCriteria array. */
    acIds: z.array(z.string()),
    risk: z.enum(RISK_LEVELS),
    readiness: z.enum(READINESS_LEVELS),
    /** Plain-language objective: what business behaviour does this verify? */
    objective: z.string().min(1),
    preconditions: z.array(z.string()),
    steps: z.array(GherkinStepSchema).min(1),
    examples: GherkinExamplesSchema.optional(),
    /** What kind of behaviour this exercises (M22 risk/edge gate). Omitted ⇒ positive. */
    polarity: z.enum(SCENARIO_POLARITIES).optional(),
    /** Ids of derived requirements (DR-n) this scenario covers (M22). */
    drIds: z.array(z.string()).optional(),
    sourceEvidence: z.array(SourceEvidenceSchema),
    openQuestions: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();

export type GherkinScenario = z.infer<typeof GherkinScenarioSchema>;

/** One manual step in a plain-English test case: an action and its expected result. */
export const PlainEnglishStepSchema = z
  .object({
    action: z.string().min(1),
    expectedResult: z.string().min(1),
  })
  .strict();

/**
 * A plain-English (manual) test case. Same structured fields as a Gherkin
 * scenario (so coverage, risk ranking, and tags work uniformly), but its steps
 * are action/expected-result pairs rather than Given/When/Then. Produced when
 * `outputMode` is "plain-english"; uploaded to Xray as Manual tests.
 */
export const PlainEnglishScenarioSchema = z
  .object({
    kind: z.literal("plain-english"),
    title: z.string().min(1),
    feature: z.string().min(1),
    tags: z.array(z.string()),
    acIds: z.array(z.string()),
    risk: z.enum(RISK_LEVELS),
    readiness: z.enum(READINESS_LEVELS),
    objective: z.string().min(1),
    preconditions: z.array(z.string()),
    steps: z.array(PlainEnglishStepSchema).min(1),
    /** What kind of behaviour this exercises (M22 risk/edge gate). Omitted ⇒ positive. */
    polarity: z.enum(SCENARIO_POLARITIES).optional(),
    /** Ids of derived requirements (DR-n) this scenario covers (M22). */
    drIds: z.array(z.string()).optional(),
    sourceEvidence: z.array(SourceEvidenceSchema),
    openQuestions: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();

export type PlainEnglishStep = z.infer<typeof PlainEnglishStepSchema>;
export type PlainEnglishScenario = z.infer<typeof PlainEnglishScenarioSchema>;

/** A scenario in any output mode, discriminated by `kind`. */
export const TestScenarioSchema = z.discriminatedUnion("kind", [
  GherkinScenarioSchema,
  PlainEnglishScenarioSchema,
]);
export type TestScenario = z.infer<typeof TestScenarioSchema>;

/** Maps each acceptance criterion to the scenarios that cover it (by index). */
export const AcCoverageEntrySchema = z
  .object({
    acId: z.string().min(1),
    scenarioIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();

/** Groups scenario indexes by risk level for prioritisation surfaces. */
export const RiskRankingEntrySchema = z
  .object({
    level: z.enum(RISK_LEVELS),
    scenarioIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();

/**
 * A requirement the agent inferred from the full context that the literal
 * acceptance criteria do NOT state — an implied error path, boundary, security
 * concern, data variation, etc. (M22). Kept separate from `acceptanceCriteria`
 * so the literal product contract stays honest; these are additional coverage
 * targets, each justified by `sourceEvidence` so a reviewer can reject noise.
 */
export const DerivedRequirementSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    category: z.enum(DERIVED_REQUIREMENT_CATEGORIES),
    risk: z.enum(RISK_LEVELS),
    sourceEvidence: z.array(SourceEvidenceSchema),
  })
  .strict();

/**
 * Result of the risk/edge coverage audit (M22) for one target — an acceptance
 * criterion or a derived requirement. A target is `satisfied` when it has at
 * least one covering scenario AND (if high risk) at least one of those is a
 * negative or boundary scenario.
 */
export const RiskCoverageEntrySchema = z
  .object({
    targetId: z.string().min(1),
    targetKind: z.enum(["ac", "derived"]),
    risk: z.enum(RISK_LEVELS),
    scenarioIndexes: z.array(z.number().int().nonnegative()),
    negativeOrBoundaryScenarioIndexes: z.array(z.number().int().nonnegative()),
    satisfied: z.boolean(),
  })
  .strict();

/** Result of applying a single scenario to Xray. */
export const XRAY_APPLIED_TEST_STATUSES = ["created", "skipped-existing", "failed"] as const;
export const XrayAppliedTestSchema = z
  .object({
    scenarioIndex: z.number().int().nonnegative(),
    title: z.string().min(1),
    status: z.enum(XRAY_APPLIED_TEST_STATUSES),
    /** Xray test issue key, when known (e.g. "PROJ-456"). */
    key: z.string().optional(),
    /** Numeric Xray issue id, when known. */
    issueId: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

/**
 * Design-revision delta (M26): when the ticket already has linked tests, the
 * fresh design is semantically compared against them — `kept` records design
 * scenarios skipped because an existing test already covers them; `retireCandidates`
 * are manso-created linked tests no scenario in the latest design covers
 * (reported for human review, NEVER auto-deleted).
 */
export const XrayRevisionSchema = z
  .object({
    kept: z.array(
      z
        .object({
          scenarioTitle: z.string().min(1),
          matchedKey: z.string().optional(),
          matchedTitle: z.string().min(1),
          /** Blended similarity 0..1 from the semantic matcher. */
          similarity: z.number().min(0).max(1),
        })
        .strict(),
    ),
    retireCandidates: z.array(z.object({ key: z.string().min(1), title: z.string().min(1) }).strict()),
  })
  .strict();

/** Aggregate result of an Xray upload phase. */
export const XRAY_APPLICATION_STATUSES = ["applied", "dry-run", "skipped-by-gate"] as const;
export const XrayApplicationSchema = z
  .object({
    status: z.enum(XRAY_APPLICATION_STATUSES),
    ticketKey: z.string().min(1),
    tests: z.array(XrayAppliedTestSchema),
    /** Present when the ticket already had linked tests to revise against (M26). */
    revision: XrayRevisionSchema.optional(),
    provenance: z.array(ToolProvenanceSchema),
    warnings: z.array(WarningSchema),
  })
  .strict();

export const TestDesignPackSchema = z
  .object({
    schemaVersion: z.literal(TEST_DESIGN_SCHEMA_VERSION),
    ticket: z
      .object({
        key: z.string().min(1),
        title: z.string().min(1),
      })
      .strict(),
    outputMode: z.enum(["gherkin", "plain-english"]),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema),
    strategySummary: z.string(),
    coverageGaps: z.array(z.string()),
    scenarios: z.array(TestScenarioSchema),
    acCoverageMatrix: z.array(AcCoverageEntrySchema),
    riskRanking: z.array(RiskRankingEntrySchema),
    /** Requirements inferred beyond the literal ACs (M22). Present when the
     *  derived-requirement pass ran. */
    derivedRequirements: z.array(DerivedRequirementSchema).optional(),
    /** Per-target risk/edge coverage audit (M22). Present when the pass ran. */
    riskCoverageMatrix: z.array(RiskCoverageEntrySchema).optional(),
    openQuestions: z.array(z.string()),
    /** AC ids satisfied by an existing repo scenario, so no new scenario was written. */
    acsCoveredByExisting: z.array(z.string()).optional(),
    provenance: z
      .object({
        generatedAt: z.string().datetime(),
        issueKey: z.string().min(1),
        sourceContextPath: z.string().optional(),
        llm: z
          .object({
            provider: z.enum(["openai", "anthropic"]),
            model: z.string().min(1),
          })
          .strict(),
        tools: z.array(ToolProvenanceSchema),
      })
      .strict(),
    warnings: z.array(WarningSchema),
    /** Populated by the Xray sink (M8) when scenarios are uploaded. */
    application: XrayApplicationSchema.optional(),
  })
  .strict();

export type GherkinStep = z.infer<typeof GherkinStepSchema>;
export type GherkinExamples = z.infer<typeof GherkinExamplesSchema>;
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export type AcCoverageEntry = z.infer<typeof AcCoverageEntrySchema>;
export type RiskRankingEntry = z.infer<typeof RiskRankingEntrySchema>;
export type DerivedRequirement = z.infer<typeof DerivedRequirementSchema>;
export type RiskCoverageEntry = z.infer<typeof RiskCoverageEntrySchema>;
export type ScenarioPolarity = (typeof SCENARIO_POLARITIES)[number];
export type DerivedRequirementCategory = (typeof DERIVED_REQUIREMENT_CATEGORIES)[number];
export type TestDesignPack = z.infer<typeof TestDesignPackSchema>;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type ReadinessLevel = (typeof READINESS_LEVELS)[number];
export type XrayAppliedTest = z.infer<typeof XrayAppliedTestSchema>;
export type XrayRevision = z.infer<typeof XrayRevisionSchema>;
export type XrayApplication = z.infer<typeof XrayApplicationSchema>;
