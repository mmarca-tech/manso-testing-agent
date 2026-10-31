import type { TestDesignPack } from "../domain/testDesignPack/schema.js";

/**
 * Deterministic quality scoring for a {@link TestDesignPack} (M14 eval harness).
 *
 * Each check is a binary or proportional signal derived purely from the pack —
 * no LLM — so a golden run is reproducible and a regression is attributable to
 * a specific dimension (coverage, traceability, tag hygiene, structure).
 */

export interface EvalCheck {
  name: string;
  /** 0..1 score for this dimension. */
  score: number;
  weight: number;
  detail: string;
}

export interface EvalScore {
  /** Weighted total, 0..100. */
  score: number;
  checks: EvalCheck[];
  /** Dimensions scoring below 1.0, for quick triage. */
  failures: string[];
}

const BANNED_TAG = /^@(AC-\d+|high|medium|low|positive|negative|smoke|story-.*)$/i;

export function scoreTestDesign(pack: TestDesignPack): EvalScore {
  const checks: EvalCheck[] = [
    acCoverage(pack),
    scenarioTraceability(pack),
    tagHygiene(pack),
    scenarioStructure(pack),
    titleUniqueness(pack),
    hasStrategy(pack),
  ];

  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0) || 1;
  const weighted = checks.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;

  return {
    score: Math.round(weighted * 100),
    checks,
    failures: checks.filter((c) => c.score < 1).map((c) => c.name),
  };
}

function acCoverage(pack: TestDesignPack): EvalCheck {
  const acIds = pack.acceptanceCriteria.map((ac) => ac.id);
  const coveredByMatrix = new Set(
    pack.acCoverageMatrix.filter((entry) => entry.scenarioIndexes.length > 0).map((entry) => entry.acId),
  );
  const coveredByExisting = new Set(pack.acsCoveredByExisting ?? []);
  if (acIds.length === 0) {
    return { name: "ac-coverage", score: 1, weight: 3, detail: "No ACs to cover." };
  }
  const covered = acIds.filter((id) => coveredByMatrix.has(id) || coveredByExisting.has(id));
  const ratio = covered.length / acIds.length;
  return {
    name: "ac-coverage",
    score: ratio,
    weight: 3,
    detail: `${covered.length}/${acIds.length} ACs covered`,
  };
}

function scenarioTraceability(pack: TestDesignPack): EvalCheck {
  if (pack.scenarios.length === 0) {
    return { name: "traceability", score: 0, weight: 2, detail: "No scenarios." };
  }
  const traced = pack.scenarios.filter((s) => s.acIds.length > 0).length;
  return {
    name: "traceability",
    score: traced / pack.scenarios.length,
    weight: 2,
    detail: `${traced}/${pack.scenarios.length} scenarios trace to an AC`,
  };
}

function tagHygiene(pack: TestDesignPack): EvalCheck {
  let offending = 0;
  let total = 0;
  for (const scenario of pack.scenarios) {
    for (const tag of scenario.tags) {
      total += 1;
      // @smoke is legitimately derived for high-risk; allow it.
      if (BANNED_TAG.test(tag) && tag.toLowerCase() !== "@smoke") {
        offending += 1;
      }
    }
  }
  const score = total === 0 ? 1 : 1 - offending / total;
  return {
    name: "tag-hygiene",
    score,
    weight: 1,
    detail: offending === 0 ? "No banned tags" : `${offending} banned tag(s) (AC/risk/polarity/story)`,
  };
}

function scenarioStructure(pack: TestDesignPack): EvalCheck {
  if (pack.scenarios.length === 0) {
    return { name: "structure", score: 0, weight: 2, detail: "No scenarios." };
  }
  const wellFormed = pack.scenarios.filter((s) => {
    if (s.kind === "gherkin") {
      const keywords = s.steps.map((step) => step.keyword);
      return s.steps.length >= 2 && keywords.includes("When") && keywords.includes("Then");
    }
    // Plain-English: well-formed when every step has an action and an expected
    // result (the schema guarantees non-empty), with at least one step.
    return s.steps.length >= 1;
  }).length;
  return {
    name: "structure",
    score: wellFormed / pack.scenarios.length,
    weight: 2,
    detail: `${wellFormed}/${pack.scenarios.length} scenarios well-formed`,
  };
}

function titleUniqueness(pack: TestDesignPack): EvalCheck {
  if (pack.scenarios.length === 0) {
    return { name: "title-uniqueness", score: 1, weight: 1, detail: "No scenarios." };
  }
  const titles = pack.scenarios.map((s) => s.title.trim().toLowerCase());
  const unique = new Set(titles).size;
  return {
    name: "title-uniqueness",
    score: unique / titles.length,
    weight: 1,
    detail: `${unique}/${titles.length} unique scenario titles`,
  };
}

function hasStrategy(pack: TestDesignPack): EvalCheck {
  const ok = pack.strategySummary.trim().length > 0;
  return { name: "strategy-summary", score: ok ? 1 : 0, weight: 1, detail: ok ? "Present" : "Missing" };
}
