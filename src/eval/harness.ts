import type { TestDesignPack } from "../domain/testDesignPack/schema.js";
import { matchAgainstReference, type ReferenceMatchResult, type ReferenceSet } from "./referenceMatch.js";
import { scoreTestDesign, type EvalScore } from "./scorer.js";

/**
 * Eval harness (M14, extended by M23).
 *
 * Scores a set of golden cases (each a TestDesignPack produced from a known
 * ticket) and applies a release gate: the suite passes only when the mean score
 * clears the threshold and no case scores below the per-case floor. A case can
 * additionally carry a **human-written reference** (M23) — the QA's test list
 * for the same ticket — in which case the design's **recall** against it is
 * measured and gated too. Also supports variance analysis — scoring repeated
 * runs of the same case to measure consistency.
 */

export interface EvalCase {
  name: string;
  pack: TestDesignPack;
  /** Optional human-written reference test list (M23 outcome dimension). */
  reference?: ReferenceSet;
}

export interface EvalCaseResult {
  name: string;
  ticketKey: string;
  result: EvalScore;
  /** Present when the case carries a reference. */
  referenceMatch?: ReferenceMatchResult;
}

export interface EvalReport {
  cases: EvalCaseResult[];
  meanScore: number;
  minScore: number;
  /** Release gate threshold applied to the mean. */
  gateThreshold: number;
  /** Per-case floor; any case below this fails the gate regardless of mean. */
  caseFloor: number;
  /** Reference-recall gate (percent) applied to cases that carry a reference. */
  minRecall: number;
  passed: boolean;
  /** Names of cases that fell below the floor. */
  belowFloor: string[];
  /** Names of reference-carrying cases whose recall fell below the recall gate. */
  belowRecall: string[];
}

export interface RunEvalInput {
  cases: EvalCase[];
  /** Mean-score gate, 0..100. Default 80. */
  gateThreshold?: number;
  /** Per-case floor, 0..100. Default 60. */
  caseFloor?: number;
  /** Reference-recall gate, 0..100 (only cases with a reference). Default 60. */
  minRecall?: number;
}

export function runEval(input: RunEvalInput): EvalReport {
  const gateThreshold = input.gateThreshold ?? 80;
  const caseFloor = input.caseFloor ?? 60;
  const minRecall = input.minRecall ?? 60;

  const cases: EvalCaseResult[] = input.cases.map((c) => {
    const referenceMatch = c.reference
      ? matchAgainstReference(c.pack.scenarios.map((s) => s.title), c.reference)
      : undefined;
    return {
      name: c.name,
      ticketKey: c.pack.ticket.key,
      result: scoreTestDesign(c.pack),
      ...(referenceMatch ? { referenceMatch } : {}),
    };
  });

  const scores = cases.map((c) => c.result.score);
  const meanScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const minScore = scores.length > 0 ? Math.min(...scores) : 0;
  const belowFloor = cases.filter((c) => c.result.score < caseFloor).map((c) => c.name);
  const belowRecall = cases
    .filter((c) => c.referenceMatch !== undefined && c.referenceMatch.recall * 100 < minRecall)
    .map((c) => c.name);
  const passed = scores.length > 0 && meanScore >= gateThreshold && belowFloor.length === 0 && belowRecall.length === 0;

  return { cases, meanScore, minScore, gateThreshold, caseFloor, minRecall, passed, belowFloor, belowRecall };
}

export interface VarianceReport {
  runs: number;
  scores: number[];
  mean: number;
  min: number;
  max: number;
  /** Population standard deviation of the scores. */
  stdDev: number;
  /** True when spread is within `maxStdDev` (default 5). */
  stable: boolean;
}

/** Score repeated runs of the same case and report score spread. */
export function analyzeVariance(packs: TestDesignPack[], maxStdDev = 5): VarianceReport {
  const scores = packs.map((pack) => scoreTestDesign(pack).score);
  const runs = scores.length;
  const mean = runs > 0 ? scores.reduce((a, b) => a + b, 0) / runs : 0;
  const variance = runs > 0 ? scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / runs : 0;
  const stdDev = Math.sqrt(variance);
  return {
    runs,
    scores,
    mean: Math.round(mean),
    min: runs > 0 ? Math.min(...scores) : 0,
    max: runs > 0 ? Math.max(...scores) : 0,
    stdDev: Math.round(stdDev * 100) / 100,
    stable: runs > 0 && stdDev <= maxStdDev,
  };
}

export function renderEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Eval report`, "");
  lines.push(
    `Gate: mean ≥ ${report.gateThreshold}, every case ≥ ${report.caseFloor}, reference recall ≥ ${report.minRecall}%`,
  );
  lines.push(`Result: ${report.passed ? "PASS ✅" : "FAIL ❌"} — mean ${report.meanScore}, min ${report.minScore}`, "");
  lines.push("| Case | Ticket | Score | Recall | Failing dimensions |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of report.cases) {
    const recall = c.referenceMatch
      ? `${Math.round(c.referenceMatch.recall * 100)}% (${c.referenceMatch.matched.length}/${
          c.referenceMatch.matched.length + c.referenceMatch.unmatchedReferences.length
        })`
      : "—";
    lines.push(`| ${c.name} | ${c.ticketKey} | ${c.result.score} | ${recall} | ${c.result.failures.join(", ") || "—"} |`);
  }
  if (report.belowFloor.length > 0) {
    lines.push("", `Below floor: ${report.belowFloor.join(", ")}`);
  }
  if (report.belowRecall.length > 0) {
    lines.push("", `Below recall gate: ${report.belowRecall.join(", ")}`);
  }
  // The actionable part: which human-written cases did each design miss?
  for (const c of report.cases) {
    if (!c.referenceMatch || c.referenceMatch.unmatchedReferences.length === 0) continue;
    lines.push("", `Missed reference cases — ${c.name}:`);
    for (const title of c.referenceMatch.unmatchedReferences) {
      lines.push(`  - ${title.length > 120 ? `${title.slice(0, 117)}...` : title}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
