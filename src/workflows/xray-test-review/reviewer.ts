import type { ContextPack, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { XrayTestReviewAnalysis } from "../../domain/xrayTestReview/schema.js";
import type { XrayTestDefinition } from "./xrayTestDefinitionSource.js";

export interface XrayTestReviewInput {
  context: ContextPack;
  testDefinitions: XrayTestDefinition[];
}

export interface XrayTestReviewer {
  readonly provider: string;
  readonly model: string;
  review(input: XrayTestReviewInput): Promise<XrayTestReviewAnalysis>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
