import type { ToolProvenance, Warning, XrayTestCase } from "../../domain/contextPack/schema.js";

export interface XrayTestStepDefinition {
  action: string;
  data?: string;
  expectedResult?: string;
}

export interface XrayTestDefinition {
  key: string;
  title: string;
  issueId?: string;
  status?: string;
  testType?: string;
  description?: string;
  labels: string[];
  gherkin?: string;
  steps: XrayTestStepDefinition[];
}

export interface XrayTestDefinitionSource {
  getTestDefinitions(tests: XrayTestCase[]): Promise<XrayTestDefinition[]>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
