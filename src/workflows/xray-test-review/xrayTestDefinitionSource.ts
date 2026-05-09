import type { ToolProvenance, Warning, XrayTestCase } from "../../domain/contextPack/schema.js";
export type { XrayTestDefinition, XrayTestStepDefinition } from "../../domain/xrayTestDefinitions/schema.js";
import type { XrayTestDefinition } from "../../domain/xrayTestDefinitions/schema.js";

export interface XrayTestDefinitionSource {
  getTestDefinitions(tests: XrayTestCase[]): Promise<XrayTestDefinition[]>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
