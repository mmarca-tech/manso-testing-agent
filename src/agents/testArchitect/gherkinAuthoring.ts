import { z } from "zod";
import type { ContextPack, AcceptanceCriterion, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { StepLibrary } from "../../context/stepLibrary.js";
import type { RepoGuidanceFile } from "../../context/repoGuidance.js";
import {
  GherkinScenarioSchema,
  type DerivedRequirement,
  type GherkinScenario,
} from "../../domain/testDesignPack/schema.js";
import { generateStructured } from "../../integrations/llm/structured.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import type { Skill } from "../../skillLoader/types.js";
import { CliError } from "../../shared/cli.js";
import { buildGherkinDesignPrompt } from "./prompts.js";

const TOOL_NAME = "llm:gherkin-authoring";
const OPERATION = "design-gherkin-scenarios";

/** Inner scenario shape coming back from the LLM: same as the validated schema
 *  but without the `kind` literal — we add `kind: "gherkin"` after validation. */
const LlmGherkinScenarioSchema = GherkinScenarioSchema.omit({ kind: true });

const GherkinDesignOutputSchema = z
  .object({
    strategySummary: z.string(),
    coverageGaps: z.array(z.string()),
    openQuestions: z.array(z.string()),
    acsCoveredByExisting: z.array(z.string()).default([]),
    scenarios: z.array(LlmGherkinScenarioSchema),
  })
  .strict();

export interface GherkinDesignResult {
  strategySummary: string;
  coverageGaps: string[];
  openQuestions: string[];
  /** AC ids the author judged already covered by an existing repo scenario. */
  acsCoveredByExisting: string[];
  scenarios: GherkinScenario[];
}

export interface GherkinAuthoringInput {
  context: ContextPack;
  acceptanceCriteria: AcceptanceCriterion[];
  llm: LlmTextClient;
  skill: Skill;
  toolProvenance: ToolProvenance[];
  warnings: Warning[];
  /** Existing repo step vocabulary, injected into the prompt to encourage reuse. */
  stepLibrary?: StepLibrary;
  /** Derived requirements (M22) the author should also cover, via `drIds`. */
  derivedRequirements?: DerivedRequirement[];
  /** Repo guidance incl. learned rules from `.agents/guidelines/` (M25). */
  guidance?: RepoGuidanceFile[];
}

/**
 * Run the Gherkin scenario design LLM pass. Returns the strategy summary,
 * coverage gaps, open questions, and an array of validated Gherkin scenarios.
 * Throws {@link CliError} when the LLM output does not satisfy the contract.
 */
export async function designGherkinScenarios(input: GherkinAuthoringInput): Promise<GherkinDesignResult> {
  const { systemPrompt, userPrompt } = buildGherkinDesignPrompt({
    context: input.context,
    acceptanceCriteria: input.acceptanceCriteria,
    skillBody: input.skill.body,
    ...(input.stepLibrary ? { stepLibrary: input.stepLibrary } : {}),
    ...(input.derivedRequirements ? { derivedRequirements: input.derivedRequirements } : {}),
    ...(input.guidance ? { guidance: input.guidance } : {}),
  });

  const calledAt = new Date().toISOString();
  // M24: schema-constrained generation + one corrective retry before failing.
  const result = await generateStructured({
    llm: input.llm,
    systemPrompt,
    userPrompt,
    operation: OPERATION,
    schema: GherkinDesignOutputSchema,
    schemaName: "gherkin_design",
  });

  if (!result.ok) {
    input.toolProvenance.push({
      method: OPERATION,
      toolName: TOOL_NAME,
      calledAt,
      success: false,
      message: `${result.stage}: ${result.error}`,
    });
    throw new CliError(
      `Gherkin scenario design failed after ${result.attempts} attempt(s) (${result.stage}): ${result.error}`,
    );
  }

  input.toolProvenance.push({
    method: OPERATION,
    toolName: TOOL_NAME,
    calledAt,
    success: true,
  });

  const knownAcIds = new Set(input.acceptanceCriteria.map((ac) => ac.id));
  const knownDrIds = new Set((input.derivedRequirements ?? []).map((dr) => dr.id));
  const scenarios: GherkinScenario[] = result.data.scenarios.map((scenario) => {
    const sanitizedAcIds = scenario.acIds.filter((id) => {
      if (!knownAcIds.has(id)) {
        input.warnings.push({
          section: "testDesign",
          toolName: TOOL_NAME,
          message: `Scenario "${scenario.title}" referenced unknown AC id "${id}" — dropped.`,
        });
        return false;
      }
      return true;
    });
    const sanitizedDrIds = sanitizeDrIds(scenario.drIds, knownDrIds, scenario.title, input.warnings, TOOL_NAME);
    return {
      kind: "gherkin",
      ...scenario,
      acIds: sanitizedAcIds,
      ...(sanitizedDrIds ? { drIds: sanitizedDrIds } : {}),
      tags: normalizeScenarioTags(scenario.tags, scenario.risk),
    };
  });

  const acsCoveredByExisting = [...new Set(result.data.acsCoveredByExisting)].filter((id) => {
    if (!knownAcIds.has(id)) {
      input.warnings.push({
        section: "testDesign",
        toolName: TOOL_NAME,
        message: `acsCoveredByExisting referenced unknown AC id "${id}" — dropped.`,
      });
      return false;
    }
    return true;
  });

  return {
    strategySummary: result.data.strategySummary,
    coverageGaps: result.data.coverageGaps,
    openQuestions: result.data.openQuestions,
    acsCoveredByExisting,
    scenarios,
  };
}

/**
 * Drop derived-requirement ids the author referenced that are not real (M22).
 * Returns `undefined` when there is nothing to carry, so the optional `drIds`
 * field stays omitted rather than set to `[]`.
 */
export function sanitizeDrIds(
  drIds: string[] | undefined,
  known: Set<string>,
  scenarioTitle: string,
  warnings: Warning[],
  toolName: string,
): string[] | undefined {
  if (!drIds || drIds.length === 0) return undefined;
  const kept = drIds.filter((id) => {
    if (!known.has(id)) {
      warnings.push({
        section: "testDesign",
        toolName,
        message: `Scenario "${scenarioTitle}" referenced unknown derived-requirement id "${id}" — dropped.`,
      });
      return false;
    }
    return true;
  });
  return kept.length > 0 ? kept : undefined;
}

const RISK_LEVEL_TAG = /^@(high|medium|low)$/i;
const AC_ID_TAG = /^@ac-\d+$/i;
const STORY_TAG = /^@story-/i;
const SMOKE_TAG = /^@smoke$/i;
const POLARITY_TAG = /^@(positive|negative)$/i;

/**
 * Normalize scenario tags to Manso's convention:
 *   - Keep functional / area tags (e.g. `@login`, `@checkout`).
 *   - Drop AC-id tags (`@AC-3`), risk-level tags (`@high`), `@story-*`, and
 *     polarity tags (`@positive` / `@negative`) — traceability and priority
 *     live in the structured `acIds` / `risk` fields, not in tags.
 *   - Derive `@smoke` purely from risk: present iff the scenario is high risk.
 * This keeps the rendered `.feature` tags stable regardless of how the LLM
 * decided to tag, and guarantees `@smoke` ⟺ high-priority.
 */
export function normalizeScenarioTags(rawTags: string[], risk: "high" | "medium" | "low"): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const tag = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    if (
      RISK_LEVEL_TAG.test(tag) ||
      AC_ID_TAG.test(tag) ||
      STORY_TAG.test(tag) ||
      SMOKE_TAG.test(tag) ||
      POLARITY_TAG.test(tag)
    ) {
      continue;
    }
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      cleaned.push(tag);
    }
  }
  if (risk === "high") {
    cleaned.push("@smoke");
  }
  return cleaned;
}
