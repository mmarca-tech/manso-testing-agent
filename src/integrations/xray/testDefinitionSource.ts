import type { ToolProvenance, Warning, XrayTestCase } from "../../domain/contextPack/schema.js";
import { firstPresent, firstString, isRecord, toStringArray, unknownToText, uniqueBy } from "../../shared/utils.js";
import type {
  XrayTestDefinition,
  XrayTestDefinitionSource,
  XrayTestStepDefinition,
} from "../../workflows/xray-test-review/xrayTestDefinitionSource.js";
import type { XrayCloudClient } from "./client.js";

export class XrayCloudTestDefinitionSource implements XrayTestDefinitionSource {
  private readonly xray: XrayCloudClient;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(xray: XrayCloudClient) {
    this.xray = xray;
  }

  async getTestDefinitions(tests: XrayTestCase[]): Promise<XrayTestDefinition[]> {
    const uniqueTests = uniqueBy(tests, (test) => test.key);
    if (uniqueTests.length === 0) {
      return [];
    }

    const calledAt = new Date().toISOString();
    try {
      const response = await this.xray.graphql(GET_EXPANDED_TESTS_QUERY, {
        jql: `issuekey in (${uniqueTests.map((test) => `"${escapeJqlString(test.key)}"`).join(", ")})`,
        limit: Math.max(uniqueTests.length, 1),
        start: 0,
      });
      this.provenance.push({ method: "getXrayTestDefinitions", toolName: "xray:getExpandedTests", calledAt, success: true });
      return mapExpandedTests(firstPresent(response, ["data.getExpandedTests.results"]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "getXrayTestDefinitions", toolName: "xray:getExpandedTests", calledAt, success: false, message });
      throw error;
    }
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }
}

function mapExpandedTests(value: unknown): XrayTestDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): XrayTestDefinition | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }

      const jira = readJiraFields(item);
      const key = firstString(jira, ["key"]);
      const title = firstString(jira, ["summary"]);
      if (!key || !title) {
        return undefined;
      }

      const issueId = firstString(item, ["issueId"]);
      const status = firstString(jira, ["status.name", "status"]);
      const testType = firstString(item, ["testType.name"]);
      const description = unknownToText(firstPresent(jira, ["description"]));
      const labels = toStringArray(firstPresent(jira, ["labels"]));
      const gherkin = firstString(item, ["gherkin"]);
      const steps = mapSteps(firstPresent(item, ["steps"]));

      return {
        key,
        title,
        ...(issueId ? { issueId } : {}),
        ...(status ? { status } : {}),
        ...(testType ? { testType } : {}),
        ...(description ? { description } : {}),
        labels,
        ...(gherkin ? { gherkin } : {}),
        steps,
      };
    })
    .filter((item): item is XrayTestDefinition => Boolean(item));
}

function mapSteps(value: unknown): XrayTestStepDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((step): XrayTestStepDefinition | undefined => {
      if (!isRecord(step)) {
        return undefined;
      }

      const action = firstString(step, ["action"]);
      if (!action) {
        return undefined;
      }

      const data = firstString(step, ["data"]);
      const expectedResult = firstString(step, ["result", "expectedResult"]);
      return {
        action,
        ...(data ? { data } : {}),
        ...(expectedResult ? { expectedResult } : {}),
      };
    })
    .filter((step): step is XrayTestStepDefinition => Boolean(step));
}

function readJiraFields(item: unknown): unknown {
  const jira = firstPresent(item, ["jira"]);
  if (typeof jira === "string" && jira.trim().length > 0) {
    try {
      return JSON.parse(jira) as unknown;
    } catch {
      return {};
    }
  }

  return jira;
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const GET_EXPANDED_TESTS_QUERY = `query GetExpandedTests($jql: String!, $limit: Int!, $start: Int!) {
  getExpandedTests(jql: $jql, limit: $limit, start: $start) {
    results {
      issueId
      testType {
        name
      }
      gherkin
      steps {
        action
        data
        result
      }
      jira(fields: ["key", "summary", "description", "labels", "status"])
    }
  }
}`;
