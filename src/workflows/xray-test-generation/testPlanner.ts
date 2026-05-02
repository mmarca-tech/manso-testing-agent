import type { ContextPack, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { ConfluenceImpactPack } from "../../domain/confluenceImpact/schema.js";
import type { PrChangesPack } from "../../domain/prChanges/schema.js";
import type { XrayTestReviewPack } from "../../domain/xrayTestReview/schema.js";
import type { XrayTestGenerationPlan } from "../../domain/xrayTestGeneration/schema.js";

export interface XrayTestPlanningInput {
  context: ContextPack;
  xrayTestReview?: XrayTestReviewPack;
  prChanges?: PrChangesPack;
  confluenceImpact?: ConfluenceImpactPack;
}

export interface XrayTestPlanner {
  readonly provider: string;
  readonly model: string;
  plan(input: XrayTestPlanningInput): Promise<XrayTestGenerationPlan>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
