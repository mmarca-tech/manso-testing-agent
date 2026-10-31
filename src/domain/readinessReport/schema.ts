import { z } from "zod";

/** Outcome of a single readiness check. */
export const CHECK_STATUSES = ["pass", "warn", "fail"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** One line item in a readiness report. */
export const ReadinessCheckSchema = z.object({
  /** Short check name, e.g. "Agent config". */
  name: z.string().min(1),
  status: z.enum(CHECK_STATUSES),
  /** Human-readable detail explaining the status. */
  message: z.string(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

/** A scored assessment of how ready a repository is for Manso. */
export const ReadinessReportSchema = z.object({
  /** Absolute path to the assessed repository. */
  repoRoot: z.string().min(1),
  /** Overall readiness score, 0-100. */
  score: z.number().int().min(0).max(100),
  checks: z.array(ReadinessCheckSchema),
  /** True when a mandatory check failed; the run must not proceed. */
  hardFailure: z.boolean(),
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;
