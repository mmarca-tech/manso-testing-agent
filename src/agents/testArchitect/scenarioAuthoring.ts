import { z } from "zod";
import type { Warning } from "../../domain/contextPack/schema.js";
import {
  PlainEnglishScenarioSchema,
  type TestScenario,
} from "../../domain/testDesignPack/schema.js";
import { generateStructured } from "../../integrations/llm/structured.js";
import { CliError } from "../../shared/cli.js";
import {
  designGherkinScenarios,
  normalizeScenarioTags,
  sanitizeDrIds,
  type GherkinAuthoringInput,
} from "./gherkinAuthoring.js";
import { buildPlainEnglishDesignPrompt } from "./prompts.js";

export type OutputMode = "gherkin" | "plain-english";

/** Mode-agnostic design result; scenarios may be Gherkin, plain-English, or a mix. */
export interface ScenarioDesignResult {
  strategySummary: string;
  coverageGaps: string[];
  openQuestions: string[];
  acsCoveredByExisting: string[];
  scenarios: TestScenario[];
}

/** Dispatch design to the right author for the requested output mode. */
export async function designScenarios(
  mode: OutputMode,
  input: GherkinAuthoringInput,
): Promise<ScenarioDesignResult> {
  if (mode === "gherkin") {
    return designGherkinScenarios(input);
  }
  return designPlainEnglishScenarios(input);
}

const PlainEnglishOutputSchema = z
  .object({
    strategySummary: z.string(),
    coverageGaps: z.array(z.string()),
    openQuestions: z.array(z.string()),
    acsCoveredByExisting: z.array(z.string()).default([]),
    scenarios: z.array(PlainEnglishScenarioSchema.omit({ kind: true })),
  })
  .strict();

export async function designPlainEnglishScenarios(input: GherkinAuthoringInput): Promise<ScenarioDesignResult> {
  const prompt = buildPlainEnglishDesignPrompt({
    context: input.context,
    acceptanceCriteria: input.acceptanceCriteria,
    skillBody: input.skill.body,
    ...(input.derivedRequirements ? { derivedRequirements: input.derivedRequirements } : {}),
    ...(input.guidance ? { guidance: input.guidance } : {}),
  });
  const data = await runDesignPass(input, "design-plain-english-scenarios", "llm:plain-english-authoring", prompt, PlainEnglishOutputSchema);
  const known = new Set(input.acceptanceCriteria.map((ac) => ac.id));
  const knownDr = new Set((input.derivedRequirements ?? []).map((dr) => dr.id));
  const scenarios: TestScenario[] = data.scenarios.map((scenario) =>
    finalizeScenario({ kind: "plain-english" as const, ...scenario }, known, knownDr, input.warnings, "llm:plain-english-authoring"),
  );
  return projectResult(data, scenarios, known, input.warnings, "llm:plain-english-authoring");
}

interface ParsedDesign {
  strategySummary: string;
  coverageGaps: string[];
  openQuestions: string[];
  acsCoveredByExisting: string[];
}

/** Call the LLM schema-constrained (M24), validate, record provenance. */
async function runDesignPass<T extends z.ZodTypeAny>(
  input: GherkinAuthoringInput,
  operation: string,
  toolName: string,
  prompt: { systemPrompt: string; userPrompt: string },
  schema: T,
): Promise<z.infer<T>> {
  const calledAt = new Date().toISOString();
  const result = await generateStructured({
    llm: input.llm,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    operation,
    schema,
    schemaName: operation.replace(/-/g, "_"),
  });

  if (!result.ok) {
    input.toolProvenance.push({ method: operation, toolName, calledAt, success: false, message: `${result.stage}: ${result.error}` });
    throw new CliError(`Scenario design failed after ${result.attempts} attempt(s) (${result.stage}): ${result.error}`);
  }
  input.toolProvenance.push({ method: operation, toolName, calledAt, success: true });
  return result.data;
}

/** Sanitize unknown AC/DR ids and normalize tags on a scenario of any kind. */
export function finalizeScenario(
  scenario: TestScenario,
  known: Set<string>,
  knownDr: Set<string>,
  warnings: Warning[],
  toolName: string,
): TestScenario {
  const acIds = scenario.acIds.filter((id) => {
    if (!known.has(id)) {
      warnings.push({ section: "testDesign", toolName, message: `Scenario "${scenario.title}" referenced unknown AC id "${id}" — dropped.` });
      return false;
    }
    return true;
  });
  const drIds = sanitizeDrIds(scenario.drIds, knownDr, scenario.title, warnings, toolName);
  return {
    ...scenario,
    acIds,
    ...(drIds ? { drIds } : {}),
    tags: normalizeScenarioTags(scenario.tags, scenario.risk),
  } as TestScenario;
}

function projectResult(
  data: ParsedDesign,
  scenarios: TestScenario[],
  known: Set<string>,
  warnings: Warning[],
  toolName: string,
): ScenarioDesignResult {
  const acsCoveredByExisting = [...new Set(data.acsCoveredByExisting)].filter((id) => {
    if (!known.has(id)) {
      warnings.push({ section: "testDesign", toolName, message: `acsCoveredByExisting referenced unknown AC id "${id}" — dropped.` });
      return false;
    }
    return true;
  });
  return {
    strategySummary: data.strategySummary,
    coverageGaps: data.coverageGaps,
    openQuestions: data.openQuestions,
    acsCoveredByExisting,
    scenarios,
  };
}
