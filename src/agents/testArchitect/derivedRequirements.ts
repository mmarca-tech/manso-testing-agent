import { z } from "zod";
import type {
  AcceptanceCriterion,
  ContextPack,
  ToolProvenance,
  Warning,
} from "../../domain/contextPack/schema.js";
import {
  DerivedRequirementSchema,
  type DerivedRequirement,
} from "../../domain/testDesignPack/schema.js";
import { generateStructured } from "../../integrations/llm/structured.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import { buildDerivedRequirementsPrompt } from "./prompts.js";

const TOOL_NAME = "llm:derived-requirements";
const OPERATION = "extract-derived-requirements";

/** LLM output: the contract emits ids, but we renumber DR-1.. for stability. */
const LlmDerivedArraySchema = z.array(DerivedRequirementSchema);

export interface DerivedRequirementsInput {
  context: ContextPack;
  acceptanceCriteria: AcceptanceCriterion[];
  llm: LlmTextClient;
  toolProvenance: ToolProvenance[];
  warnings: Warning[];
}

/**
 * M22a — mine the full context for requirements the literal acceptance criteria
 * do not state (error/boundary/security/data/state/...). **Resilient**: any LLM
 * or parse failure is recorded as a warning and yields `[]`, so the derived pass
 * never blocks the design. Ids are renumbered DR-1.. for stability.
 */
export async function extractDerivedRequirements(
  input: DerivedRequirementsInput,
): Promise<DerivedRequirement[]> {
  const { systemPrompt, userPrompt } = buildDerivedRequirementsPrompt({
    context: input.context,
    acceptanceCriteria: input.acceptanceCriteria,
  });

  const calledAt = new Date().toISOString();
  // M24: schema-constrained generation + one corrective retry before skipping.
  const result = await generateStructured({
    llm: input.llm,
    systemPrompt,
    userPrompt,
    operation: OPERATION,
    schema: LlmDerivedArraySchema,
    schemaName: "derived_requirements",
    envelopeKey: "derivedRequirements",
  });

  if (!result.ok) {
    input.toolProvenance.push({ method: OPERATION, toolName: TOOL_NAME, calledAt, success: false, message: `${result.stage}: ${result.error}` });
    input.warnings.push({
      section: "testDesign",
      toolName: TOOL_NAME,
      message: `Derived-requirement extraction failed after ${result.attempts} attempt(s) (${result.stage}; skipped): ${result.error}`,
    });
    return [];
  }

  input.toolProvenance.push({ method: OPERATION, toolName: TOOL_NAME, calledAt, success: true });
  return result.data.map((dr, index) => ({ ...dr, id: `DR-${index + 1}` }));
}
