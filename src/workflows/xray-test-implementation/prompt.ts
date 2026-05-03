import type { XrayTestGenerationPack } from "../../domain/xrayTestGeneration/schema.js";

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

function pushList(lines: string[], values: string[]): void {
  if (values.length === 0) {
    lines.push("- None");
    return;
  }

  for (const value of values) {
    lines.push(`- ${value}`);
  }
}
