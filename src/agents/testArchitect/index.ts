import { auditCoverage, auditRiskCoverage, type AcCoverageGate } from "../coverageAuditor/index.js";
import { buildEvidenceGraph } from "../../context/evidenceGraph.js";
import type { StepLibrary } from "../../context/stepLibrary.js";
import type {
  AcceptanceCriterion,
  ContextPack,
  ToolProvenance,
  Warning,
} from "../../domain/contextPack/schema.js";
import {
  TEST_DESIGN_SCHEMA_VERSION,
  TestDesignPackSchema,
  type AcCoverageEntry,
  type DerivedRequirement,
  type RiskCoverageEntry,
  type RiskLevel,
  type RiskRankingEntry,
  type TestDesignPack,
  type TestScenario,
} from "../../domain/testDesignPack/schema.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import type { RepoGuidanceFile } from "../../context/repoGuidance.js";
import { extractDerivedRequirements } from "./derivedRequirements.js";
import { critiqueDesign } from "./critique.js";
import { loadSkills } from "../../skillLoader/loader.js";
import type { Skill } from "../../skillLoader/types.js";
import { CliError } from "../../shared/cli.js";
import { extractAcceptanceCriteria } from "./acExtraction.js";
import { designScenarios, type OutputMode } from "./scenarioAuthoring.js";

export interface TestArchitectInput {
  context: ContextPack;
  llm: LlmTextClient;
  /** Repo root, for loading repo-level skill overrides. */
  repoRoot?: string;
  /** Output mode: gherkin (Cucumber, default) or plain-english (Manual). */
  outputMode?: OutputMode;
  /** Optional preloaded skills (mainly for tests). */
  skills?: Skill[];
  /** Coverage gate strictness. Defaults to "required". */
  acCoverageGate?: AcCoverageGate;
  /** Existing repo step vocabulary, injected into the Gherkin prompt for reuse. */
  stepLibrary?: StepLibrary;
  /** M22 — extract derived requirements beyond the ACs. Defaults to off. */
  deriveRequirements?: boolean;
  /** M22 — run the adversarial "what did we miss?" critique. Defaults to off. */
  adversarialCritique?: boolean;
  /** M22 — risk/edge coverage gate strictness. Defaults to "off". */
  riskCoverageGate?: AcCoverageGate;
  /** Repo guidance incl. learned rules from `.agents/guidelines/` (M25). */
  guidance?: RepoGuidanceFile[];
}

export interface TestArchitectOutput {
  /** ContextPack enriched with the extracted acceptance criteria. */
  contextWithCriteria: ContextPack;
  /** Validated TestDesignPack ready to write. */
  testDesign: TestDesignPack;
}

/**
 * Test Architect sub-agent (M6): two-pass LLM design.
 *   Pass 1 — extract acceptance criteria from the ContextPack.
 *   Pass 2 — design Gherkin scenarios covering those criteria.
 *
 * Emits a validated {@link TestDesignPack}. The Coverage Auditor (M7) is the
 * downstream gate that enforces 100% AC coverage.
 */
export async function runTestArchitect(input: TestArchitectInput): Promise<TestArchitectOutput> {
  const skills = input.skills ?? (await loadSkills({
    phase: "design",
    ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
  }));

  const mode: OutputMode = input.outputMode ?? "gherkin";
  const acSkill = skills.find((skill) => skill.name === "acceptance-criteria-extraction");
  if (!acSkill) {
    throw new CliError(
      "Packaged skill 'acceptance-criteria-extraction' is missing. Reinstall Manso or check the skills directory.",
    );
  }
  const designSkill = selectDesignSkill(mode, skills);

  const toolProvenance: ToolProvenance[] = [];
  const warnings: Warning[] = [...input.context.warnings];

  const acceptanceCriteria = await extractAcceptanceCriteria({
    context: input.context,
    llm: input.llm,
    skill: acSkill,
    toolProvenance,
    warnings,
  });

  const contextWithCriteria: ContextPack = {
    ...input.context,
    acceptanceCriteria,
  };
  // Rebuild the evidence graph now that requirements exist, so persisted
  // context.json carries requirement nodes + their evidence edges.
  contextWithCriteria.evidenceGraph = buildEvidenceGraph(contextWithCriteria);

  // M22a — mine the full context for requirements the literal ACs don't state.
  // Resilient: returns [] on failure. Fed into design as extra coverage targets.
  const deriveRequirements = input.deriveRequirements ?? false;
  const derivedRequirements: DerivedRequirement[] = deriveRequirements
    ? await extractDerivedRequirements({ context: contextWithCriteria, acceptanceCriteria, llm: input.llm, toolProvenance, warnings })
    : [];

  const design = await designScenarios(mode, {
    context: contextWithCriteria,
    acceptanceCriteria,
    llm: input.llm,
    skill: designSkill,
    toolProvenance,
    warnings,
    ...(input.stepLibrary ? { stepLibrary: input.stepLibrary } : {}),
    ...(derivedRequirements.length > 0 ? { derivedRequirements } : {}),
    ...(input.guidance ? { guidance: input.guidance } : {}),
  });

  const scenarios: TestScenario[] = [...design.scenarios];
  const coverageGaps: string[] = [...design.coverageGaps];
  const openQuestions: string[] = [...design.openQuestions];
  const coveredByExisting = new Set<string>(design.acsCoveredByExisting);

  const gate: AcCoverageGate = input.acCoverageGate ?? "required";
  let audit = auditCoverage({
    testDesign: { acCoverageMatrix: buildAcCoverageMatrix(acceptanceCriteria, scenarios) },
    gate,
    coveredExternally: [...coveredByExisting],
  });

  // Bounded retry: when the gate is required (or warn) and ACs were missed,
  // re-invoke the Gherkin designer scoped to the gaps only. Capped at one
  // retry to bound LLM cost.
  if (audit.uncoveredAcIds.length > 0 && gate !== "off") {
    const uncoveredAcs = acceptanceCriteria.filter((ac) => audit.uncoveredAcIds.includes(ac.id));
    const retry = await designScenarios(mode, {
      context: contextWithCriteria,
      acceptanceCriteria: uncoveredAcs,
      llm: input.llm,
      skill: designSkill,
      toolProvenance,
      warnings,
      ...(input.stepLibrary ? { stepLibrary: input.stepLibrary } : {}),
      ...(derivedRequirements.length > 0 ? { derivedRequirements } : {}),
      ...(input.guidance ? { guidance: input.guidance } : {}),
    });
    scenarios.push(...retry.scenarios);
    coverageGaps.push(...retry.coverageGaps);
    openQuestions.push(...retry.openQuestions);
    for (const id of retry.acsCoveredByExisting) {
      coveredByExisting.add(id);
    }
    audit = auditCoverage({
      testDesign: { acCoverageMatrix: buildAcCoverageMatrix(acceptanceCriteria, scenarios) },
      gate,
      coveredExternally: [...coveredByExisting],
    });
  }

  if (audit.status === "failed") {
    throw new CliError(
      `AC coverage gate (required) failed. Uncovered acceptance criteria: ${audit.uncoveredAcIds.join(", ")}`,
    );
  }
  if (audit.status === "warned") {
    const message = `Uncovered acceptance criteria: ${audit.uncoveredAcIds.join(", ")}`;
    openQuestions.push(message);
    warnings.push({ section: "acCoverage", toolName: "coverage-auditor", message });
  }

  // M22c — one bounded adversarial pass: fold in genuinely-missing scenarios,
  // record the rest as gaps / open questions. Resilient (empty on failure).
  if ((input.adversarialCritique ?? false)) {
    const critique = await critiqueDesign({
      mode,
      context: contextWithCriteria,
      acceptanceCriteria,
      derivedRequirements,
      skillBody: designSkill.body,
      draftedScenarios: scenarios,
      llm: input.llm,
      toolProvenance,
      warnings,
      ...(input.guidance ? { guidance: input.guidance } : {}),
    });
    scenarios.push(...critique.scenarios);
    coverageGaps.push(...critique.coverageGaps);
    openQuestions.push(...critique.openQuestions);
  }

  const acCoverageMatrix = buildAcCoverageMatrix(acceptanceCriteria, scenarios);
  const riskRanking = buildRiskRanking(scenarios);

  // M22b — risk/edge coverage: every high-risk AC/DR needs a negative-or-
  // boundary scenario, and every DR needs to be covered at all.
  const riskGate: AcCoverageGate = input.riskCoverageGate ?? "off";
  const riskCoverageMatrix = buildRiskCoverage(acceptanceCriteria, derivedRequirements, scenarios);
  const riskAudit = auditRiskCoverage({ riskCoverageMatrix, gate: riskGate });
  if (riskAudit.status === "failed") {
    throw new CliError(
      `Risk/edge coverage gate (required) failed:\n${riskAudit.unsatisfied.map((u) => `  - ${u.reason}`).join("\n")}`,
    );
  }
  if (riskAudit.status === "warned") {
    for (const u of riskAudit.unsatisfied) {
      openQuestions.push(u.reason);
      warnings.push({ section: "riskCoverage", toolName: "coverage-auditor", message: u.reason });
    }
  }
  const attachRiskCoverage = deriveRequirements || riskGate !== "off";

  const testDesign: TestDesignPack = {
    schemaVersion: TEST_DESIGN_SCHEMA_VERSION,
    ticket: {
      key: input.context.ticket.key,
      title: input.context.ticket.title,
    },
    outputMode: mode,
    acceptanceCriteria,
    strategySummary: design.strategySummary,
    coverageGaps,
    scenarios,
    acCoverageMatrix,
    riskRanking,
    ...(derivedRequirements.length > 0 ? { derivedRequirements } : {}),
    ...(attachRiskCoverage ? { riskCoverageMatrix } : {}),
    openQuestions,
    ...(coveredByExisting.size > 0 ? { acsCoveredByExisting: [...coveredByExisting] } : {}),
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey: input.context.ticket.key,
      llm: { provider: input.llm.provider, model: input.llm.model },
      tools: toolProvenance,
    },
    warnings,
  };

  const validated = TestDesignPackSchema.parse(testDesign);
  return { contextWithCriteria, testDesign: validated };
}

/** Re-exposed for callers that want the gate type without reaching into the
 *  Coverage Auditor module directly. */
export type { AcCoverageGate, AcceptanceCriterion };

/** Pick the authoring skill for the mode. */
function selectDesignSkill(mode: OutputMode, skills: Skill[]): Skill {
  if (mode === "gherkin") {
    const gherkin = skills.find((s) => s.name === "gherkin-authoring");
    if (!gherkin) throw missingSkill("gherkin-authoring");
    return gherkin;
  }
  const plain = skills.find((s) => s.name === "plain-english-test-authoring");
  if (!plain) throw missingSkill("plain-english-test-authoring");
  return plain;
}

function missingSkill(name: string): CliError {
  return new CliError(`Packaged skill '${name}' is missing. Reinstall Manso or check the skills directory.`);
}

function buildAcCoverageMatrix(
  acceptanceCriteria: { id: string }[],
  scenarios: TestScenario[],
): AcCoverageEntry[] {
  return acceptanceCriteria.map((ac) => ({
    acId: ac.id,
    scenarioIndexes: scenarios
      .map((scenario, index) => (scenario.acIds.includes(ac.id) ? index : -1))
      .filter((index) => index >= 0),
  }));
}

function buildRiskRanking(scenarios: TestScenario[]): RiskRankingEntry[] {
  const buckets: Record<RiskLevel, number[]> = { high: [], medium: [], low: [] };
  scenarios.forEach((scenario, index) => {
    buckets[scenario.risk].push(index);
  });
  return (["high", "medium", "low"] as const)
    .map((level) => ({ level, scenarioIndexes: buckets[level] }))
    .filter((entry) => entry.scenarioIndexes.length > 0);
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** A scenario exercises a non-happy-path behaviour (M22 risk/edge gate). */
function isNegativeOrBoundary(scenario: TestScenario): boolean {
  return (scenario.polarity ?? "positive") !== "positive";
}

/**
 * M22b — build the per-target risk/edge coverage matrix. AC targets are
 * included only when they have coverage (their *existence* is the AC gate's
 * job); a covered AC whose covering scenarios include a high-risk one needs a
 * negative/boundary scenario. Derived requirements are always included — an
 * uncovered DR is itself a gap, and a high-risk DR needs negative/boundary
 * coverage.
 */
function buildRiskCoverage(
  acceptanceCriteria: AcceptanceCriterion[],
  derivedRequirements: DerivedRequirement[],
  scenarios: TestScenario[],
): RiskCoverageEntry[] {
  const entries: RiskCoverageEntry[] = [];

  for (const ac of acceptanceCriteria) {
    const covering = indexesWhere(scenarios, (s) => s.acIds.includes(ac.id));
    if (covering.length === 0) continue; // uncovered ACs belong to the AC gate
    const negOrBoundary = covering.filter((i) => isNegativeOrBoundary(scenarios[i]!));
    const risk = maxRisk(covering.map((i) => scenarios[i]!.risk));
    entries.push({
      targetId: ac.id,
      targetKind: "ac",
      risk,
      scenarioIndexes: covering,
      negativeOrBoundaryScenarioIndexes: negOrBoundary,
      satisfied: risk !== "high" || negOrBoundary.length > 0,
    });
  }

  for (const dr of derivedRequirements) {
    const covering = indexesWhere(scenarios, (s) => (s.drIds ?? []).includes(dr.id));
    const negOrBoundary = covering.filter((i) => isNegativeOrBoundary(scenarios[i]!));
    entries.push({
      targetId: dr.id,
      targetKind: "derived",
      risk: dr.risk,
      scenarioIndexes: covering,
      negativeOrBoundaryScenarioIndexes: negOrBoundary,
      satisfied: covering.length > 0 && (dr.risk !== "high" || negOrBoundary.length > 0),
    });
  }

  return entries;
}

function indexesWhere(scenarios: TestScenario[], predicate: (s: TestScenario) => boolean): number[] {
  const out: number[] = [];
  scenarios.forEach((s, i) => {
    if (predicate(s)) out.push(i);
  });
  return out;
}

function maxRisk(levels: RiskLevel[]): RiskLevel {
  let best: RiskLevel = "low";
  for (const level of levels) {
    if (RISK_ORDER[level] > RISK_ORDER[best]) best = level;
  }
  return best;
}
