import { z } from "zod";
import {
  AcceptanceCriterionSchema,
  type AcceptanceCriterion,
  type ContextPack,
  type ToolProvenance,
  type Warning,
} from "../../domain/contextPack/schema.js";
import { generateStructured } from "../../integrations/llm/structured.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import type { Skill } from "../../skillLoader/types.js";
import { CliError } from "../../shared/cli.js";
import { buildAcExtractionPrompt } from "./prompts.js";

const TOOL_NAME = "llm:acceptance-criteria-extraction";
const OPERATION = "extract-acceptance-criteria";

const AcArraySchema = z.array(AcceptanceCriterionSchema);

export interface AcExtractionInput {
  context: ContextPack;
  llm: LlmTextClient;
  skill: Skill;
  toolProvenance: ToolProvenance[];
  warnings: Warning[];
}

/**
 * Run the AC extraction LLM pass. Returns the parsed acceptance criteria and
 * appends a provenance entry. Throws {@link CliError} when the LLM output is
 * not parseable as the contracted JSON array.
 */
export async function extractAcceptanceCriteria(input: AcExtractionInput): Promise<AcceptanceCriterion[]> {
  const { systemPrompt, userPrompt } = buildAcExtractionPrompt({
    context: input.context,
    skillBody: input.skill.body,
  });

  const calledAt = new Date().toISOString();
  // M24: schema-constrained generation + one corrective retry before failing.
  const result = await generateStructured({
    llm: input.llm,
    systemPrompt,
    userPrompt,
    operation: OPERATION,
    schema: AcArraySchema,
    schemaName: "acceptance_criteria",
    envelopeKey: "acceptanceCriteria",
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
      `Acceptance criteria extraction failed after ${result.attempts} attempt(s) (${result.stage}): ${result.error}`,
    );
  }

  if (result.data.length === 0) {
    input.warnings.push({
      section: "acceptanceCriteria",
      toolName: TOOL_NAME,
      message: "LLM returned no acceptance criteria for this ticket.",
    });
  }

  input.toolProvenance.push({
    method: OPERATION,
    toolName: TOOL_NAME,
    calledAt,
    success: true,
  });

  return result.data;
}
