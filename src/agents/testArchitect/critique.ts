import { z } from "zod";
import type {
  AcceptanceCriterion,
  ContextPack,
  ToolProvenance,
  Warning,
} from "../../domain/contextPack/schema.js";
import {
  GherkinScenarioSchema,
  PlainEnglishScenarioSchema,
  type DerivedRequirement,
  type TestScenario,
} from "../../domain/testDesignPack/schema.js";
import { generateStructured } from "../../integrations/llm/structured.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import type { RepoGuidanceFile } from "../../context/repoGuidance.js";
import { normalizeTestTitle } from "../../shared/utils.js";
import { buildCritiquePrompt, SCENARIO_CONTRACTS } from "./prompts.js";
import { finalizeScenario, type OutputMode } from "./scenarioAuthoring.js";

const TOOL_NAME = "llm:design-critique";
const OPERATION = "critique-design";

function critiqueSchema(mode: OutputMode) {
  const scenario = mode === "gherkin"
    ? GherkinScenarioSchema.omit({ kind: true })
    : PlainEnglishScenarioSchema.omit({ kind: true });
  return z
    .object({
      gaps: z.array(z.string()).default([]),
      openQuestions: z.array(z.string()).default([]),
      scenarios: z.array(scenario).default([]),
    })
    .strict();
}

export interface CritiqueInput {
  mode: OutputMode;
  context: ContextPack;
  acceptanceCriteria: AcceptanceCriterion[];
  derivedRequirements: DerivedRequirement[];
  skillBody: string;
  /** Scenarios already drafted (used to forbid duplicates by title). */
  draftedScenarios: TestScenario[];
  /** Repo guidance incl. learned rules from `.agents/guidelines/` (M25). */
  guidance?: RepoGuidanceFile[];
  llm: LlmTextClient;
  toolProvenance: ToolProvenance[];
  warnings: Warning[];
}

export interface CritiqueResult {
  scenarios: TestScenario[];
  coverageGaps: string[];
  openQuestions: string[];
}

const EMPTY: CritiqueResult = { scenarios: [], coverageGaps: [], openQuestions: [] };

/**
 * M22c — a single bounded "what did this design miss?" pass. Authors only the
 * genuinely missing scenarios (no duplicates), and records the rest as gaps /
 * open questions. **Resilient**: any LLM/parse failure is warned and yields an
 * empty result, so the critique never blocks the design.
 */
export async function critiqueDesign(input: CritiqueInput): Promise<CritiqueResult> {
  const { systemPrompt, userPrompt } = buildCritiquePrompt({
    context: input.context,
    acceptanceCriteria: input.acceptanceCriteria,
    skillBody: input.skillBody,
    derivedRequirements: input.derivedRequirements,
    scenarioContract: SCENARIO_CONTRACTS[input.mode],
    draftedTitles: input.draftedScenarios.map((s) => s.title),
    ...(input.guidance ? { guidance: input.guidance } : {}),
  });

  const calledAt = new Date().toISOString();
  // M24: schema-constrained generation + one corrective retry before skipping.
  const result = await generateStructured({
    llm: input.llm,
    systemPrompt,
    userPrompt,
    operation: OPERATION,
    schema: critiqueSchema(input.mode),
    schemaName: "design_critique",
  });

  if (!result.ok) {
    input.toolProvenance.push({ method: OPERATION, toolName: TOOL_NAME, calledAt, success: false, message: `${result.stage}: ${result.error}` });
    input.warnings.push({
      section: "testDesign",
      toolName: TOOL_NAME,
      message: `Design critique failed after ${result.attempts} attempt(s) (${result.stage}; skipped): ${result.error}`,
    });
    return EMPTY;
  }

  input.toolProvenance.push({ method: OPERATION, toolName: TOOL_NAME, calledAt, success: true });

  const knownAc = new Set(input.acceptanceCriteria.map((ac) => ac.id));
  const knownDr = new Set(input.derivedRequirements.map((dr) => dr.id));
  const existingTitles = new Set(input.draftedScenarios.map((s) => normalizeTestTitle(s.title)));

  const kind = input.mode === "gherkin" ? ("gherkin" as const) : ("plain-english" as const);
  const scenarios: TestScenario[] = result.data.scenarios
    .filter((s) => {
      const norm = normalizeTestTitle(s.title);
      if (existingTitles.has(norm)) {
        input.warnings.push({ section: "testDesign", toolName: TOOL_NAME, message: `Critique proposed a duplicate scenario "${s.title}" — dropped.` });
        return false;
      }
      existingTitles.add(norm); // also dedup among the critique's own proposals
      return true;
    })
    // The discriminated union needs the concrete kind; `s` already matches the
    // per-mode shape, so finalizeScenario only sanitizes ids + tags.
    .map((s) => finalizeScenario({ kind, ...s } as TestScenario, knownAc, knownDr, input.warnings, TOOL_NAME));

  return { scenarios, coverageGaps: result.data.gaps, openQuestions: result.data.openQuestions };
}
