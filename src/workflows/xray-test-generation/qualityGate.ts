import type { XrayGeneratedTestCase, XrayTestGenerationPlan } from "../../domain/xrayTestGeneration/schema.js";

export function assertXrayPlanReadyForApplication(plan: XrayTestGenerationPlan): void {
  const failures: string[] = [];

  for (const [index, testCase] of plan.testCases.entries()) {
    const label = `${index + 1}. ${testCase.title}`;
    validateRequiredFields(label, testCase, failures);
  }

  collectDuplicateTitleFailures(plan.testCases, failures);
  collectDuplicateStepFailures(plan.testCases, failures);

  if (failures.length > 0) {
    throw new Error(`Xray test generation plan failed quality gate:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

function validateRequiredFields(label: string, testCase: XrayGeneratedTestCase, failures: string[]): void {
  if ((testCase.action === "keep" || testCase.action === "update") && !testCase.existingTestKey) {
    failures.push(`${label}: ${testCase.action} action requires existingTestKey.`);
  }

  if (testCase.action === "create" && testCase.existingTestKey) {
    failures.push(`${label}: create action must not include existingTestKey.`);
  }

  if ((testCase.action === "create" || testCase.action === "update") && testCase.steps.length === 0) {
    failures.push(`${label}: ${testCase.action} action requires at least one manual step.`);
  }

  if (testCase.sourceEvidence.length === 0) {
    failures.push(`${label}: sourceEvidence must include at least one concrete source.`);
  }
}

function collectDuplicateTitleFailures(testCases: XrayGeneratedTestCase[], failures: string[]): void {
  const seen = new Map<string, string>();

  for (const testCase of testCases) {
    const normalized = normalizeText(testCase.title);
    const previous = seen.get(normalized);
    if (previous) {
      failures.push(`Duplicate test title "${testCase.title}" also appears as "${previous}".`);
      continue;
    }

    seen.set(normalized, testCase.title);
  }
}

function collectDuplicateStepFailures(testCases: XrayGeneratedTestCase[], failures: string[]): void {
  const seen = new Map<string, string>();

  for (const testCase of testCases) {
    if (testCase.action === "keep" || testCase.steps.length === 0) {
      continue;
    }

    const signature = stepSignature(testCase);
    const previous = seen.get(signature);
    if (previous) {
      failures.push(`Near-duplicate manual step sequence in "${testCase.title}" also appears in "${previous}".`);
      continue;
    }

    seen.set(signature, testCase.title);
  }
}

function stepSignature(testCase: XrayGeneratedTestCase): string {
  return testCase.steps
    .map((step) => `${normalizeText(step.action)}=>${normalizeText(step.expectedResult)}`)
    .join("|");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
