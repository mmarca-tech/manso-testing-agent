/**
 * Common provenance and warning primitives, re-exported from the ContextPack
 * domain so non-ContextPack artifacts (TestDesignPack, ImplementationPack,
 * LearningRecord, ReadinessReport, ...) can import them from a neutral path.
 */
export { WarningSchema, ToolProvenanceSchema } from "../contextPack/schema.js";
export type { Warning, ToolProvenance } from "../contextPack/schema.js";
