import type { XrayTestGenerationPack } from "../../domain/xrayTestGeneration/schema.js";
import type { XrayTestImplementationCommandResult } from "../../domain/xrayTestImplementation/schema.js";

export const DEFAULT_REPO_GUIDANCE_PATHS = [
  "architecture/test-architecture.md",
  "docs/testing/ai-test-generation.md",
  ".manso/testgen.md",
  ".manso/repo-conventions.json",
] as const;

export interface XrayTestImplementationGuidanceContent {
  path: string;
  content: string;
}

export interface BuildXrayTestImplementationPromptInput {
  generation: XrayTestGenerationPack;
  repoRoot: string;
  branch: string;
  targetBranch: string;
  guidanceFiles: XrayTestImplementationGuidanceContent[];
  sourceXrayTestGenerationPath: string;
  verifyCommand?: string;
}

export interface BuildXrayTestHealingPromptInput {
  issueKey: string;
  repoRoot: string;
  branch: string;
  targetBranch: string;
  originalPromptPath: string;
  attempt: number;
  maxAttempts: number;
  verification: XrayTestImplementationCommandResult;
  changedFiles: string[];
}

export function buildXrayTestImplementationPrompt(input: BuildXrayTestImplementationPromptInput): string {
  const actionableTestCases = input.generation.plan.testCases.filter((testCase) => testCase.action === "create" || testCase.action === "update");
  const readyTestCases = actionableTestCases.filter((testCase) => testCase.readiness === "ready");
  const needsClarification = actionableTestCases.filter((testCase) => testCase.readiness === "needs-clarification");

  const lines: string[] = [];
  lines.push(`# Implement Generated Xray Test Cases for ${input.generation.ticket.key}`, "");
  lines.push("You are editing the repository where this command is running. Implement automated tests for the generated Xray test cases using only the repository evidence and guidance included below.", "");
  lines.push("## Operating Rules", "");
  lines.push("- Treat this as a test implementation task, not a product feature implementation task.");
  lines.push("- Follow the repository guidance files exactly; they are the authority for test framework, locations, naming, data setup, fixtures, mocks, and validation commands.");
  lines.push("- Keep the change scoped to automated tests and directly necessary test support files.");
  lines.push("- Prefer implementing ready create/update Xray test cases. Do not duplicate existing coverage for keep cases unless the repo guidance explicitly asks for traceability scaffolding.");
  lines.push("- For needs-clarification cases, add only defensible coverage when the expected behavior and setup are clear from the repository. Otherwise leave a clear note in your final response.");
  lines.push("- Do not hardcode secrets, tenant-specific credentials, production URLs, or brittle timing assumptions.");
  lines.push("- Preserve existing style and avoid broad refactors.");
  lines.push("- Run the repository validation command when practical and report the result.");
  lines.push("- When finished, summarize changed files, implemented Xray cases, skipped cases, and validation results.", "");
  pushImplementationContract(lines);
  lines.push("## Repository", "");
  lines.push(`- Root: ${input.repoRoot}`);
  lines.push(`- Working branch: ${input.branch}`);
  lines.push(`- Pull request target branch: ${input.targetBranch}`);
  if (input.verifyCommand) {
    lines.push(`- Requested validation command: ${input.verifyCommand}`);
  }
  lines.push(`- Source Xray generation pack: ${input.sourceXrayTestGenerationPath}`, "");
  lines.push("## Xray Strategy", "", input.generation.plan.strategySummary, "");
  lines.push("Coverage gaps:");
  pushList(lines, input.generation.plan.coverageGaps);
  lines.push("", "## Implementation Scope", "");
  lines.push(`- Actionable create/update cases: ${actionableTestCases.length}`);
  lines.push(`- Ready actionable cases: ${readyTestCases.length}`);
  lines.push(`- Needs clarification actionable cases: ${needsClarification.length}`);
  lines.push(`- Keep-only existing cases provided for context: ${input.generation.plan.testCases.length - actionableTestCases.length}`, "");
  lines.push("## Generated Xray Test Cases", "");
  for (const testCase of input.generation.plan.testCases) {
    lines.push(`### ${testCase.title}`, "");
    lines.push(`- Action: ${testCase.action}`);
    if (testCase.existingTestKey) {
      lines.push(`- Existing Xray key: ${testCase.existingTestKey}`);
    }
    lines.push(`- Priority: ${testCase.priority}`);
    lines.push(`- Readiness: ${testCase.readiness}`);
    lines.push(`- Risk covered: ${testCase.riskCovered}`);
    lines.push(`- Objective: ${testCase.objective}`);
    lines.push(`- Coverage areas: ${testCase.coverageAreas.join(", ") || "none"}`);
    lines.push("", "Preconditions:");
    pushList(lines, testCase.preconditions);
    lines.push("", "Manual Xray steps to automate:");
    if (testCase.steps.length === 0) {
      lines.push("_No manual steps were supplied._");
    } else {
      testCase.steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step.action}`);
        if (step.data) {
          lines.push(`   - Data: ${step.data}`);
        }
        lines.push(`   - Expected: ${step.expectedResult}`);
      });
    }
    lines.push("", "Source evidence:");
    for (const evidence of testCase.sourceEvidence) {
      lines.push(`- ${evidence.source}: ${evidence.reference} - ${evidence.summary}`);
    }
    lines.push("", "Open questions:");
    pushList(lines, testCase.openQuestions);
    lines.push("", `Rationale: ${testCase.rationale}`, "");
  }
  lines.push("## Repository Guidance Files", "");
  for (const file of input.guidanceFiles) {
    const fence = file.path.endsWith(".json") ? "json" : "markdown";
    lines.push(`### ${file.path}`, "", `\`\`\`${fence}`, file.content.trim(), "```", "");
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

export function buildXrayTestHealingPrompt(input: BuildXrayTestHealingPromptInput): string {
  const lines: string[] = [];
  lines.push(`# Heal Generated Xray Test Implementation for ${input.issueKey}`, "");
  lines.push("You are editing the repository where this command is running. The initial generated Xray test implementation is already present, but verification failed.", "");
  lines.push("## Operating Rules", "");
  lines.push("- Fix only the generated or modified tests and directly necessary test support code.");
  lines.push("- Do not start the implementation over.");
  lines.push("- Do not broaden product code, workflow behavior, or unrelated test scope.");
  lines.push("- Preserve Xray traceability and repository conventions from the original implementation prompt.");
  lines.push("- Use the verification output below as the source of truth for this healing attempt.");
  lines.push("- When finished, summarize the exact files changed and whether you ran verification.", "");
  pushHealingContract(lines);
  lines.push("## Repository", "");
  lines.push(`- Root: ${input.repoRoot}`);
  lines.push(`- Working branch: ${input.branch}`);
  lines.push(`- Pull request target branch: ${input.targetBranch}`);
  lines.push(`- Original implementation prompt: ${input.originalPromptPath}`);
  lines.push(`- Healing attempt: ${input.attempt} of ${input.maxAttempts}`, "");
  lines.push("## Current Changed Files", "");
  pushList(lines, input.changedFiles);
  lines.push("", "## Failed Verification", "");
  lines.push(`- Command: ${input.verification.command}`);
  lines.push(`- Exit code: ${input.verification.exitCode}`);
  lines.push(`- Duration: ${input.verification.durationMs} ms`, "");
  lines.push("### stdout", "", "```text", trimForPrompt(input.verification.stdout ?? ""), "```", "");
  lines.push("### stderr", "", "```text", trimForPrompt(input.verification.stderr ?? ""), "```", "");

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function pushImplementationContract(lines: string[]): void {
  lines.push("## Implementation Contract", "");
  lines.push("- Treat implementation as test automation only, not product feature work.");
  lines.push("- Implement only the provided Xray cases; do not invent new cases or update Xray issues.");
  lines.push("- Keep changes scoped to automated tests, direct test support, and directly required test documentation.");
  lines.push("- Use repository guidance and nearby tests as authority. If they conflict with Xray or Jira, follow repository guidance and report the conflict.");
  lines.push("- Preserve Xray traceability by keeping the Xray key or manual title visible in the automated test.");
  lines.push("- Prefer existing builders, helpers, fixtures, typed models, and assertion style over new abstractions.");
  lines.push("- Implement one automated test per business scenario where practical; fold setup, cleanup, polling, and helper-only manual steps into helpers or assertions.");
  lines.push("- Do not weaken assertions to make verification pass. If runtime behavior differs from source expectations, keep the expectation visible and report or block according to repository practice.");
  lines.push("- Do not hardcode secrets, tenant-specific credentials, production URLs, or brittle timing assumptions.");
  lines.push("- Use the narrowest practical validation for the changed tests when a validation command is not explicitly supplied.", "");
}

function pushHealingContract(lines: string[]): void {
  lines.push("## Healing Contract", "");
  lines.push("- Repair only the tests, test support, or directly required test documentation changed by the implementation attempt.");
  lines.push("- Do not add new Xray scenarios, broaden product behavior, or rewrite unrelated repository code during healing.");
  lines.push("- Preserve the original Xray scope and traceability from the implementation prompt.");
  lines.push("- Do not weaken assertions only to make verification pass; keep source expectations visible and report or block according to repository practice.");
  lines.push("- Re-run or reason against the requested verification command after changes, and report the result.", "");
}

function pushList(lines: string[], values: string[]): void {
  if (values.length === 0) {
    lines.push("- None");
    return;
  }

  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function trimForPrompt(value: string, maxCharacters = 30000): string {
  if (value.length <= maxCharacters) {
    return value.trim();
  }

  return `[truncated to last ${maxCharacters} characters]\n${value.slice(-maxCharacters).trim()}`;
}
