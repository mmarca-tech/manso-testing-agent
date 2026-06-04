import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type {
  AppliedXrayTestCase,
  AppliedXrayTestSet,
  XrayGeneratedTestCase,
  XrayGeneratedTestStep,
  XrayTestApplication,
} from "../../domain/xrayTestGeneration/schema.js";
import { firstPresent, firstString, isRecord, uniqueBy } from "../../shared/utils.js";
import type { ApplyXrayTestsInput, XrayTestSink } from "../../workflows/xray-test-generation/xrayTestSink.js";
import type { AtlassianRestClient } from "../atlassianRest/client.js";
import type { XrayCloudClient } from "./client.js";

export interface XrayCloudTestSinkOptions {
  xray: XrayCloudClient;
  jira: AtlassianRestClient;
  issueLinkTypeNameHint?: string;
  issueLinkDirection?: "test-to-ticket" | "ticket-to-test";
  onProgress?: (message: string) => void;
}

interface ResolvedJiraIssue {
  key: string;
  issueId: string;
  summary?: string;
  labels: string[];
  status?: string;
}

interface JiraIssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

interface JiraTransition {
  id: string;
  name: string;
  toName?: string;
}

export class XrayCloudTestSink implements XrayTestSink {
  private readonly xray: XrayCloudClient;
  private readonly jira: AtlassianRestClient;
  private readonly issueLinkTypeNameHint: string | undefined;
  private readonly issueLinkDirection: "test-to-ticket" | "ticket-to-test";
  private readonly onProgress: ((message: string) => void) | undefined;
  private cachedTestIssueLinkType: JiraIssueLinkType | undefined;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: XrayCloudTestSinkOptions) {
    this.xray = options.xray;
    this.jira = options.jira;
    this.issueLinkTypeNameHint = options.issueLinkTypeNameHint;
    this.issueLinkDirection = options.issueLinkDirection ?? "test-to-ticket";
    this.onProgress = options.onProgress;
  }

  async apply(input: ApplyXrayTestsInput): Promise<XrayTestApplication> {
    const appliedTests: AppliedXrayTestCase[] = [];

    this.log(`Applying ${input.plan.testCases.length} planned test case(s) to Jira/Xray.`);
    let index = 0;
    for (const testCase of input.plan.testCases) {
      index += 1;
      this.log(`Applying test case ${index}/${input.plan.testCases.length}: ${testCase.action} - ${testCase.existingTestKey ?? testCase.title}`);
      const applied = await this.applyTestCase(input, testCase);
      await this.linkAppliedTestToTicket(input.ticketKey, applied);
      this.log(`Applied test case ${index}/${input.plan.testCases.length}: ${applied.status}${applied.key ? ` (${applied.key})` : ""}.`);
      appliedTests.push(applied);
    }

    const testsForSet = uniqueBy(
      appliedTests.filter((test): test is AppliedXrayTestCase & { issueId: string } => test.status !== "deprecated" && Boolean(test.issueId)),
      (test) => test.issueId,
    );
    this.log(`Creating generated Test Set with ${testsForSet.length} resolved test issue id(s).`);
    const testSet = await this.createTestSet(input, testsForSet);
    this.log(`Test Set phase complete: ${testSet.status}${testSet.key ? ` (${testSet.key})` : ""}.`);

    return {
      status: "applied",
      tests: appliedTests,
      testSet,
    };
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }

  private async applyTestCase(input: ApplyXrayTestsInput, testCase: XrayGeneratedTestCase): Promise<AppliedXrayTestCase> {
    if (testCase.action === "create") {
      return this.createTest(input, testCase);
    }

    if (!testCase.existingTestKey) {
      const message = `Planner returned ${testCase.action} for "${testCase.title}" without existingTestKey.`;
      this.addWarning("xrayTests", "xray:apply-test", message);
      return {
        action: testCase.action,
        status: "skipped",
        requestedTitle: testCase.title,
        warnings: [message],
      };
    }

    const existing = await this.resolveJiraIssue(testCase.existingTestKey);
    if (testCase.action === "keep") {
      return {
        action: "keep",
        status: "kept",
        requestedTitle: testCase.title,
        existingTestKey: testCase.existingTestKey,
        key: existing.key,
        issueId: existing.issueId,
        warnings: [],
      };
    }

    if (testCase.action === "deprecate") {
      return this.deprecateTest(existing, input, testCase);
    }

    return this.updateTest(existing, input, testCase);
  }

  private async createTest(input: ApplyXrayTestsInput, testCase: XrayGeneratedTestCase): Promise<AppliedXrayTestCase> {
    if (testCase.steps.length === 0) {
      const message = `Skipping new test "${testCase.title}" because it has no manual steps.`;
      this.addWarning("xrayTests", "xray:createTest", message);
      return {
        action: "create",
        status: "skipped",
        requestedTitle: testCase.title,
        warnings: [message],
      };
    }

    const response = await this.callXray("createTest", "xray:createTest", () =>
      this.xray.graphql(CREATE_TEST_MUTATION, {
        testType: { name: "Manual" },
        steps: testCase.steps.map(toXrayStep),
        jira: {
          fields: {
            project: { key: input.projectKey },
            summary: testCase.title,
            labels: buildLabels(input.ticketKey),
            description: testCaseDescriptionText(input, testCase),
          },
        },
      }),
    );
    const createdTest = firstPresent(response, ["data.createTest.test"]);
    const key = extractIssueKey(createdTest);
    const issueId = firstString(createdTest, ["issueId"]);
    const xrayWarnings = stringArray(firstPresent(response, ["data.createTest.warnings"]));

    xrayWarnings.forEach((message) => this.addWarning("xrayTests", "xray:createTest", message));

    return {
      action: "create",
      status: "created",
      requestedTitle: testCase.title,
      ...(key ? { key } : {}),
      ...(issueId ? { issueId } : {}),
      warnings: xrayWarnings,
    };
  }

  private async deprecateTest(
    existing: ResolvedJiraIssue,
    input: ApplyXrayTestsInput,
    testCase: XrayGeneratedTestCase,
  ): Promise<AppliedXrayTestCase> {
    const warnings: string[] = [];
    const labels = uniqueBy([...existing.labels, "deprecated", "deprecated-by-context-workflow"], (label) => label.toLowerCase());

    await this.callJira("markJiraTestIssueDeprecated", "jira-rest:update-issue", () =>
      this.jira.putJson("jira", `/rest/api/3/issue/${encodeURIComponent(existing.key)}`, {
        fields: {
          summary: deprecatedSummary(existing.summary ?? testCase.title),
          labels,
          description: jiraDescription(input, testCase),
        },
      }),
    );

    if (normalizeStatusName(existing.status ?? "") !== "deprecated") {
      try {
        const transitioned = await this.transitionIssueToDeprecated(existing.key);
        if (!transitioned) {
          const message = `No available Jira transition to a Deprecated status was found for ${existing.key}. The issue was still marked with deprecated labels and description.`;
          warnings.push(message);
          this.addWarning("xrayTests", "jira-rest:transition-issue", message);
        }
      } catch (error) {
        const message = `Could not transition ${existing.key} to Deprecated: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        this.addWarning("xrayTests", "jira-rest:transition-issue", message);
      }
    }

    return {
      action: "deprecate",
      status: "deprecated",
      requestedTitle: testCase.title,
      existingTestKey: existing.key,
      key: existing.key,
      issueId: existing.issueId,
      warnings,
    };
  }

  private async updateTest(
    existing: ResolvedJiraIssue,
    input: ApplyXrayTestsInput,
    testCase: XrayGeneratedTestCase,
  ): Promise<AppliedXrayTestCase> {
    const warnings: string[] = [];

    await this.callJira("updateJiraTestIssue", "jira-rest:update-issue", () =>
      this.jira.putJson("jira", `/rest/api/3/issue/${encodeURIComponent(existing.key)}`, {
        fields: {
          summary: testCase.title,
          description: jiraDescription(input, testCase),
        },
      }),
    );
    await this.callXray("updateTestType", "xray:updateTestType", () =>
      this.xray.graphql(UPDATE_TEST_TYPE_MUTATION, {
        issueId: existing.issueId,
        testType: { name: "Manual" },
      }),
    );

    if (testCase.steps.length === 0) {
      const message = `Updated Jira fields for ${existing.key}, but skipped Xray step replacement because planner returned no steps.`;
      this.addWarning("xrayTests", "xray:updateTest", message);
      warnings.push(message);
    } else {
      await this.callXray("removeAllTestSteps", "xray:removeAllTestSteps", () =>
        this.xray.graphql(REMOVE_ALL_TEST_STEPS_MUTATION, { issueId: existing.issueId }),
      );

      for (const step of testCase.steps) {
        await this.callXray("addTestStep", "xray:addTestStep", () =>
          this.xray.graphql(ADD_TEST_STEP_MUTATION, {
            issueId: existing.issueId,
            step: toXrayStep(step),
          }),
        );
      }
    }

    return {
      action: "update",
      status: "updated",
      requestedTitle: testCase.title,
      existingTestKey: existing.key,
      key: existing.key,
      issueId: existing.issueId,
      warnings,
    };
  }

  private async createTestSet(
    input: ApplyXrayTestsInput,
    tests: Array<AppliedXrayTestCase & { issueId: string }>,
  ): Promise<AppliedXrayTestSet> {
    const title = `${input.ticketKey} Generated Test Set - ${input.ticketTitle}`;
    if (tests.length === 0) {
      const message = "Skipping Test Set creation because no Xray tests were created, updated, or resolved.";
      this.addWarning("xrayTestSet", "xray:createTestSet", message);
      return {
        status: "skipped",
        title,
        includedTestKeys: [],
        includedTestIssueIds: [],
        warnings: [message],
      };
    }

    const response = await this.callXray("createTestSet", "xray:createTestSet", () =>
      this.xray.graphql(CREATE_TEST_SET_MUTATION, {
        testIssueIds: tests.map((test) => test.issueId),
        jira: {
          fields: {
            project: { key: input.projectKey },
            summary: title,
            labels: buildLabels(input.ticketKey),
            description: `Generated Test Set for ${input.ticketKey}: ${input.ticketTitle}`,
          },
        },
      }),
    );
    const createdTestSet = firstPresent(response, ["data.createTestSet.testSet"]);
    const key = extractIssueKey(createdTestSet);
    const issueId = firstString(createdTestSet, ["issueId"]);
    const xrayWarnings = stringArray(firstPresent(response, ["data.createTestSet.warnings"]));

    xrayWarnings.forEach((message) => this.addWarning("xrayTestSet", "xray:createTestSet", message));

    return {
      status: "created",
      title,
      ...(key ? { key } : {}),
      ...(issueId ? { issueId } : {}),
      includedTestKeys: tests.map((test) => test.key).filter((key): key is string => Boolean(key)),
      includedTestIssueIds: tests.map((test) => test.issueId),
      warnings: xrayWarnings,
    };
  }

  private async resolveJiraIssue(issueKey: string): Promise<ResolvedJiraIssue> {
    const response = await this.callJira("resolveJiraIssue", "jira-rest:issue", () =>
      this.jira.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, { fields: "summary,labels,status" }),
    );
    const issueId = firstString(response, ["id"]);
    const key = firstString(response, ["key"]) ?? issueKey;
    const summary = firstString(response, ["fields.summary", "summary"]);
    const labels = stringArray(firstPresent(response, ["fields.labels", "labels"]));
    const status = firstString(response, ["fields.status.name", "status.name", "status"]);

    if (!issueId) {
      throw new Error(`Jira issue ${issueKey} did not include numeric issue id.`);
    }

    return {
      key,
      issueId,
      labels,
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
    };
  }

  private async linkAppliedTestToTicket(ticketKey: string, applied: AppliedXrayTestCase): Promise<void> {
    if (!applied.key || applied.status === "skipped" || applied.status === "deprecated") {
      return;
    }

    try {
      await this.linkTestToTicket(ticketKey, applied.key);
      applied.linkedToTicket = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDuplicateIssueLinkError(message)) {
        applied.linkedToTicket = true;
        applied.warnings.push(`Jira link already exists between ${applied.key} and ${ticketKey}.`);
        this.log(`Jira link already exists between ${applied.key} and ${ticketKey}.`);
        return;
      }

      applied.linkedToTicket = false;
      applied.warnings.push(`Could not link ${applied.key} to ${ticketKey}: ${message}`);
      this.addWarning("xrayTests", "jira-rest:issue-link", `Could not link ${applied.key} to ${ticketKey}: ${message}`);
    }
  }

  private async linkTestToTicket(ticketKey: string, testKey: string): Promise<void> {
    const linkType = await this.getTestsIssueLinkType();
    const issueLink =
      this.issueLinkDirection === "test-to-ticket"
        ? {
            type: { id: linkType.id },
            outwardIssue: { key: testKey },
            inwardIssue: { key: ticketKey },
          }
        : {
            type: { id: linkType.id },
            outwardIssue: { key: ticketKey },
            inwardIssue: { key: testKey },
          };

    await this.callJira("linkTestToTicket", "jira-rest:issue-link", () => this.jira.postJson("jira", "/rest/api/3/issueLink", issueLink));
  }

  private async getTestsIssueLinkType(): Promise<JiraIssueLinkType> {
    if (this.cachedTestIssueLinkType) {
      return this.cachedTestIssueLinkType;
    }

    const response = await this.callJira("getIssueLinkTypes", "jira-rest:issue-link-types", () =>
      this.jira.getJson("jira", "/rest/api/3/issueLinkType"),
    );
    const linkTypes = normalizeIssueLinkTypes(firstPresent(response, ["issueLinkTypes"]));
    const selected = linkTypes.find((linkType) => isTestsIssueLinkType(linkType, this.issueLinkTypeNameHint));

    if (!selected) {
      throw new Error("Jira does not expose a tests issue link type or an equivalent tests/is tested by link.");
    }

    this.cachedTestIssueLinkType = selected;
    this.log(`Resolved Jira tests issue link type ${selected.name} (${selected.id}) using outward "${selected.outward}" and inward "${selected.inward}".`);
    return selected;
  }

  private async transitionIssueToDeprecated(issueKey: string): Promise<boolean> {
    const response = await this.callJira("getJiraIssueTransitions", "jira-rest:issue-transitions", () =>
      this.jira.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`),
    );
    const transition = normalizeTransitions(firstPresent(response, ["transitions"])).find(isDeprecatedTransition);
    if (!transition) {
      return false;
    }

    await this.callJira("transitionJiraTestIssueToDeprecated", "jira-rest:transition-issue", () =>
      this.jira.postJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        transition: { id: transition.id },
      }),
    );
    return true;
  }

  private async callXray(method: string, toolName: string, action: () => Promise<unknown>): Promise<unknown> {
    return this.call(method, toolName, action);
  }

  private async callJira(method: string, toolName: string, action: () => Promise<unknown>): Promise<unknown> {
    return this.call(method, toolName, action);
  }

  private async call(method: string, toolName: string, action: () => Promise<unknown>): Promise<unknown> {
    const calledAt = new Date().toISOString();

    try {
      this.log(`Calling ${toolName} for ${method}.`);
      const result = await action();
      this.provenance.push({ method, toolName, calledAt, success: true });
      this.log(`Completed ${toolName} for ${method}.`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method, toolName, calledAt, success: false, message });
      this.log(`Failed ${toolName} for ${method}: ${message}`);
      throw error;
    }
  }

  private addWarning(section: string, toolName: string, message: string): void {
    this.warnings.push({ section, toolName, message });
  }

  private log(message: string): void {
    this.onProgress?.(message);
  }
}

function toXrayStep(step: XrayGeneratedTestStep): Record<string, string> {
  return {
    action: step.action,
    ...(step.data ? { data: step.data } : {}),
    result: step.expectedResult,
  };
}

function jiraDescription(input: ApplyXrayTestsInput, testCase: XrayGeneratedTestCase): unknown {
  return simpleAdf(testCaseDescriptionText(input, testCase));
}

function testCaseDescriptionText(input: ApplyXrayTestsInput, testCase: XrayGeneratedTestCase): string {
  const lines = [
    `Generated by the Jira ticket context workflow for ${input.ticketKey}.`,
    "",
    `Objective: ${testCase.objective}`,
    `Priority: ${testCase.priority}`,
    testCase.coverageAreas.length > 0 ? `Coverage: ${testCase.coverageAreas.join(", ")}` : undefined,
    `Risk covered: ${testCase.riskCovered}`,
    `Readiness: ${testCase.readiness}`,
    "",
    "Source evidence:",
    ...(testCase.sourceEvidence.length > 0
      ? testCase.sourceEvidence.map((evidence) => `- ${evidence.source}: ${evidence.reference} - ${evidence.summary}`)
      : ["- None"]),
    "",
    "Open questions:",
    ...(testCase.openQuestions.length > 0 ? testCase.openQuestions.map((item) => `- ${item}`) : ["- None"]),
    "",
    "Preconditions:",
    ...(testCase.preconditions.length > 0 ? testCase.preconditions.map((item) => `- ${item}`) : ["- None"]),
    "",
    `Rationale: ${testCase.rationale}`,
  ].filter((line): line is string => line !== undefined);

  return lines.join("\n");
}

function simpleAdf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function buildLabels(ticketKey: string): string[] {
  return ["generated-by-context-workflow", ticketKey.toLowerCase()];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function deprecatedSummary(summary: string): string {
  const trimmed = summary.trim();
  if (/^\[?deprecated\]?[:\s-]/i.test(trimmed) || /^deprecated$/i.test(trimmed)) {
    return trimmed;
  }

  return `[DEPRECATED] ${trimmed}`;
}

function extractIssueKey(testOrTestSet: unknown): string | undefined {
  const jira = firstPresent(testOrTestSet, ["jira"]);

  if (isRecord(jira)) {
    return firstString(jira, ["key", "fields.key"]);
  }

  if (typeof jira === "string" && jira.trim().length > 0) {
    try {
      const parsed = JSON.parse(jira) as unknown;
      return isRecord(parsed) ? firstString(parsed, ["key", "fields.key"]) : undefined;
    } catch {
      return undefined;
    }
  }

  return firstString(testOrTestSet, ["jira.key", "jira.fields.key"]);
}

function isDuplicateIssueLinkError(message: string): boolean {
  return /already exists|duplicate|link.*exist/i.test(message);
}

function normalizeIssueLinkTypes(value: unknown): JiraIssueLinkType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): JiraIssueLinkType | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }

      const id = firstString(item, ["id"]);
      const name = firstString(item, ["name"]);
      const inward = firstString(item, ["inward"]);
      const outward = firstString(item, ["outward"]);

      if (!id || !name) {
        return undefined;
      }

      return {
        id,
        name,
        inward: inward ?? "",
        outward: outward ?? "",
      };
    })
    .filter((item): item is JiraIssueLinkType => Boolean(item));
}

function normalizeTransitions(value: unknown): JiraTransition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): JiraTransition | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }

      const id = firstString(item, ["id"]);
      const name = firstString(item, ["name"]);
      if (!id || !name) {
        return undefined;
      }

      const toName = firstString(item, ["to.name", "to.statusCategory.name"]);
      return {
        id,
        name,
        ...(toName ? { toName } : {}),
      };
    })
    .filter((item): item is JiraTransition => Boolean(item));
}

function isTestsIssueLinkType(linkType: JiraIssueLinkType, configuredName: string | undefined): boolean {
  const expectedName = configuredName?.trim().toLowerCase();
  if (expectedName && linkType.name.toLowerCase() === expectedName) {
    return true;
  }

  return (
    linkType.name.toLowerCase() === "tests" ||
    (linkType.outward.toLowerCase() === "tests" && linkType.inward.toLowerCase() === "is tested by")
  );
}

function isDeprecatedTransition(transition: JiraTransition): boolean {
  return normalizeStatusName(transition.name) === "deprecated" || normalizeStatusName(transition.toName ?? "") === "deprecated";
}

function normalizeStatusName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const CREATE_TEST_MUTATION = `mutation CreateManualTest($testType: UpdateTestTypeInput!, $steps: [CreateStepInput], $jira: JSON!) {
  createTest(testType: $testType, steps: $steps, jira: $jira) {
    test {
      issueId
      jira(fields: ["key", "summary"])
    }
    warnings
  }
}`;

const UPDATE_TEST_TYPE_MUTATION = `mutation UpdateTestType($issueId: String!, $testType: UpdateTestTypeInput!) {
  updateTestType(issueId: $issueId, testType: $testType) {
    issueId
  }
}`;

const REMOVE_ALL_TEST_STEPS_MUTATION = `mutation RemoveAllTestSteps($issueId: String!) {
  removeAllTestSteps(issueId: $issueId)
}`;

const ADD_TEST_STEP_MUTATION = `mutation AddTestStep($issueId: String!, $step: CreateStepInput!) {
  addTestStep(issueId: $issueId, step: $step) {
    id
    action
    data
    result
  }
}`;

const CREATE_TEST_SET_MUTATION = `mutation CreateGeneratedTestSet($testIssueIds: [String], $jira: JSON!) {
  createTestSet(testIssueIds: $testIssueIds, jira: $jira) {
    testSet {
      issueId
      jira(fields: ["key", "summary"])
    }
    warnings
  }
}`;
