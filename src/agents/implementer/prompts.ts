import type { CommandResult } from "../../domain/implementationPack/schema.js";
import type { TestDesignPack } from "../../domain/testDesignPack/schema.js";
import type { StackConfig } from "../../config/agentConfig.js";
import type { Skill } from "../../skillLoader/types.js";
import { describeMcpServers, type McpServers } from "../../integrations/mcp/config.js";

export type { RepoGuidanceFile } from "../../context/repoGuidance.js";
import type { RepoGuidanceFile } from "../../context/repoGuidance.js";

export interface BuildImplementationPromptInput {
  testDesign: TestDesignPack;
  repoRoot: string;
  stack: StackConfig;
  bindingSkill: Skill;
  /** Optional `.agents/` guidance files (test-architecture, test-conventions, ...). */
  guidanceFiles: RepoGuidanceFile[];
  /** Per-scenario `.feature` file paths the writer produced. */
  featurePaths: string[];
  /** MCP servers available to the agent this run (M11). */
  mcpServers?: McpServers;
  /** Live exploration brief (real DOM locators / API endpoints) from M20. */
  explorationBrief?: string;
}

const OPERATING_RULES = `## Operating rules

- This is a **test implementation** task, not a product change. Edit only
  test code, test support files, and (rarely) directly necessary test
  documentation. Do not modify product code.
- The \`.feature\` files listed below are the source of truth. Do not
  edit them — bind step definitions to the steps that are already there.
- Reuse the repository's existing helpers, fixtures, factories, page
  objects, and conventions. Do not invent parallel abstractions.
- Run the configured verify command when changes are complete and report
  the result. Do not weaken assertions, mark scenarios skipped, or disable
  retries to make verification pass.
- Preserve traceability: the \`@story-<KEY>\` and \`@AC-<n>\` tags on
  scenarios must stay intact.
- Do not hardcode tenant ids, account ids, secrets, or production URLs.
- When you finish, summarise the files you changed, the scenarios you
  implemented, the scenarios you skipped (with reasons), and the verify
  command result.
`;

/**
 * Build the implementation prompt sent to the code agent.
 *
 * Composition (top to bottom):
 *   1. Goal + repo identity
 *   2. Stack + verify command
 *   3. Operating rules
 *   4. Binding skill body (stack-specific contract)
 *   5. `.agents/` guidance files (repo conventions)
 *   6. Scenarios — full Gherkin + tags + risk + AC ids + .feature paths
 */
export function buildImplementationPrompt(input: BuildImplementationPromptInput): string {
  const ticketKey = input.testDesign.ticket.key;
  const lines: string[] = [];

  lines.push(`# Implement Gherkin tests for ${ticketKey}`, "");
  lines.push(
    `You are editing the repository at \`${input.repoRoot}\`. Implement automated`,
    `tests for the Gherkin scenarios below using the binding skill and repo`,
    `conventions provided. The .feature files have already been written by`,
    `Manso's design phase and are the source of truth — do not edit them.`,
    "",
  );

  lines.push("## Repository");
  lines.push(`- Root: ${input.repoRoot}`);
  lines.push(`- Stack: ${input.stack.id}`);
  lines.push(`- Stack root: ${input.stack.root}`);
  lines.push(`- Verify command: ${input.stack.verifyCommand}`);
  if (input.stack.featureGlob) {
    lines.push(`- Feature glob: ${input.stack.featureGlob}`);
  }
  lines.push("");

  lines.push(OPERATING_RULES);

  lines.push(`## Binding skill: ${input.bindingSkill.name}`, "");
  lines.push(input.bindingSkill.body.trim(), "");

  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    lines.push("## Available MCP tools", "");
    lines.push(
      "These MCP servers are connected for this run. Use their tools when they help",
      "you author more accurate tests — e.g. explore the live app for real",
      "role/test-id selectors, or read a design spec — instead of guessing:",
      "",
    );
    lines.push(...describeMcpServers(input.mcpServers), "");
  }

  if (input.guidanceFiles.length > 0) {
    lines.push("## Repository conventions", "");
    for (const file of input.guidanceFiles) {
      const fence = file.path.endsWith(".json") ? "json" : "markdown";
      lines.push(`### ${file.path}`, "", `\`\`\`${fence}`, file.content.trim(), "```", "");
    }
  }

  if (input.explorationBrief && input.explorationBrief.trim().length > 0) {
    lines.push("## Live environment exploration", "");
    lines.push(
      "The running app/API was explored before this task. Use the REAL locators,",
      "endpoints, and observed states below — do not invent selectors or paths:",
      "",
    );
    lines.push(input.explorationBrief.trim(), "");
  }

  lines.push("## Scenarios to implement", "");
  lines.push(`Total: ${input.testDesign.scenarios.length}`);
  if (input.featurePaths.length > 0) {
    lines.push("Feature files (already written):");
    for (const path of input.featurePaths) {
      lines.push(`- ${path}`);
    }
  }
  lines.push("");

  input.testDesign.scenarios.forEach((scenario, index) => {
    lines.push(`### Scenario ${index + 1} — ${scenario.title}`);
    lines.push(`- Feature: ${scenario.feature}`);
    lines.push(`- AC ids: ${scenario.acIds.join(", ") || "(none)"}`);
    lines.push(`- Risk: ${scenario.risk}`);
    lines.push(`- Readiness: ${scenario.readiness}`);
    lines.push(`- Tags: ${scenario.tags.join(" ") || "(none)"}`);
    lines.push("");
    lines.push(`Objective: ${scenario.objective}`);
    if (scenario.preconditions.length > 0) {
      lines.push("Preconditions:");
      for (const pre of scenario.preconditions) lines.push(`- ${pre}`);
    }
    if (scenario.kind === "gherkin") {
      lines.push("", "Gherkin:");
      lines.push("```gherkin");
      if (scenario.tags.length > 0) lines.push(scenario.tags.join(" "));
      const opening = scenario.examples ? "Scenario Outline" : "Scenario";
      lines.push(`${opening}: ${scenario.title}`);
      for (const step of scenario.steps) {
        lines.push(`  ${step.keyword} ${step.text}`);
        for (const row of step.dataTable ?? []) {
          lines.push(`    | ${row.join(" | ")} |`);
        }
      }
      if (scenario.examples) {
        lines.push("Examples:");
        lines.push(`  | ${scenario.examples.headers.join(" | ")} |`);
        for (const row of scenario.examples.rows) {
          lines.push(`  | ${row.join(" | ")} |`);
        }
      }
      lines.push("```");
    } else {
      // Plain-English (manual) case: render action/expected steps. These are
      // typically not auto-implemented, but are included for full context.
      lines.push("", "Manual steps:");
      scenario.steps.forEach((step, stepIndex) => {
        lines.push(`${stepIndex + 1}. ${step.action} → Expected: ${step.expectedResult}`);
      });
    }
    if (scenario.openQuestions.length > 0) {
      lines.push("", "Open questions:");
      for (const question of scenario.openQuestions) lines.push(`- ${question}`);
    }
    lines.push("");
  });

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

const HEALING_OPERATING_RULES = `## Healing operating rules

- The initial implementation is already on disk. **Repair only** the failing
  tests, the test support code they depend on, and (rarely) directly required
  test documentation. Do not start the implementation over.
- Do not broaden product behaviour, change unrelated repository code, or
  rewrite the design.
- Preserve traceability: keep the \`@story-<KEY>\` and \`@AC-<n>\` tags intact
  on every scenario.
- Use the verification output below as the source of truth for what is
  failing. Read it carefully before changing anything.
- Do not weaken assertions, mark scenarios skipped, or disable retries to
  make verification pass. If runtime behaviour genuinely differs from what
  the scenarios expect, keep the expectation visible and surface the
  conflict in your reply.
- When you finish, re-run the verify command and report the result in plain
  language alongside the files you changed.
`;

export interface BuildHealingPromptInput {
  issueKey: string;
  repoRoot: string;
  attempt: number;
  maxAttempts: number;
  /** The verification result that triggered this healing attempt. */
  verification: CommandResult;
  /** Files the previous attempt modified, repo-relative. */
  changedFiles: string[];
  /** Original implementation prompt path, when written to disk. */
  originalPromptPath?: string;
}

/**
 * Build the prompt sent to the code agent when a verification run fails after
 * an implementation attempt. The prompt is intentionally narrow — it tells the
 * agent to repair the failing tests scoped to the changes that were already
 * made, not to redo the whole implementation.
 */
export function buildHealingPrompt(input: BuildHealingPromptInput): string {
  const lines: string[] = [];
  lines.push(`# Heal generated tests for ${input.issueKey}`, "");
  lines.push(
    `The implementation already ran in this repository (at \`${input.repoRoot}\`),`,
    `but verification failed. Repair only the failing tests using the contract`,
    `below — do not start over.`,
    "",
  );
  lines.push(HEALING_OPERATING_RULES);
  lines.push("## Repository", "");
  lines.push(`- Root: ${input.repoRoot}`);
  lines.push(`- Healing attempt: ${input.attempt} of ${input.maxAttempts}`);
  if (input.originalPromptPath) {
    lines.push(`- Original implementation prompt: ${input.originalPromptPath}`);
  }
  lines.push("");

  lines.push("## Files changed by the previous attempt", "");
  if (input.changedFiles.length === 0) {
    lines.push("_(none detected — verify against the design pack scenarios)_");
  } else {
    for (const file of input.changedFiles) lines.push(`- ${file}`);
  }
  lines.push("");

  lines.push("## Failed verification", "");
  lines.push(`- Command: \`${input.verification.command}\``);
  lines.push(`- Exit code: ${input.verification.exitCode}`);
  lines.push(`- Duration: ${input.verification.durationMs} ms`, "");
  if (input.verification.stdout) {
    lines.push("### stdout (truncated)", "", "```text", truncate(input.verification.stdout, 30000), "```", "");
  }
  if (input.verification.stderr) {
    lines.push("### stderr (truncated)", "", "```text", truncate(input.verification.stderr, 30000), "```", "");
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `[truncated to last ${max} chars]\n${value.slice(-max)}`;
}
