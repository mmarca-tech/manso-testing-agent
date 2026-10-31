import type { RiskCoverageEntry, TestDesignPack } from "../../domain/testDesignPack/schema.js";

/** Possible enforcement levels for the AC coverage gate. */
export type AcCoverageGate = "required" | "warn" | "off";

export interface CoverageAuditInput {
  testDesign: Pick<TestDesignPack, "acCoverageMatrix">;
  gate: AcCoverageGate;
  /**
   * AC ids already covered by existing repo scenarios (no new scenario written).
   * These count as covered even though no generated scenario references them.
   */
  coveredExternally?: string[];
}

export interface CoverageAuditResult {
  /** AC ids that have no scenarios pointing at them. */
  uncoveredAcIds: string[];
  /**
   * Final disposition after applying the gate:
   *   - "pass": no gaps, or gate is "off".
   *   - "warned": gaps exist and gate is "warn" (record but proceed).
   *   - "failed": gaps exist and gate is "required" (run must stop).
   */
  status: "pass" | "warned" | "failed";
}

/**
 * Audit the AC coverage matrix of a (partial) TestDesignPack and return a
 * status derived from the configured gate. Pure function — never throws.
 *
 * Spec §8 `design.acCoverage` SLO target is 100%. The Coverage Auditor is the
 * mechanism that enforces it.
 */
export function auditCoverage(input: CoverageAuditInput): CoverageAuditResult {
  const coveredExternally = new Set(input.coveredExternally ?? []);
  const uncoveredAcIds = input.testDesign.acCoverageMatrix
    .filter((entry) => entry.scenarioIndexes.length === 0 && !coveredExternally.has(entry.acId))
    .map((entry) => entry.acId);

  if (uncoveredAcIds.length === 0) {
    return { uncoveredAcIds: [], status: "pass" };
  }

  if (input.gate === "off") {
    return { uncoveredAcIds, status: "pass" };
  }

  if (input.gate === "warn") {
    return { uncoveredAcIds, status: "warned" };
  }

  return { uncoveredAcIds, status: "failed" };
}

export interface RiskCoverageAuditInput {
  /** Per-target risk/edge coverage entries (built by the Test Architect). */
  riskCoverageMatrix: RiskCoverageEntry[];
  gate: AcCoverageGate;
}

export interface RiskCoverageAuditResult {
  /** Target ids that are not risk/edge-satisfied, each with a human reason. */
  unsatisfied: { targetId: string; reason: string }[];
  status: "pass" | "warned" | "failed";
}

/**
 * Audit the risk/edge coverage matrix (M22) and derive a status from the gate.
 * Pure function — never throws. A target is unsatisfied when it has no covering
 * scenario, or when (being high risk) it has no negative/boundary scenario.
 */
export function auditRiskCoverage(input: RiskCoverageAuditInput): RiskCoverageAuditResult {
  if (input.gate === "off") {
    return { unsatisfied: [], status: "pass" };
  }
  const unsatisfied = input.riskCoverageMatrix
    .filter((entry) => !entry.satisfied)
    .map((entry) => ({ targetId: entry.targetId, reason: reasonFor(entry) }));
  if (unsatisfied.length === 0) {
    return { unsatisfied: [], status: "pass" };
  }
  return { unsatisfied, status: input.gate === "warn" ? "warned" : "failed" };
}

function reasonFor(entry: RiskCoverageEntry): string {
  const label = entry.targetKind === "derived" ? "derived requirement" : "acceptance criterion";
  if (entry.scenarioIndexes.length === 0) {
    return `${label} ${entry.targetId} has no covering scenario.`;
  }
  return `${label} ${entry.targetId} (${entry.risk} risk) is covered only by positive scenarios — add a negative or boundary scenario.`;
}
