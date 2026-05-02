import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { XrayTestApplication, XrayTestGenerationPlan } from "../../domain/xrayTestGeneration/schema.js";

export interface ApplyXrayTestsInput {
  ticketKey: string;
  ticketTitle: string;
  projectKey: string;
  plan: XrayTestGenerationPlan;
}

export interface XrayTestSink {
  apply(input: ApplyXrayTestsInput): Promise<XrayTestApplication>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
