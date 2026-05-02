import type { ContextPack, ConfluencePage, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { ConfluenceImpact } from "../../domain/confluenceImpact/schema.js";

export interface ConfluenceImpactSummarizer {
  readonly provider: string;
  readonly model: string;
  summarize(input: ConfluenceImpactInput): Promise<ConfluenceImpact>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}

export interface ConfluenceImpactInput {
  context: Pick<ContextPack, "ticket" | "description" | "xrayTestCases" | "development">;
  page: ConfluencePage;
}
