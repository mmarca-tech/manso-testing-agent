import { z } from "zod";

export const LEARNING_SCHEMA_VERSION = "1.0.0" as const;

/** Where the learning signal came from. */
export const LEARNING_SOURCES = ["pr-feedback", "heal-failure", "verify-failure", "manual"] as const;

/**
 * Whether a signal is a one-off (transient) or a recurring pattern worth
 * encoding into a guideline/skill (systemic). `unknown` when the classifier
 * cannot decide confidently.
 */
export const LEARNING_CLASSIFICATIONS = ["transient", "systemic", "unknown"] as const;

/** Coarse topic of the learning, used to route a proposed guideline edit. */
export const LEARNING_CATEGORIES = [
  "selector",
  "timing",
  "test-data",
  "assertion",
  "convention",
  "flaky",
  "infrastructure",
  "other",
] as const;

/**
 * A proposed change to a repository guideline/skill. NEVER applied
 * automatically — it is surfaced for a human to review and merge via a separate
 * pull request.
 */
export const ProposedChangeSchema = z
  .object({
    /** Repo-relative target, e.g. ".agents/guidelines/selectors.md". */
    targetPath: z.string().min(1),
    /** One-line summary of what the change teaches. */
    summary: z.string().min(1),
    /** The Markdown rule text to append/insert. */
    body: z.string().min(1),
  })
  .strict();
export type ProposedChange = z.infer<typeof ProposedChangeSchema>;

/** A single captured learning. */
export const LearningRecordSchema = z
  .object({
    schemaVersion: z.literal(LEARNING_SCHEMA_VERSION),
    id: z.string().min(1),
    createdAt: z.string().datetime(),
    source: z.enum(LEARNING_SOURCES),
    /** The raw feedback or error excerpt that produced this learning. */
    signal: z.string().min(1),
    classification: z.enum(LEARNING_CLASSIFICATIONS),
    category: z.enum(LEARNING_CATEGORIES),
    /** Why the classifier decided as it did. */
    rationale: z.string().min(1),
    issueKey: z.string().optional(),
    pullRequestId: z.number().int().optional(),
    /** A proposed guideline edit — present only for systemic learnings. */
    proposedChange: ProposedChangeSchema.optional(),
    /**
     * Always false at capture time: learnings are never silently applied. Flips
     * to true only after a human merges the proposal PR (recorded out of band).
     */
    applied: z.boolean().default(false),
  })
  .strict();
export type LearningRecord = z.infer<typeof LearningRecordSchema>;

/** A batch of learnings from one run, the durable artifact written per run. */
export const LearningRecordSetSchema = z
  .object({
    schemaVersion: z.literal(LEARNING_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    issueKey: z.string().optional(),
    records: z.array(LearningRecordSchema),
  })
  .strict();
export type LearningRecordSet = z.infer<typeof LearningRecordSetSchema>;

export type LearningSource = (typeof LEARNING_SOURCES)[number];
export type LearningClassification = (typeof LEARNING_CLASSIFICATIONS)[number];
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];
