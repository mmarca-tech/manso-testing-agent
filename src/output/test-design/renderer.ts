import type { GherkinScenario, TestDesignPack, TestScenario } from "../../domain/testDesignPack/schema.js";

/** Render the TestDesignPack as a human-readable Markdown summary. */
export function renderTestDesignMarkdown(pack: TestDesignPack): string {
  const lines: string[] = [];
  lines.push(`# Test Design — ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push(`Output mode: \`${pack.outputMode}\`  ·  Scenarios: ${pack.scenarios.length}  ·  ACs: ${pack.acceptanceCriteria.length}`, "");

  lines.push("## Strategy", "", pack.strategySummary || "_(none provided)_", "");

  lines.push("## Acceptance Criteria", "");
  if (pack.acceptanceCriteria.length === 0) {
    lines.push("_No acceptance criteria were extracted._", "");
  } else {
    for (const ac of pack.acceptanceCriteria) {
      lines.push(`- **${ac.id}**: ${ac.text}${ac.source ? ` _(source: ${ac.source})_` : ""}`);
    }
    lines.push("");
  }

  lines.push("## AC Coverage Matrix", "");
  if (pack.acCoverageMatrix.length === 0) {
    lines.push("_(no coverage matrix)_", "");
  } else {
    lines.push("| AC | Scenarios |", "| --- | --- |");
    for (const entry of pack.acCoverageMatrix) {
      const refs = entry.scenarioIndexes.length === 0
        ? "_uncovered_"
        : entry.scenarioIndexes.map((i) => formatScenarioRef(pack.scenarios[i], i)).join(", ");
      lines.push(`| ${entry.acId} | ${refs} |`);
    }
    lines.push("");
  }

  if (pack.acsCoveredByExisting && pack.acsCoveredByExisting.length > 0) {
    lines.push("## Covered by existing tests", "");
    lines.push(
      "These acceptance criteria are already covered by existing repository scenarios, so no new scenario was authored:",
    );
    for (const acId of pack.acsCoveredByExisting) {
      lines.push(`- ${acId}`);
    }
    lines.push("");
  }

  if (pack.derivedRequirements && pack.derivedRequirements.length > 0) {
    lines.push("## Derived Requirements", "");
    lines.push(
      "Behaviours inferred from the full context that the literal acceptance criteria do not state (M22). Additional coverage targets — review and reject any that are not warranted.",
      "",
    );
    for (const dr of pack.derivedRequirements) {
      lines.push(`- **${dr.id}** [${dr.category}, ${dr.risk} risk]: ${dr.text}`);
    }
    lines.push("");
  }

  lines.push("## Risk Ranking", "");
  if (pack.riskRanking.length === 0) {
    lines.push("_(no scenarios)_", "");
  } else {
    for (const entry of pack.riskRanking) {
      const refs = entry.scenarioIndexes.map((i) => formatScenarioRef(pack.scenarios[i], i)).join(", ");
      lines.push(`- **${entry.level}**: ${refs}`);
    }
    lines.push("");
  }

  if (pack.riskCoverageMatrix && pack.riskCoverageMatrix.length > 0) {
    lines.push("## Risk / Edge Coverage", "");
    lines.push("| Target | Kind | Risk | Negative/boundary | Satisfied |", "| --- | --- | --- | --- | --- |");
    for (const entry of pack.riskCoverageMatrix) {
      const negRefs =
        entry.negativeOrBoundaryScenarioIndexes.length === 0
          ? "_none_"
          : entry.negativeOrBoundaryScenarioIndexes.map((i) => formatScenarioRef(pack.scenarios[i], i)).join(", ");
      lines.push(`| ${entry.targetId} | ${entry.targetKind} | ${entry.risk} | ${negRefs} | ${entry.satisfied ? "✅" : "⚠️"} |`);
    }
    lines.push("");
  }

  if (pack.coverageGaps.length > 0) {
    lines.push("## Coverage Gaps", "");
    for (const gap of pack.coverageGaps) lines.push(`- ${gap}`);
    lines.push("");
  }

  if (pack.openQuestions.length > 0) {
    lines.push("## Open Questions", "");
    for (const question of pack.openQuestions) lines.push(`- ${question}`);
    lines.push("");
  }

  lines.push("## Scenarios", "");
  if (pack.scenarios.length === 0) {
    lines.push("_No scenarios were authored._", "");
  } else {
    pack.scenarios.forEach((scenario, index) => {
      lines.push(`### #${index + 1} — ${scenario.title}`, "");
      lines.push(
        `Feature: ${scenario.feature}  ·  Risk: ${scenario.risk}  ·  Readiness: ${scenario.readiness}`,
      );
      lines.push(`Tags: ${scenario.tags.join(" ") || "_(none)_"}`);
      lines.push(`AC ids: ${scenario.acIds.join(", ") || "_(none)_"}  ·  Polarity: ${scenario.polarity ?? "positive"}`);
      if (scenario.drIds && scenario.drIds.length > 0) {
        lines.push(`Derived requirements: ${scenario.drIds.join(", ")}`);
      }
      lines.push("");
      lines.push(`Objective: ${scenario.objective}`);
      if (scenario.preconditions.length > 0) {
        lines.push("", "Preconditions:");
        for (const pre of scenario.preconditions) lines.push(`  - ${pre}`);
      }
      lines.push("", "Steps:");
      if (scenario.kind === "gherkin") {
        for (const step of scenario.steps) {
          lines.push(`  ${step.keyword} ${step.text}`);
          for (const row of step.dataTable ?? []) lines.push(`    | ${row.join(" | ")} |`);
        }
        if (scenario.examples) {
          lines.push("", "Examples:");
          lines.push(`  | ${scenario.examples.headers.join(" | ")} |`);
          for (const row of scenario.examples.rows) {
            lines.push(`  | ${row.join(" | ")} |`);
          }
        }
      } else {
        scenario.steps.forEach((step, stepIndex) => {
          lines.push(`  ${stepIndex + 1}. ${step.action}`);
          lines.push(`     → Expected: ${step.expectedResult}`);
        });
      }
      if (scenario.sourceEvidence.length > 0) {
        lines.push("", "Source evidence:");
        for (const evidence of scenario.sourceEvidence) {
          lines.push(`  - ${evidence.source} (${evidence.reference}): ${evidence.summary}`);
        }
      }
      if (scenario.openQuestions.length > 0) {
        lines.push("", "Open questions:");
        for (const question of scenario.openQuestions) lines.push(`  - ${question}`);
      }
      if (scenario.rationale) {
        lines.push("", `Rationale: ${scenario.rationale}`);
      }
      lines.push("");
    });
  }

  if (pack.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of pack.warnings) {
      lines.push(`- ${warning.section}${warning.toolName ? `/${warning.toolName}` : ""}: ${warning.message}`);
    }
    lines.push("");
  }

  lines.push("## Provenance", "");
  lines.push(`Generated: ${pack.provenance.generatedAt}`);
  lines.push(`LLM: ${pack.provenance.llm.provider}/${pack.provenance.llm.model}`);
  if (pack.provenance.tools.length === 0) {
    lines.push("_(no tool calls recorded)_");
  } else {
    for (const tool of pack.provenance.tools) {
      lines.push(`- ${tool.calledAt} ${tool.method} via ${tool.toolName}: ${tool.success ? "success" : `failed (${tool.message ?? "unknown"})`}`);
    }
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function formatScenarioRef(scenario: TestScenario | undefined, index: number): string {
  if (!scenario) return `#${index + 1}`;
  return `#${index + 1} (${scenario.title})`;
}

/**
 * Render a single `.feature` file containing the Gherkin scenarios for one
 * feature. Non-gherkin (plain-English) scenarios are ignored — they are
 * rendered as manual test cases elsewhere. Output is valid Gherkin and
 * round-trips through the standard parsers.
 */
export function renderFeatureFile(input: {
  ticketKey: string;
  feature: string;
  scenarios: TestScenario[];
}): string {
  const gherkinScenarios = input.scenarios.filter(
    (scenario): scenario is GherkinScenario => scenario.kind === "gherkin",
  );
  const lines: string[] = [];
  lines.push(`@${input.ticketKey}`);
  lines.push(`Feature: ${input.feature}`, "");

  gherkinScenarios.forEach((scenario) => {
    if (scenario.tags.length > 0) {
      lines.push(`  ${scenario.tags.join(" ")}`);
    }
    const opening = scenario.examples ? "Scenario Outline" : "Scenario";
    lines.push(`  ${opening}: ${scenario.title}`);
    for (const step of scenario.steps) {
      lines.push(`    ${step.keyword} ${step.text}`);
      for (const row of step.dataTable ?? []) {
        lines.push(`      | ${row.join(" | ")} |`);
      }
    }
    if (scenario.examples) {
      lines.push("");
      lines.push("    Examples:");
      lines.push(`      | ${scenario.examples.headers.join(" | ")} |`);
      for (const row of scenario.examples.rows) {
        lines.push(`      | ${row.join(" | ")} |`);
      }
    }
    lines.push("");
  });

  return `${lines.join("\n").trim()}\n`;
}

/**
 * Render the plain-English (manual) test cases as a Markdown document with a
 * step/expected-result table per case. Gherkin scenarios are ignored — they go
 * to `.feature` files.
 */
export function renderManualTests(input: {
  ticketKey: string;
  scenarios: TestScenario[];
}): string {
  const manual = input.scenarios.filter((scenario) => scenario.kind === "plain-english");
  const lines: string[] = [];
  lines.push(`# Manual test cases — ${input.ticketKey}`, "");
  if (manual.length === 0) {
    return `${lines.join("\n")}\n_No manual test cases._\n`;
  }

  manual.forEach((scenario, index) => {
    if (scenario.kind !== "plain-english") return;
    lines.push(`## ${index + 1}. ${scenario.title}`, "");
    lines.push(`Tags: ${scenario.tags.join(" ") || "_(none)_"}  ·  Risk: ${scenario.risk}  ·  AC ids: ${scenario.acIds.join(", ") || "_(none)_"}`, "");
    lines.push(`**Objective:** ${scenario.objective}`, "");
    if (scenario.preconditions.length > 0) {
      lines.push("**Preconditions:**");
      for (const pre of scenario.preconditions) lines.push(`- ${pre}`);
      lines.push("");
    }
    lines.push("| # | Action | Expected result |", "| --- | --- | --- |");
    scenario.steps.forEach((step, stepIndex) => {
      lines.push(`| ${stepIndex + 1} | ${escapeCell(step.action)} | ${escapeCell(step.expectedResult)} |`);
    });
    lines.push("");
  });

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Slugify a feature name into a filesystem-safe `.feature` filename stem. */
export function featureFileSlug(feature: string): string {
  return feature
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "feature";
}
