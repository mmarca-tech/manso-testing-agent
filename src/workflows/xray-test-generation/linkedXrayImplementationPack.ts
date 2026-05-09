import type { ContextPack, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import {
  XrayTestGenerationPackSchema,
  type XrayGeneratedTestCase,
  type XrayGeneratedTestStep,
  type XrayTestGenerationPack,
} from "../../domain/xrayTestGeneration/schema.js";
import type { XrayTestDefinition } from "../xray-test-review/xrayTestDefinitionSource.js";

export interface BuildLinkedXrayImplementationPackInput {
  context: ContextPack;
  definitions: XrayTestDefinition[];
  sourceContextPath: string;
  definitionProvenance?: ToolProvenance[];
  definitionWarnings?: Warning[];
  generatedAt?: string;
}

export function buildLinkedXrayImplementationPack(input: BuildLinkedXrayImplementationPackInput): XrayTestGenerationPack {
  if (input.context.xrayTestCases.length === 0) {
    throw new Error(`No linked Xray tests were found for ${input.context.ticket.key}. Link Xray tests first.`);
  }

  const definitionsByKey = new Map(input.definitions.map((definition) => [definition.key.toLowerCase(), definition]));
  const adapterWarnings: Warning[] = [];
  const testCases = input.context.xrayTestCases.map((linkedTest) =>
    buildTestCase(linkedTest, definitionsByKey.get(linkedTest.key.toLowerCase()), input.context, adapterWarnings),
  );
  const coverageGaps = testCases.flatMap((testCase) =>
    testCase.openQuestions.map((question) => `${testCase.existingTestKey}: ${question}`),
  );
  const includedIssueIds = testCases
    .map((testCase) => definitionsByKey.get(testCase.existingTestKey?.toLowerCase() ?? "")?.issueId)
    .filter((issueId): issueId is string => Boolean(issueId));

  const pack: XrayTestGenerationPack = {
    schemaVersion: "1.0.0",
    ticket: {
      key: input.context.ticket.key,
      title: input.context.ticket.title,
      ...(input.context.ticket.url ? { url: input.context.ticket.url } : {}),
    },
    plan: {
      strategySummary:
        "Implementation-only scope built from existing Xray tests already linked to the Jira ticket. The Xray generation workflow was intentionally skipped and no new Xray tests were created.",
      coverageGaps,
      testCases,
    },
    application: {
      status: "dry-run",
      tests: testCases.map((testCase) => ({
        action: "update",
        status: "kept",
        requestedTitle: testCase.title,
        existingTestKey: testCase.existingTestKey,
        key: testCase.existingTestKey,
        linkedToTicket: true,
        warnings: testCase.openQuestions,
      })),
      testSet: {
        status: "skipped",
        title: `Existing linked Xray tests for ${input.context.ticket.key}`,
        includedTestKeys: testCases.map((testCase) => testCase.existingTestKey).filter((key): key is string => Boolean(key)),
        includedTestIssueIds: includedIssueIds,
        warnings: ["No Xray Test Set was created because this workflow only implements existing linked Xray tests."],
      },
    },
    provenance: {
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      sourceContextPath: input.sourceContextPath,
      llm: {
        provider: "none",
        model: "existing-linked-xray-tests",
      },
      tools: [
        ...(input.definitionProvenance ?? []),
        {
          method: "buildLinkedXrayImplementationPack",
          toolName: "manso-testing-agent:linked-xray-implementation",
          calledAt: input.generatedAt ?? new Date().toISOString(),
          success: true,
        },
      ],
    },
    warnings: [...input.context.warnings, ...(input.definitionWarnings ?? []), ...adapterWarnings],
  };

  return XrayTestGenerationPackSchema.parse(pack);
}

function buildTestCase(
  linkedTest: ContextPack["xrayTestCases"][number],
  definition: XrayTestDefinition | undefined,
  context: ContextPack,
  adapterWarnings: Warning[],
): XrayGeneratedTestCase {
  const title = cleanText(definition?.title) || cleanText(linkedTest.title) || linkedTest.key;
  const status = cleanText(definition?.status) || cleanText(linkedTest.status);
  const labels = definition?.labels?.length ? definition.labels : linkedTest.labels;
  const steps = toManualSteps(definition);
  const missingExpectedResults = (definition?.steps ?? []).some((step) => !cleanText(step.expectedResult));
  const openQuestions: string[] = [];

  if (!definition) {
    openQuestions.push("Xray Cloud did not return an expanded definition for this linked test.");
  }

  if (steps.length === 0) {
    openQuestions.push("No manual steps or Gherkin scenario were available from Xray.");
  }

  if (missingExpectedResults) {
    openQuestions.push("One or more Xray manual steps did not specify an expected result.");
  }

  for (const question of openQuestions) {
    adapterWarnings.push({
      section: "linked-xray-tests",
      toolName: "manso-testing-agent:linked-xray-implementation",
      message: `${linkedTest.key}: ${question}`,
    });
  }

  const preconditions = compact([
    definition?.description ? `Existing Xray description: ${truncate(definition.description, 1200)}` : "",
    labels?.length ? `Xray labels: ${labels.join(", ")}` : "",
    status ? `Xray status: ${status}` : "",
  ]);

  return {
    action: "update",
    existingTestKey: linkedTest.key,
    title,
    objective: `Automate the existing linked Xray test ${linkedTest.key}: ${title}.`,
    priority: "medium",
    coverageAreas: compact([
      "Existing linked Xray test",
      definition?.testType ? `Xray test type: ${definition.testType}` : "",
      ...(labels ?? []).map((label) => `Label: ${label}`),
    ]),
    preconditions,
    steps,
    sourceEvidence: [
      {
        source: "jira",
        reference: context.ticket.key,
        summary: `Source Jira ticket ${context.ticket.key}: ${context.ticket.title}`,
      },
      {
        source: "existing-xray-test",
        reference: linkedTest.key,
        summary: `Existing linked Xray test ${linkedTest.key}${status ? ` (${status})` : ""}; ${steps.length} step(s) prepared for automation.`,
      },
    ],
    riskCovered: `Behavior already specified by linked Xray test ${linkedTest.key}.`,
    readiness: openQuestions.length === 0 ? "ready" : "needs-clarification",
    openQuestions,
    rationale: "This case was copied from an existing Xray test linked to the Jira ticket. No new Xray test case was generated.",
  };
}

function toManualSteps(definition: XrayTestDefinition | undefined): XrayGeneratedTestStep[] {
  const manualSteps = (definition?.steps ?? [])
    .filter((step) => cleanText(step.action).length > 0)
    .map((step) => ({
      action: cleanText(step.action),
      ...(cleanText(step.data).length > 0 ? { data: cleanText(step.data) } : {}),
      expectedResult: cleanText(step.expectedResult) || "Expected result was not specified in Xray.",
    }));

  if (manualSteps.length > 0) {
    return manualSteps;
  }

  const gherkin = cleanText(definition?.gherkin);
  if (gherkin.length > 0) {
    return [
      {
        action: "Automate the Xray Gherkin scenario.",
        data: gherkin,
        expectedResult: "The scenario passes according to the Gherkin expectations.",
      },
    ];
  }

  return [];
}

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  const text = cleanText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function compact(values: string[]): string[] {
  return values.map((value) => cleanText(value)).filter((value) => value.length > 0);
}
